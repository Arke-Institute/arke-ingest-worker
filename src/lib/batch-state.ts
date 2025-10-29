/**
 * Batch state management utilities
 * Handles reading/writing batch state to KV with version tracking
 */

import type { BatchState } from '../types';

const BATCH_TTL = 86400; // 24 hours

interface BatchStateWithVersion {
  state: BatchState;
  version: number;
}

/**
 * Load batch state from KV with version
 */
export async function loadBatchState(
  kv: KVNamespace,
  batchId: string
): Promise<BatchState | null> {
  const result = await loadBatchStateWithVersion(kv, batchId);
  return result?.state || null;
}

/**
 * Load batch state from KV with version tracking
 */
async function loadBatchStateWithVersion(
  kv: KVNamespace,
  batchId: string
): Promise<BatchStateWithVersion | null> {
  const key = `batch:${batchId}`;
  const data = await kv.get(key, { type: 'json' }) as any;

  if (!data) {
    return null;
  }

  try {
    return {
      state: data.state as BatchState,
      version: data.version || 0,
    };
  } catch (error) {
    console.error('Failed to parse batch state:', error);
    return null;
  }
}

/**
 * Save batch state to KV (wraps with version = 0 for backwards compat)
 */
export async function saveBatchState(
  kv: KVNamespace,
  batchId: string,
  state: BatchState
): Promise<void> {
  const key = `batch:${batchId}`;
  const wrappedState = {
    state,
    version: 0,
  };

  await kv.put(
    key,
    JSON.stringify(wrappedState),
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

/**
 * Update batch state atomically with retry logic
 * Uses simple serialization with delays between concurrent requests
 */
export async function updateBatchState<T>(
  kv: KVNamespace,
  batchId: string,
  updateFn: (state: BatchState) => T,
  maxRetries: number = 3
): Promise<T> {
  const key = `batch:${batchId}`;

  // Add a small random delay to spread out concurrent requests
  await new Promise(resolve => setTimeout(resolve, Math.random() * 50));

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Step 1: Load current state
      const current = await loadBatchStateWithVersion(kv, batchId);
      if (!current) {
        throw new Error('Batch not found');
      }

      // Step 2: Apply update function (mutates the state)
      const result = updateFn(current.state);

      // Step 3: Write with incremented version
      const newVersion = current.version + 1;
      const wrappedState = {
        state: current.state,
        version: newVersion,
      };

      await kv.put(
        key,
        JSON.stringify(wrappedState),
        { expirationTtl: BATCH_TTL }
      );

      // Success - return result
      return result;
    } catch (error) {
      if (attempt === maxRetries) {
        throw error;
      }
      // Retry with exponential backoff
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
    }
  }

  throw new Error('Unreachable code');
}
