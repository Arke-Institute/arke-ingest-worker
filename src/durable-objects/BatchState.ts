/**
 * BatchStateObject Durable Object
 * Provides atomic, strongly consistent state management for batch uploads
 * Eliminates race conditions from concurrent file uploads
 */

import { DurableObject } from 'cloudflare:workers';
import type { BatchState, FileState, CompletedPart, ProcessedFileInfo } from '../types';

export class BatchStateObject extends DurableObject {
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
}
