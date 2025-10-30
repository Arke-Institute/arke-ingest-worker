/**
 * POST /api/batches/:batchId/finalize
 * Finalize batch and enqueue for processing
 */

import type { Context } from 'hono';
import type { Env, FinalizeBatchResponse, QueueMessage } from '../types';
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
        total_bytes: state.files.reduce((sum, f) => sum + f.file_size, 0),
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
    const incompleteFiles = state.files.filter((f) => f.status !== 'completed');
    if (incompleteFiles.length > 0) {
      return c.json({
        error: 'Not all files completed',
        incomplete: incompleteFiles.map((f) => f.file_name),
      }, 400);
    }

    if (state.files.length === 0) {
      return c.json({ error: 'No files uploaded in this batch' }, 400);
    }

    // Calculate total bytes
    const totalBytes = state.files.reduce((sum, f) => sum + f.file_size, 0);

    // Construct queue message
    const queueMessage: QueueMessage = {
      batch_id: batchId,
      r2_prefix: `staging/${batchId}/`,
      uploader: state.uploader,
      root_path: state.root_path,
      file_count: state.files.length,
      total_bytes: totalBytes,
      uploaded_at: state.created_at,
      finalized_at: new Date().toISOString(),
      metadata: state.metadata,
      files: state.files.map((f) => ({
        r2_key: f.r2_key,
        logical_path: f.logical_path,
        file_name: f.file_name,
        file_size: f.file_size,
        ...(f.cid && { cid: f.cid }),
      })),
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
