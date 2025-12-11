/**
 * BatchStateObject Durable Object
 * Provides atomic, strongly consistent state management for batch uploads
 * Eliminates race conditions from concurrent file uploads
 *
 * Also handles Initial Discovery for creating entities during finalization.
 * For large batches, discovery runs asynchronously via alarms.
 */

import { DurableObject } from 'cloudflare:workers';
import type {
  BatchState,
  FileState,
  CompletedPart,
  ProcessedFileInfo,
  BatchManifest,
  DiscoveryState,
  DiscoveryResult,
  QueueMessage,
  Env,
} from '../types';
import {
  buildDiscoveryTree,
  processDiscoveryBatch,
  establishRelationships,
} from '../services/initial-discovery';

// Discovery configuration
// Constraint: Cloudflare Workers allow 1000 subrequests per invocation (paid plan)
// Large text files could cause timeouts, so keep some buffer
const DISCOVERY_UPLOAD_BATCH_SIZE = 100; // Files to upload per alarm iteration
const DISCOVERY_ENTITY_BATCH_SIZE = 100; // Entities to create per alarm iteration
const DISCOVERY_ALARM_DELAY = 100; // ms between alarms
const DISCOVERY_MAX_RETRIES = 5; // Max retries before failing

export class BatchStateObject extends DurableObject<Env> {
  /**
   * Initialize a new batch
   */
  async initBatch(batchState: BatchState): Promise<void> {
    await this.ctx.storage.put('state', batchState);
  }

  /**
   * Get current batch state
   */
  async getState(): Promise<BatchState | null> {
    const state = await this.ctx.storage.get<BatchState>('state');
    return state ?? null;
  }

