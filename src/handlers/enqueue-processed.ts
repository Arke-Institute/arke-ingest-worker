/**
 * POST /api/batches/:batchId/enqueue-processed
 * Called by Cloud Run preprocessor after completing file transformations
 * Updates batch with processed files and enqueues to BATCH_QUEUE
 */

import type { Context } from 'hono';
import type {
  Env,
  EnqueueProcessedRequest,
  EnqueueProcessedResponse,
  QueueMessage,
  DirectoryGroup,
  BatchManifest,
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

    // Group files by directory
    const directoriesMap = new Map<string, DirectoryGroup>();

    for (const file of updatedState.files) {
      // Extract directory from logical_path
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

    // Sort directories alphabetically for deterministic ordering
    const directories = Array.from(directoriesMap.values())
      .sort((a, b) => a.directory_path.localeCompare(b.directory_path));

    // Create manifest object to store in R2
    const manifest: BatchManifest = {
      batch_id: batchId,
      directories: directories,
      total_files: updatedState.files.length,
      total_bytes: totalBytes,
    };

    // Store manifest in R2 (overwrites preprocessing manifest with processed version)
    const manifestKey = `staging/${batchId}/_manifest.json`;
    await c.env.STAGING_BUCKET.put(
      manifestKey,
      JSON.stringify(manifest, null, 2),
      {
        httpMetadata: {
          contentType: 'application/json',
        },
      }
    );

    // Build minimal queue message with manifest reference
    const queueMessage: QueueMessage = {
      batch_id: batchId,
      manifest_r2_key: manifestKey,
      r2_prefix: `staging/${batchId}/`,
      uploader: updatedState.uploader,
      root_path: updatedState.root_path,
      parent_pi: updatedState.parent_pi,
      total_files: updatedState.files.length,
      total_bytes: totalBytes,
      uploaded_at: updatedState.created_at,
      finalized_at: new Date().toISOString(),
      metadata: updatedState.metadata,
    };

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
