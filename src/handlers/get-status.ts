/**
 * GET /api/batches/:batchId/status
 * Get the current status and progress of a batch
 */

import type { Context } from 'hono';
import type { Env, BatchStatusResponse } from '../types';
import { getBatchStateStub } from '../lib/durable-object-helpers';

export async function handleGetBatchStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');

    // Get batch state from Durable Object
    const stub = getBatchStateStub(c.env.BATCH_STATE_DO, batchId);
    const state = await stub.getState();

    if (!state) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    // Calculate upload progress
    const filesCompleted = state.files.filter((f: any) => f.status === 'completed').length;
    const totalBytesUploaded = state.files
      .filter((f: any) => f.status === 'completed')
      .reduce((sum: number, f: any) => sum + f.file_size, 0);

    // Build response
    const response: BatchStatusResponse = {
      batch_id: state.batch_id,
      session_id: state.session_id,
      status: state.status,
      uploader: state.uploader,
      root_path: state.root_path,
      parent_pi: state.parent_pi,
      file_count: state.file_count,
      files_uploaded: filesCompleted,
      total_size: state.total_size,
      total_bytes_uploaded: totalBytesUploaded,
      created_at: state.created_at,
      enqueued_at: state.enqueued_at,
      metadata: state.metadata,
      custom_prompts: state.custom_prompts,
      files: state.files.map((f: any) => ({
        r2_key: f.r2_key,
        file_name: f.file_name,
        file_size: f.file_size,
        logical_path: f.logical_path,
        content_type: f.content_type,
        processing_config: f.processing_config,
        upload_type: f.upload_type,
        status: f.status,
        completed_at: f.completed_at,
        cid: f.cid,
      })),
      // Discovery state
      root_pi: state.root_pi,
    };

    // Add discovery progress if in discovery phase
    if (state.status === 'discovery' && state.discovery_state) {
      response.discovery_progress = {
        total: state.discovery_state.directories_total,
        published: state.discovery_state.directories_published,
        phase: state.discovery_state.phase,
      };
    }

    return c.json(response, 200);
  } catch (error) {
    console.error('Error getting batch status:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