  /**
   * Add file to batch (ATOMIC - no race condition possible)
   * This is the key operation that was failing with KV
   */
  async addFile(fileState: FileState): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state) {
      throw new Error('Batch not found');
    }

    if (state.status !== 'uploading') {
      throw new Error(`Batch status is ${state.status}, expected uploading`);
    }

    // This is TRULY atomic - no concurrent modifications possible
    // The Durable Object guarantees single-threaded execution
    state.files.push(fileState);
    await this.ctx.storage.put('state', state);
  }

  /**
   * Complete a file upload (ATOMIC)
   * Validates and marks file as completed
   */
  async completeFile(
    r2Key: string,
    uploadId?: string,
    parts?: CompletedPart[]
  ): Promise<{
    alreadyCompleted: boolean;
    file: FileState;
    needsMultipartComplete: boolean;
  }> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state) {
      throw new Error('Batch not found');
    }

    const file = state.files.find((f) => f.r2_key === r2Key);
    if (!file) {
      throw new Error('File not found in batch');
    }

    if (file.status === 'completed') {
      // Already completed - idempotent
      return {
        alreadyCompleted: true,
        file,
        needsMultipartComplete: false,
      };
    }

    // Validate multipart params if needed
    if (file.upload_type === 'multipart') {
      if (!uploadId || !parts || !Array.isArray(parts)) {
        throw new Error('Missing upload_id or parts for multipart upload');
      }
      if (uploadId !== file.upload_id) {
        throw new Error('upload_id mismatch');
      }
      // Validate parts format
      for (const part of parts) {
        if (
          typeof part.part_number !== 'number' ||
          typeof part.etag !== 'string'
        ) {
          throw new Error('Invalid parts format');
        }
      }
    }

    // Update status atomically
    file.status = 'completed';
    file.completed_at = new Date().toISOString();
    await this.ctx.storage.put('state', state);

    return {
      alreadyCompleted: false,
      file,
      needsMultipartComplete: file.upload_type === 'multipart',
    };
  }

  /**
   * Update batch status
   */
  async updateStatus(status: string, enqueuedAt?: string): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state) {
      throw new Error('Batch not found');
    }

    state.status = status as any;
    if (enqueuedAt) {
      state.enqueued_at = enqueuedAt;
    }
    await this.ctx.storage.put('state', state);
  }

  /**
   * Replace entire file list with processed files from Cloud Run
   * Used after preprocessing completes (TIFF conversion, PDF splitting, etc.)
   */
  async replaceFiles(processedFiles: ProcessedFileInfo[]): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state) {
      throw new Error('Batch not found');
    }

    // Wholesale replacement of file list
    state.files = processedFiles.map(pf => ({
      r2_key: pf.r2_key,
      file_name: pf.file_name,
      file_size: pf.file_size,
      logical_path: pf.logical_path,
      content_type: pf.content_type,
      cid: pf.cid,
      status: 'completed' as const,
      completed_at: new Date().toISOString(),
      upload_type: 'simple' as const,
      // Use provided config or default
      processing_config: pf.processing_config || {
        ocr: false,
        describe: false,
        pinax: false,
      },
    }));

    await this.ctx.storage.put('state', state);
  }

  /**
   * Delete batch state (cleanup)
   */
  async deleteBatch(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  // ============================================================================
  // Discovery Methods (Initial Discovery during finalization)
  // ============================================================================

  /**
   * Start async discovery (for large batches)
   * Schedules alarm-based processing to avoid timeout
   */
  async startDiscovery(manifest: BatchManifest, parentPi?: string): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state) {
      throw new Error('Batch not found');
    }

    // Build discovery tree
    const discoveryState = buildDiscoveryTree(manifest);

    // Update state
    state.discovery_state = discoveryState;
    state.status = 'discovery';
    if (parentPi) {
      state.parent_pi = parentPi;
    }
    await this.ctx.storage.put('state', state);

    // Store manifest for alarm processing
    await this.ctx.storage.put('manifest', manifest);

    // Schedule first alarm
    await this.ctx.storage.setAlarm(Date.now() + DISCOVERY_ALARM_DELAY);

    console.log(
      `[Discovery] Started async for ${discoveryState.directories_total} directories`
    );
  }

  /**
   * Alarm handler - processes discovery in batches
   * Called automatically by Durable Object runtime
   *
   * Uses item-level batching to handle directories with many files:
   * - UPLOADING phase: Upload N files per alarm (avoids subrequest limits)
   * - PUBLISHING phase: Create N entities per alarm
   * - RELATIONSHIPS phase: Attach to parent, then done
   */
  override async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state || state.status !== 'discovery' || !state.discovery_state) {
      return;
    }

    const discoveryState = state.discovery_state;

    try {
      if (discoveryState.phase === 'UPLOADING' || discoveryState.phase === 'PUBLISHING') {
        // Process next batch (uploads or entity creation based on phase)
        const hasMore = await processDiscoveryBatch(
          discoveryState,
          this.env,
          DISCOVERY_UPLOAD_BATCH_SIZE,
          DISCOVERY_ENTITY_BATCH_SIZE
        );

        await this.ctx.storage.put('state', state);

        if (hasMore) {
          await this.ctx.storage.setAlarm(Date.now() + DISCOVERY_ALARM_DELAY);
        }
      } else if (discoveryState.phase === 'RELATIONSHIPS') {
        // Establish relationships (attach to external parent)
        await establishRelationships(discoveryState, this.env, state.parent_pi);

        // Discovery complete!
        state.root_pi = discoveryState.node_pis['/'];
        state.status = 'preprocessing';
        await this.ctx.storage.put('state', state);

        // Enqueue to preprocessor
        await this.enqueueToPreprocessor(state, discoveryState);

        console.log(`[Discovery] Complete, root_pi: ${state.root_pi}`);
      } else if (discoveryState.phase === 'DONE') {
        // Already done, nothing to do
        console.log('[Discovery] Alarm called but phase is DONE, ignoring');
      }
    } catch (error: any) {
      console.error('[Discovery] Alarm error:', error);
      discoveryState.error = error.message;
      discoveryState.retry_count = (discoveryState.retry_count || 0) + 1;

      if (discoveryState.retry_count < DISCOVERY_MAX_RETRIES) {
        // Retry with exponential backoff
        const delay = Math.min(30000, 1000 * Math.pow(2, discoveryState.retry_count));
        await this.ctx.storage.put('state', state);
        await this.ctx.storage.setAlarm(Date.now() + delay);
        console.log(
          `[Discovery] Retry ${discoveryState.retry_count}/${DISCOVERY_MAX_RETRIES} scheduled in ${delay}ms`
        );
      } else {
        // Max retries exceeded
        state.status = 'failed';
        discoveryState.phase = 'ERROR';
        await this.ctx.storage.put('state', state);
        console.error(`[Discovery] Failed after ${DISCOVERY_MAX_RETRIES} retries`);
      }
    }
  }

  /**
   * Enqueue to preprocessor after discovery completes
   */
  private async enqueueToPreprocessor(
    state: BatchState,
    discoveryState: DiscoveryState
  ): Promise<void> {
    const manifest = await this.ctx.storage.get<BatchManifest>('manifest');
    if (!manifest) {
      throw new Error('Manifest not found');
    }

    const queueMessage: QueueMessage = {
      batch_id: state.batch_id,
      manifest_r2_key: `staging/${state.batch_id}/_manifest.json`,
      r2_prefix: `staging/${state.batch_id}/`,
      uploader: state.uploader,
      root_path: state.root_path,
      parent_pi: state.parent_pi,
      total_files: manifest.total_files,
      total_bytes: manifest.total_bytes,
      uploaded_at: state.created_at,
      finalized_at: new Date().toISOString(),
      metadata: state.metadata,
      custom_prompts: state.custom_prompts,

      // Discovery results
      root_pi: discoveryState.node_pis['/'],
      node_pis: discoveryState.node_pis,
      node_tips: discoveryState.node_tips,
      node_versions: discoveryState.node_versions,
    };

    await this.env.PREPROCESS_QUEUE.send(queueMessage);
    console.log(`[Discovery] Enqueued to preprocessor: ${state.batch_id}`);
  }

  /**
   * Set discovery results (for sync discovery path)
   * Called after runSyncDiscovery completes in the finalize handler
   */
  async setDiscoveryResults(results: DiscoveryResult): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (state) {
      state.root_pi = results.root_pi;
      state.discovery_state = {
        nodes: {},
        directories_total: Object.keys(results.node_pis).length,
        directories_published: Object.keys(results.node_pis).length,
        node_pis: results.node_pis,
        node_tips: results.node_tips,
        node_versions: results.node_versions,
        phase: 'DONE',
        current_depth: 0,
        files_total: 0,
        files_uploaded: 0,
      };
      await this.ctx.storage.put('state', state);
    }
  }
}
