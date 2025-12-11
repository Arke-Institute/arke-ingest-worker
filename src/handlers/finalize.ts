/**
 * POST /api/batches/:batchId/finalize
 * Finalize batch and run Initial Discovery to create entities
 *
 * For small batches (< SYNC_DISCOVERY_MAX_DIRS), discovery runs synchronously
 * and root_pi is returned immediately in the response.
 *
 * For large batches, discovery runs asynchronously via DO alarms and
 * clients poll /status to get root_pi when ready.
 */

import type { Context } from 'hono';
import type {
  Env,
  FinalizeBatchResponse,
  QueueMessage,
  DirectoryGroup,
  BatchManifest,
} from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';
import { runSyncDiscovery } from '../services/initial-discovery';

// Discovery configuration
// Use async discovery if either threshold is exceeded
const SYNC_DISCOVERY_MAX_DIRS = 50; // Run sync if fewer directories
const SYNC_DISCOVERY_MAX_TEXT_FILES = 100; // Run sync if fewer text files to upload

// Text file extensions that get uploaded to IPFS during discovery
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'xml', 'csv', 'html', 'htm']);

export async function handleFinalizeBatch(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');

    // Load batch state from Durable Object
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    const state = await stub.getState();
    if (!state) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    // Handle idempotent responses for already-processed batches
    if (state.status === 'enqueued' || state.status === 'preprocessing') {
      const response: FinalizeBatchResponse = {
        batch_id: batchId,
        status: state.status,
        files_uploaded: state.files.length,
        total_bytes: state.files.reduce((sum: number, f: any) => sum + f.file_size, 0),
        r2_prefix: `staging/${batchId}/`,
        root_pi: state.root_pi,
      };
      return c.json(response, 200);
    }

    if (state.status === 'discovery') {
      // Discovery in progress - return progress
      const response: FinalizeBatchResponse = {
        batch_id: batchId,
        status: 'discovery',
        files_uploaded: state.files.length,
        total_bytes: state.files.reduce((sum: number, f: any) => sum + f.file_size, 0),
        r2_prefix: `staging/${batchId}/`,
        discovery_progress: state.discovery_state
          ? {
              total: state.discovery_state.directories_total,
              published: state.discovery_state.directories_published,
            }
          : undefined,
      };
      return c.json(response, 200);
    }

    if (state.status !== 'uploading') {
      return c.json(
        {
          error: `Batch status is ${state.status}, cannot finalize`,
        },
        400
      );
    }

    // Verify all files are completed
    const incompleteFiles = state.files.filter((f: any) => f.status !== 'completed');
    if (incompleteFiles.length > 0) {
      return c.json(
        {
          error: 'Not all files completed',
          incomplete: incompleteFiles.map((f: any) => f.file_name),
        },
        400
      );
    }

    if (state.files.length === 0) {
      return c.json({ error: 'No files uploaded in this batch' }, 400);
    }

    // Calculate total bytes
    const totalBytes = state.files.reduce((sum: number, f: any) => sum + f.file_size, 0);

    // Group files by directory
    const directoriesMap = new Map<string, DirectoryGroup>();

    for (const file of state.files) {
      // Extract directory from logical_path
      const lastSlash = file.logical_path.lastIndexOf('/');
      const directoryPath = lastSlash > 0 ? file.logical_path.substring(0, lastSlash) : '/';

      if (!directoriesMap.has(directoryPath)) {
        directoriesMap.set(directoryPath, {
          directory_path: directoryPath,
          processing_config: file.processing_config, // Use first file's config
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
    const directories = Array.from(directoriesMap.values()).sort((a, b) =>
      a.directory_path.localeCompare(b.directory_path)
    );

    // Create manifest object to store in R2
    const manifest: BatchManifest = {
      batch_id: batchId,
      directories: directories,
      total_files: state.files.length,
      total_bytes: totalBytes,
    };

    // Store manifest in R2
    const manifestKey = `staging/${batchId}/_manifest.json`;
    await c.env.STAGING_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2), {
      httpMetadata: {
        contentType: 'application/json',
      },
    });

    // Count text files that will be uploaded to IPFS
    const textFileCount = state.files.filter((f: any) => {
      const ext = f.file_name.split('.').pop()?.toLowerCase() || '';
      return TEXT_EXTENSIONS.has(ext);
    }).length;

    // Decide sync vs async based on directory count AND text file count
    const dirCount = directories.length;
    const useAsyncDiscovery =
      dirCount >= SYNC_DISCOVERY_MAX_DIRS ||
      textFileCount >= SYNC_DISCOVERY_MAX_TEXT_FILES;

    console.log(
      `[Finalize] ${dirCount} directories, ${textFileCount} text files, using ${useAsyncDiscovery ? 'async' : 'sync'} discovery`
    );

    if (useAsyncDiscovery) {
      // ================================================================
      // ASYNC PATH: Start discovery via alarms, return immediately
      // ================================================================
      await stub.startDiscovery(manifest, state.parent_pi);

      const response: FinalizeBatchResponse = {
        batch_id: batchId,
        status: 'discovery',
        files_uploaded: state.files.length,
        total_bytes: totalBytes,
        r2_prefix: `staging/${batchId}/`,
        discovery_progress: {
          total: dirCount,
          published: 0,
        },
      };

      return c.json(response, 200);
    } else {
      // ================================================================
      // SYNC PATH: Run discovery inline, return root_pi immediately
      // ================================================================
      let discoveryResult = null;
      try {
        discoveryResult = await runSyncDiscovery(manifest, c.env, state.parent_pi);
        await stub.setDiscoveryResults(discoveryResult);
        console.log(`[Finalize] Sync discovery complete, root_pi: ${discoveryResult.root_pi}`);
      } catch (error) {
        console.error('[Finalize] Sync discovery failed:', error);
        // Continue without discovery - preprocessor/orchestrator will handle it
      }

      // Construct queue message with discovery results
      const queueMessage: QueueMessage = {
        batch_id: batchId,
        manifest_r2_key: manifestKey,
        r2_prefix: `staging/${batchId}/`,
        uploader: state.uploader,
        root_path: state.root_path,
        parent_pi: state.parent_pi,
        total_files: state.files.length,
        total_bytes: totalBytes,
        uploaded_at: state.created_at,
        finalized_at: new Date().toISOString(),
        metadata: state.metadata,
        custom_prompts: state.custom_prompts,

        // Discovery results (if available)
        root_pi: discoveryResult?.root_pi,
        node_pis: discoveryResult?.node_pis,
        node_tips: discoveryResult?.node_tips,
        node_versions: discoveryResult?.node_versions,
      };

      // Log queue message for debugging
      console.log(
        'Sending to PREPROCESS_QUEUE:',
        JSON.stringify(
          {
            batch_id: batchId,
            has_custom_prompts: !!state.custom_prompts,
            has_discovery: !!discoveryResult,
            root_pi: discoveryResult?.root_pi,
          },
          null,
          2
        )
      );

      // Enqueue to preprocessor
      await c.env.PREPROCESS_QUEUE.send(queueMessage);

      // Update batch state to preprocessing
      await stub.updateStatus('preprocessing', new Date().toISOString());

      // Return response with root_pi
      const response: FinalizeBatchResponse = {
        batch_id: batchId,
        root_pi: discoveryResult?.root_pi,
        status: 'preprocessing',
        files_uploaded: state.files.length,
        total_bytes: totalBytes,
        r2_prefix: `staging/${batchId}/`,
      };

      return c.json(response, 200);
    }
  } catch (error) {
    console.error('Error finalizing batch:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
