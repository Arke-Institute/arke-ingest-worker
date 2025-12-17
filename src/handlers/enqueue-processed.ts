/**
 * POST /api/batches/:batchId/enqueue-processed
 * Called by Cloud Run preprocessor after completing file transformations
 * Updates batch with processed files and enqueues to BATCH_QUEUE
 *
 * NEW: Builds PI tree for simplified orchestrator architecture
 */

import type { Context } from 'hono';
import type {
  Env,
  EnqueueProcessedRequest,
  EnqueueProcessedResponse,
  QueueMessage,
  PINode,
  DirectoryGroup,
  BatchManifest,
  ProcessingConfig,
} from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';

export async function handleEnqueueProcessed(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');
    const body = await c.req.json<EnqueueProcessedRequest>();

    // Validate request
    if (!body.files || !Array.isArray(body.files)) {
      return c.json({ error: 'Missing or invalid files array' }, 400);
    }

    if (body.files.length === 0) {
      return c.json({ error: 'Files array cannot be empty' }, 400);
    }

    if (!body.root_pi || !body.node_pis) {
      return c.json({ error: 'Missing entity tracking data (root_pi, node_pis)' }, 400);
    }

    // Get batch state
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    const state = await stub.getState();

    if (!state) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    if (state.status !== 'preprocessing') {
      return c.json({
        error: `Invalid batch state: ${state.status}, expected preprocessing`,
      }, 400);
    }

    // Replace entire file list with processed files (atomic operation)
    await stub.replaceFiles(body.files);

    // Reload state to get updated files
    const updatedState = await stub.getState();
    if (!updatedState) {
      throw new Error('Failed to reload batch state after update');
    }

    // Calculate total bytes from new file list
    const totalBytes = updatedState.files.reduce(
      (sum: number, f: any) => sum + f.file_size,
      0
    );

    // Group files by directory to get processing config per directory
    const directoriesMap = new Map<string, DirectoryGroup>();

    for (const file of updatedState.files) {
      const lastSlash = file.logical_path.lastIndexOf('/');
      const directoryPath = lastSlash > 0
        ? file.logical_path.substring(0, lastSlash)
        : '/';

      if (!directoriesMap.has(directoryPath)) {
        directoriesMap.set(directoryPath, {
          directory_path: directoryPath,
          processing_config: file.processing_config,
          file_count: 0,
          total_bytes: 0,
          files: [],
        });
      }

      const dir = directoriesMap.get(directoryPath)!;
      dir.file_count++;
      dir.total_bytes += file.file_size;
      dir.files.push({
        r2_key: file.r2_key,
        logical_path: file.logical_path,
        file_name: file.file_name,
        file_size: file.file_size,
        content_type: file.content_type,
        ...(file.cid && { cid: file.cid }),
      });
    }

    const directories = Array.from(directoriesMap.values())
      .sort((a, b) => a.directory_path.localeCompare(b.directory_path));

    // Store manifest in R2 (for reference/debugging)
    const manifest: BatchManifest = {
      batch_id: batchId,
      directories: directories,
      total_files: updatedState.files.length,
      total_bytes: totalBytes,
    };

    const manifestKey = `staging/${batchId}/_manifest.json`;
    await c.env.STAGING_BUCKET.put(
      manifestKey,
      JSON.stringify(manifest, null, 2),
      { httpMetadata: { contentType: 'application/json' } }
    );

    // Build PI tree from discovery state
    const pis = buildPITree(
      body.node_pis,
      body.root_pi,
      directoriesMap,
      updatedState.discovery_state
    );

    // Build simplified queue message for orchestrator
    const queueMessage: QueueMessage = {
      batch_id: batchId,
      root_pi: body.root_pi,
      pis,
      parent_pi: updatedState.parent_pi,
      custom_prompts: updatedState.custom_prompts,
    };

    // Log queue message for debugging
    console.log('Sending to BATCH_QUEUE:', JSON.stringify({
      batch_id: batchId,
      root_pi: body.root_pi,
      pi_count: pis.length,
      has_custom_prompts: !!updatedState.custom_prompts,
    }, null, 2));

    // Send to batch queue
    await c.env.BATCH_QUEUE.send(queueMessage);

    // Update batch status to enqueued
    await stub.updateStatus('enqueued', new Date().toISOString());

    // Return success response
    const response: EnqueueProcessedResponse = {
      success: true,
      batch_id: batchId,
      status: 'enqueued',
      total_files: updatedState.files.length,
    };

    return c.json(response, 200);

  } catch (error) {
    console.error('Error enqueuing processed batch:', error);
    return c.json({
      error: 'Internal server error',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500);
  }
}

/**
 * Build PI tree from discovery state
 * Converts path-based node tracking to PI-based tree structure
 */
function buildPITree(
  nodePis: Record<string, string>,
  _rootPi: string,
  directoriesMap: Map<string, DirectoryGroup>,
  discoveryState?: any
): PINode[] {
  const pis: PINode[] = [];

  // Build path -> children map from discovery state or infer from paths
  const pathChildren: Record<string, string[]> = {};

  if (discoveryState?.nodes) {
    // Use discovery state nodes for accurate parent/child relationships
    for (const [path, node] of Object.entries(discoveryState.nodes as Record<string, any>)) {
      pathChildren[path] = node.children_paths || [];
    }
  } else {
    // Infer relationships from paths
    const allPaths = Object.keys(nodePis).sort();
    for (const path of allPaths) {
      pathChildren[path] = [];
    }
    for (const path of allPaths) {
      // Find parent path
      const lastSlash = path.lastIndexOf('/');
      if (lastSlash > 0) {
        const parentPath = path.substring(0, lastSlash);
        if (pathChildren[parentPath]) {
          pathChildren[parentPath].push(path);
        }
      }
    }
  }

  // Build PINode for each PI
  for (const [path, pi] of Object.entries(nodePis)) {
    // Get processing config from directory files
    const dir = directoriesMap.get(path);
    const config: ProcessingConfig = dir?.processing_config || {
      ocr: true,
      pinax: true,
      cheimarros: true,
      describe: true,
    };

    // Find parent PI
    let parentPi: string | undefined;
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash > 0) {
      const parentPath = path.substring(0, lastSlash);
      parentPi = nodePis[parentPath];
    }

    // Get children PIs
    const childrenPaths = pathChildren[path] || [];
    const childrenPi = childrenPaths
      .map(childPath => nodePis[childPath])
      .filter((pi): pi is string => !!pi);

    pis.push({
      pi,
      parent_pi: parentPi,
      children_pi: childrenPi,
      processing_config: config,
    });
  }

  return pis;
}
