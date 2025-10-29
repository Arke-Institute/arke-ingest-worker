/**
 * Batch state management utilities
 * Handles reading/writing batch state to KV
 */

import type { BatchState } from '../types';

const BATCH_TTL = 86400; // 24 hours

/**
 * Load batch state from KV
 */
export async function loadBatchState(
  kv: KVNamespace,
  batchId: string
): Promise<BatchState | null> {
  const key = `batch:${batchId}`;
  const data = await kv.get(key);

  if (!data) {
    return null;
  }

  try {
    return JSON.parse(data) as BatchState;
  } catch (error) {
    console.error('Failed to parse batch state:', error);
    return null;
  }
}

/**
 * Save batch state to KV
 */
export async function saveBatchState(
  kv: KVNamespace,
  batchId: string,
  state: BatchState
): Promise<void> {
  const key = `batch:${batchId}`;

  await kv.put(
    key,
    JSON.stringify(state),
    { expirationTtl: BATCH_TTL }
  );
}

/**
 * Delete batch state from KV
 */
export async function deleteBatchState(
  kv: KVNamespace,
  batchId: string
): Promise<void> {
  const key = `batch:${batchId}`;
  await kv.delete(key);
}
