/**
 * POST /api/batches/:batchId/files/start
 * Start a file upload by generating presigned URLs
 */

import type { Context } from 'hono';
import type {
  Env,
  StartFileUploadRequest,
  StartFileUploadResponse,
  FileState,
} from '../types';
import { MULTIPART_THRESHOLD, PART_SIZE } from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';
import { generatePresignedPutUrl, generatePresignedUploadPartUrls } from '../lib/presigned';
import { validateFileExtension, validateFileSize, validateLogicalPath, validateProcessingConfig } from '../lib/validation';

export async function handleStartFileUpload(
  c: Context<{ Bindings: Env }>
): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');
    const body = await c.req.json<StartFileUploadRequest>();

    const { file_name, file_size, logical_path, content_type, cid, processing_config } = body;

    // Validate request
    if (!file_name || typeof file_name !== 'string') {
      return c.json({ error: 'Missing or invalid file_name' }, 400);
    }

    if (!validateFileExtension(file_name)) {
      return c.json({ error: `File extension not allowed: ${file_name}` }, 400);
    }

    if (typeof file_size !== 'number' || file_size <= 0) {
      return c.json({ error: 'Invalid file_size' }, 400);
    }

    const maxFileSize = parseInt(c.env.MAX_FILE_SIZE);
    if (!validateFileSize(file_size, maxFileSize)) {
      return c.json({
        error: `File size ${file_size} exceeds maximum ${maxFileSize}`,
      }, 400);
    }

    if (!logical_path || !validateLogicalPath(logical_path)) {
      return c.json({ error: 'Missing or invalid logical_path' }, 400);
    }

    if (!content_type || typeof content_type !== 'string') {
      return c.json({ error: 'Missing or invalid content_type' }, 400);
    }

    // Validate processing_config
    const processingConfigError = validateProcessingConfig(processing_config);
    if (processingConfigError) {
      return c.json({ error: processingConfigError }, 400);
    }

    // Get Durable Object stub
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    const state = await stub.getState();
    if (!state) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    if (state.status !== 'uploading') {
      return c.json({ error: `Batch status is ${state.status}, expected uploading` }, 400);
    }

    // Construct R2 key
    const r2Key = `staging/${batchId}${logical_path}`;

    // Decide: multipart or simple upload?
    if (file_size >= MULTIPART_THRESHOLD) {
      // MULTIPART UPLOAD
      const numParts = Math.ceil(file_size / PART_SIZE);

      // Create multipart upload in R2
      const multipartUpload = await c.env.STAGING_BUCKET.createMultipartUpload(r2Key, {
        httpMetadata: {
          contentType: content_type,
        },
      });

      // Generate presigned URLs for each part
      const presignedUrls = await generatePresignedUploadPartUrls(
        c.env,
        r2Key,
        multipartUpload.uploadId,
        numParts
      );

      // Atomically add file to batch state (NO race conditions with DO!)
      const fileState: FileState = {
        r2_key: r2Key,
        file_name,
        file_size,
        logical_path,
        content_type,
        processing_config,
        upload_type: 'multipart',
        upload_id: multipartUpload.uploadId,
        status: 'uploading',
        ...(cid && { cid }),
      };
      await stub.addFile(fileState);

      // Return response
      const response: StartFileUploadResponse = {
        r2_key: r2Key,
        upload_type: 'multipart',
        upload_id: multipartUpload.uploadId,
        part_size: PART_SIZE,
        presigned_urls: presignedUrls,
      };

      return c.json(response, 200);
    } else {
      // SIMPLE UPLOAD
      const presignedUrl = await generatePresignedPutUrl(c.env, r2Key, content_type);

      // Atomically add file to batch state (NO race conditions with DO!)
      const fileState: FileState = {
        r2_key: r2Key,
        file_name,
        file_size,
        logical_path,
        content_type,
        processing_config,
        upload_type: 'simple',
        status: 'uploading',
        ...(cid && { cid }),
      };
      await stub.addFile(fileState);

      // Return response
      const response: StartFileUploadResponse = {
        r2_key: r2Key,
        upload_type: 'simple',
        presigned_url: presignedUrl,
      };

      return c.json(response, 200);
    }
  } catch (error) {
    console.error('Error starting file upload:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
