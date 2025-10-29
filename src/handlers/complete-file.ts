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
import { getBatchStateStub } from '../lib/durable-object-helpers';

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

    // Atomically update file status in batch state (NO race conditions with DO!)
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    const result = await stub.completeFile(r2_key, upload_id, parts);

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
