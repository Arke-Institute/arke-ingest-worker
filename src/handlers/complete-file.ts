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
import { updateBatchState } from '../lib/batch-state';

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

    // Atomically update file status in batch state
    const result = await updateBatchState(c.env.BATCH_STATE, batchId, (state) => {
      // Find file in state
      const file = state.files.find((f) => f.r2_key === r2_key);
      if (!file) {
        throw new Error('File not found in batch');
      }

      if (file.status === 'completed') {
        // Already completed - idempotent, skip update
        return { alreadyCompleted: true, file };
      }

      // Handle multipart completion
      if (file.upload_type === 'multipart') {
        if (!upload_id || !parts || !Array.isArray(parts)) {
          throw new Error('Missing upload_id or parts for multipart upload');
        }

        if (upload_id !== file.upload_id) {
          throw new Error('upload_id mismatch');
        }

        // Validate parts
        for (const part of parts) {
          if (
            typeof part.part_number !== 'number' ||
            typeof part.etag !== 'string'
          ) {
            throw new Error('Invalid parts format');
          }
        }
      }

      // Mark file as completed
      file.status = 'completed';
      file.completed_at = new Date().toISOString();

      return { alreadyCompleted: false, file, needsMultipartComplete: file.upload_type === 'multipart' };
    });

    // Complete multipart upload in R2 (outside the state update)
    if (result.needsMultipartComplete && upload_id && parts) {
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

    const response: CompleteFileUploadResponse = { success: true };
    return c.json(response, 200);
  } catch (error) {
    console.error('Error completing file upload:', error);

    // Handle specific errors
    if (error instanceof Error) {
      if (error.message === 'File not found in batch' || error.message === 'Batch not found') {
        return c.json({ error: error.message }, 404);
      }
      if (error.message.includes('upload_id') || error.message.includes('parts')) {
        return c.json({ error: error.message }, 400);
      }
    }

    return c.json({ error: 'Internal server error' }, 500);
  }
}
