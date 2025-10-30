/**
 * POST /api/batches/init
 * Initialize a new batch upload session
 */

import { ulid } from 'ulidx';
import type { Context } from 'hono';
import type { Env, InitBatchRequest, InitBatchResponse, BatchState } from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';
import { validateBatchSize, validateLogicalPath, validateParentPi, checkParentPiExists } from '../lib/validation';

export async function handleInitBatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const body = await c.req.json<InitBatchRequest>();

    // Validate request
    const { uploader, root_path, file_count, total_size, metadata, parent_pi } = body;

    if (!uploader || typeof uploader !== 'string') {
      return c.json({ error: 'Missing or invalid uploader' }, 400);
    }

    if (!root_path || !validateLogicalPath(root_path)) {
      return c.json({ error: 'Missing or invalid root_path' }, 400);
    }

    if (typeof file_count !== 'number' || file_count <= 0) {
      return c.json({ error: 'Invalid file_count' }, 400);
    }

    if (typeof total_size !== 'number' || total_size <= 0) {
      return c.json({ error: 'Invalid total_size' }, 400);
    }

    // Default to origin block if not provided
    const parentPiValue = parent_pi || '00000000000000000000000000';

    // Validate parent_pi format
    if (!validateParentPi(parentPiValue)) {
      return c.json({
        error: 'Invalid parent_pi format (must be 26-character ULID)'
      }, 400);
    }

    // Validate parent_pi exists in archive (unless origin block)
    if (parentPiValue !== '00000000000000000000000000') {
      const checkResult = await checkParentPiExists(
        parentPiValue,
        c.env.ARKE_IPFS_API
      );

      if (!checkResult.exists) {
        return c.json({
          error: checkResult.error || 'Parent PI does not exist in archive'
        }, 404);
      }
    }

    // Validate batch size
    const maxBatchSize = parseInt(c.env.MAX_BATCH_SIZE);
    if (!validateBatchSize(total_size, maxBatchSize)) {
      return c.json({
        error: `Batch size ${total_size} exceeds maximum ${maxBatchSize}`,
      }, 400);
    }

    // Generate IDs
    const batchId = ulid();
    const sessionId = `sess_${ulid()}`;

    // Initialize batch state
    const batchState: BatchState = {
      batch_id: batchId,
      session_id: sessionId,
      uploader,
      root_path,
      parent_pi: parentPiValue,
      file_count,
      total_size,
      metadata: metadata || {},
      files: [],
      status: 'uploading',
      created_at: new Date().toISOString(),
    };

    // Save to Durable Object (atomic, no race conditions)
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    await stub.initBatch(batchState);

    // Return response
    const response: InitBatchResponse = {
      batch_id: batchId,
      session_id: sessionId,
    };

    return c.json(response, 201);
  } catch (error) {
    console.error('Error initializing batch:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
