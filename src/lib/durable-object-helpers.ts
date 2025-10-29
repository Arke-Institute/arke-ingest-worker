/**
 * Durable Object Helper Utilities
 * Provides convenient access to BatchStateObject Durable Objects
 */

import type { DurableObjectNamespace } from '@cloudflare/workers-types';

/**
 * Get Durable Object stub for a batch
 * Uses idFromName to ensure the same batch ID always gets the same DO instance
 */
export function getBatchStateStub(
  namespace: DurableObjectNamespace,
  batchId: string
) {
  const id = namespace.idFromName(batchId);
  return namespace.get(id) as any;
}
