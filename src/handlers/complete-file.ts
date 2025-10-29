/**
 * POST /api/batches/:batchId/files/complete
 * Mark a file upload as complete
 */

import type { Context } from 'hono';
import type {
  Env,
  CompleteFileUploadRequest,
  CompleteFileUploadResponse,
} from '../types';
import { loadBatchState, saveBatchState } from '../lib/batch-state';

export async function handleCompleteFileUpload(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');
    const body = await c.req.json<CompleteFileUploadRequest>();

    const { r2_key, upload_id, parts } = body;

    // Validate request
    if (!r2_key || typeof r2_key !== 'string') {
      return c.json({ error: 'Missing or invalid r2_key' }, 400);
    }

    // Load batch state
    const state = await loadBatchState(c.env.BATCH_STATE, batchId);
    if (!state) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    // Find file in state
    const file = state.files.find((f) => f.r2_key === r2_key);
    if (!file) {
      return c.json({ error: 'File not found in batch' }, 404);
    }

    if (file.status === 'completed') {
      // Already completed - idempotent
      const response: CompleteFileUploadResponse = { success: true };
      return c.json(response, 200);
    }

    // Handle multipart completion
    if (file.upload_type === 'multipart') {
      if (!upload_id || !parts || !Array.isArray(parts)) {
        return c.json({ error: 'Missing upload_id or parts for multipart upload' }, 400);
      }

      if (upload_id !== file.upload_id) {
        return c.json({ error: 'upload_id mismatch' }, 400);
      }

      // Validate parts
      for (const part of parts) {
        if (
          typeof part.part_number !== 'number' ||
          typeof part.etag !== 'string'
        ) {
          return c.json({ error: 'Invalid parts format' }, 400);
        }
      }

      // Complete the multipart upload in R2
      const multipartUpload = c.env.STAGING_BUCKET.resumeMultipartUpload(
        r2_key,
        upload_id
      );

      // Convert part_number to partNumber for R2 API
      const r2Parts = parts.map((part) => ({
        partNumber: part.part_number,
        etag: part.etag,
      }));

      await multipartUpload.complete(r2Parts);
    }

    // Mark file as completed
    file.status = 'completed';
    file.completed_at = new Date().toISOString();

    // Save updated state
    await saveBatchState(c.env.BATCH_STATE, batchId, state);

    const response: CompleteFileUploadResponse = { success: true };
    return c.json(response, 200);
  } catch (error) {
    console.error('Error completing file upload:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
