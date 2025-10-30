/**
 * POST /api/batches/:batchId/finalize
 * Finalize batch and enqueue for processing
 */

import type { Context } from 'hono';
import type { Env, FinalizeBatchResponse, QueueMessage, DirectoryGroup } from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';

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

    if (state.status === 'enqueued') {
      // Already enqueued - idempotent response
      const response: FinalizeBatchResponse = {
        batch_id: batchId,
        status: 'enqueued',
        files_uploaded: state.files.length,
        total_bytes: state.files.reduce((sum: number, f: any) => sum + f.file_size, 0),
        r2_prefix: `staging/${batchId}/`,
      };
      return c.json(response, 200);
    }

    if (state.status !== 'uploading') {
      return c.json({
        error: `Batch status is ${state.status}, cannot finalize`,
      }, 400);
    }

    // Verify all files are completed
    const incompleteFiles = state.files.filter((f: any) => f.status !== 'completed');
    if (incompleteFiles.length > 0) {
      return c.json({
        error: 'Not all files completed',
        incomplete: incompleteFiles.map((f: any) => f.file_name),
      }, 400);
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
    const directories = Array.from(directoriesMap.values())
      .sort((a, b) => a.directory_path.localeCompare(b.directory_path));

    // Construct queue message with directory-grouped format
    const queueMessage: QueueMessage = {
      batch_id: batchId,
      r2_prefix: `staging/${batchId}/`,
      uploader: state.uploader,
      root_path: state.root_path,
      parent_pi: state.parent_pi,
      total_files: state.files.length,
      total_bytes: totalBytes,
      uploaded_at: state.created_at,
      finalized_at: new Date().toISOString(),
      metadata: state.metadata,
      directories: directories,
    };

    // Enqueue batch job
    await c.env.BATCH_QUEUE.send(queueMessage);

    // Update batch state atomically
    await stub.updateStatus('enqueued', new Date().toISOString());

    // Return response
    const response: FinalizeBatchResponse = {
      batch_id: batchId,
      status: 'enqueued',
      files_uploaded: state.files.length,
      total_bytes: totalBytes,
      r2_prefix: `staging/${batchId}/`,
    };

    return c.json(response, 200);
  } catch (error) {
    console.error('Error finalizing batch:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
