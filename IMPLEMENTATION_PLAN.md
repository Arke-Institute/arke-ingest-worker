# Implementation Plan: Initial Discovery in Ingest Worker

## Overview

This plan implements **Initial Discovery** - creating entities with text files during batch finalization and returning `root_pi` immediately to clients. For large batches, discovery runs asynchronously via Durable Object alarms.

---

## Current State Analysis

### Existing Infrastructure
- **Durable Object**: `BatchStateObject` with SQLite backend (no alarms currently)
- **Service Binding**: `ARKE_IPFS_API` already configured for IPFS wrapper
- **Handlers**: `finalize.ts` builds manifest and enqueues to preprocessor
- **Types**: `BatchState`, `QueueMessage`, `BatchManifest` defined

### What Already Exists
- R2 manifest storage pattern
- Service binding to IPFS wrapper (`env.ARKE_IPFS_API`)
- Batch state management in DO
- File classification by extension

### What Needs to Be Added
- Discovery state tracking types
- IPFS wrapper client (copy from orchestrator)
- Discovery service logic
- Alarm handler in BatchState DO
- Modified finalize handler with sync/async decision

---

## Implementation Steps

### Step 1: Add Types for Discovery State

**File: `src/types.ts`**

Add these new types:

```typescript
// Add to BatchStatus union
export type BatchStatus =
  | 'uploading'
  | 'discovery'        // NEW: Initial discovery in progress
  | 'preprocessing'
  | 'enqueued'
  | 'processing'
  | 'completed'
  | 'failed';

// NEW: Discovery phase tracking
export type DiscoveryPhase = 'TREE_BUILD' | 'PUBLISHING' | 'RELATIONSHIPS' | 'DONE' | 'ERROR';

// NEW: Individual directory node during discovery
export interface DiscoveryNode {
  path: string;
  depth: number;
  parent_path?: string;
  children_paths: string[];
  text_files: { filename: string; r2_key: string }[];
  published: boolean;
  pi?: string;
  tip?: string;
  version?: number;
}

// NEW: Complete discovery state
export interface DiscoveryState {
  nodes: Record<string, DiscoveryNode>;
  directories_total: number;
  directories_published: number;
  node_pis: Record<string, string>;
  node_tips: Record<string, string>;
  node_versions: Record<string, number>;
  phase: DiscoveryPhase;
  current_depth: number;
  error?: string;
  retry_count?: number;
}

// MODIFY: Add discovery fields to BatchState
export interface BatchState {
  // ... existing fields ...
  root_pi?: string;
  discovery_state?: DiscoveryState;
}

// MODIFY: Add discovery fields to QueueMessage
export interface QueueMessage {
  // ... existing fields ...
  root_pi?: string;
  node_pis?: Record<string, string>;
  node_tips?: Record<string, string>;
  node_versions?: Record<string, number>;
}
```

---

### Step 2: Create IPFS Wrapper Client

**New file: `src/services/ipfs-wrapper.ts`**

Copy the `IPFSWrapperClient` class from the orchestrator (`arke-orchestrator/src/services/ipfs-wrapper.ts`). Key methods needed:

- `uploadContent(content, filename)` - Upload text to IPFS, get CID
- `createEntity(request)` - Create entity v1
- `appendVersion(request)` - Update entity (for relationships)
- `getEntityTip(pi)` - Get current tip for CAS operations

The service binding URL pattern is `https://api/...` (hostname is ignored by service bindings).

```typescript
// Essential interface (full implementation copied from orchestrator)
export class IPFSWrapperClient {
  constructor(private ipfsWrapper: Fetcher) {}

  async uploadContent(content: string, filename?: string): Promise<string>;
  async createEntity(request: CreateEntityRequest): Promise<CreateEntityResponse>;
  async appendVersion(request: AppendVersionRequest): Promise<AppendVersionResponse>;
  async getEntityTip(pi: string): Promise<string>;
  async addChildToParent(params: { parent_pi: string; child_pi: string }): Promise<void>;
}
```

---

### Step 3: Create Initial Discovery Service

**New file: `src/services/initial-discovery.ts`**

Core discovery logic:

```typescript
// Text file extensions to upload to IPFS
const TEXT_EXTENSIONS = new Set(['md', 'txt', 'json', 'xml', 'csv', 'html', 'htm']);

/**
 * Build discovery tree from manifest (synchronous, no I/O)
 */
export function buildDiscoveryTree(manifest: BatchManifest): DiscoveryState;

/**
 * Publish a batch of directories at current depth
 * Returns true if more work remains
 */
export async function publishDirectoryBatch(
  state: DiscoveryState,
  env: Env,
  batchSize: number
): Promise<boolean>;

/**
 * Establish parent-child relationships (after all dirs published)
 */
export async function establishRelationships(
  state: DiscoveryState,
  env: Env,
  parentPi?: string
): Promise<void>;

/**
 * Run complete discovery synchronously (for small batches)
 */
export async function runSyncDiscovery(
  manifest: BatchManifest,
  env: Env,
  parentPi?: string
): Promise<DiscoveryResult>;
```

**Key Implementation Details:**

1. **Tree Building** (no I/O):
   - Create `DiscoveryNode` for each directory in manifest
   - Classify files: text files go to `text_files[]`, binaries skipped (handled by preprocessor)
   - Build parent-child relationships from paths
   - Calculate max depth for bottom-up processing

2. **Directory Publishing**:
   - Process directories at `current_depth` (deepest first)
   - For each directory:
     - Upload text files to IPFS via `uploadContent()`
     - Create entity via `createEntity()` with components map
     - Store PI, tip, version in state
   - When depth exhausted, decrement and continue
   - Move to RELATIONSHIPS phase when all published

3. **Relationship Establishment**:
   - Process bottom-up (children before parents)
   - For each directory with children:
     - Call `appendVersion()` to add `children_pi`
   - Attach to external `parent_pi` if specified

---

### Step 4: Add Alarm Handler to BatchState DO

**File: `src/durable-objects/BatchState.ts`**

Add these methods:

```typescript
export class BatchStateObject extends DurableObject<Env> {
  // ... existing methods ...

  /**
   * Start async discovery (for large batches)
   */
  async startDiscovery(manifest: BatchManifest, parentPi?: string): Promise<void> {
    const state = await this.getState();
    if (!state) throw new Error('Batch not found');

    // Build discovery tree
    const discoveryState = buildDiscoveryTree(manifest);

    // Update state
    state.discovery_state = discoveryState;
    state.status = 'discovery';
    state.parent_pi = parentPi || state.parent_pi;
    await this.ctx.storage.put('state', state);
    await this.ctx.storage.put('manifest', manifest);

    // Schedule first alarm
    await this.ctx.storage.setAlarm(Date.now() + DISCOVERY_ALARM_DELAY);

    console.log(`[Discovery] Started async for ${discoveryState.directories_total} directories`);
  }

  /**
   * Alarm handler - processes discovery in batches
   */
  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<BatchState>('state');
    if (!state || state.status !== 'discovery' || !state.discovery_state) {
      return;
    }

    const discoveryState = state.discovery_state;

    try {
      if (discoveryState.phase === 'PUBLISHING') {
        const hasMore = await publishDirectoryBatch(
          discoveryState,
          this.env,
          DISCOVERY_BATCH_SIZE
        );

        await this.ctx.storage.put('state', state);

        if (hasMore) {
          await this.ctx.storage.setAlarm(Date.now() + DISCOVERY_ALARM_DELAY);
        }
      } else if (discoveryState.phase === 'RELATIONSHIPS') {
        await establishRelationships(discoveryState, this.env, state.parent_pi);

        // Discovery complete!
        state.root_pi = discoveryState.node_pis['/'];
        state.status = 'preprocessing';
        await this.ctx.storage.put('state', state);

        // Enqueue to preprocessor
        await this.enqueueToPreprocessor(state, discoveryState);

        console.log(`[Discovery] Complete, root_pi: ${state.root_pi}`);
      }
    } catch (error: any) {
      console.error('[Discovery] Alarm error:', error);
      discoveryState.error = error.message;
      discoveryState.retry_count = (discoveryState.retry_count || 0) + 1;
      await this.ctx.storage.put('state', state);

      // Retry with backoff (max 5 retries)
      if ((discoveryState.retry_count || 0) < 5) {
        const delay = Math.min(30000, 1000 * Math.pow(2, discoveryState.retry_count || 0));
        await this.ctx.storage.setAlarm(Date.now() + delay);
      } else {
        state.status = 'failed';
        await this.ctx.storage.put('state', state);
      }
    }
  }

  /**
   * Enqueue to preprocessor with discovery results
   */
  private async enqueueToPreprocessor(
    state: BatchState,
    discoveryState: DiscoveryState
  ): Promise<void> {
    const manifest = await this.ctx.storage.get<BatchManifest>('manifest');
    if (!manifest) throw new Error('Manifest not found');

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
  }

  /**
   * Set discovery results (for sync path)
   */
  async setDiscoveryResults(results: {
    root_pi: string;
    node_pis: Record<string, string>;
    node_tips: Record<string, string>;
    node_versions: Record<string, number>;
  }): Promise<void> {
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
      };
      await this.ctx.storage.put('state', state);
    }
  }
}
```

**Configuration constants** (add to top of file or config):
```typescript
const SYNC_DISCOVERY_MAX_DIRS = 50;    // Threshold for sync vs async
const DISCOVERY_BATCH_SIZE = 10;        // Directories per alarm
const DISCOVERY_ALARM_DELAY = 100;      // ms between alarms
```

---

### Step 5: Modify Finalize Handler

**File: `src/handlers/finalize.ts`**

Update to include discovery:

```typescript
import { buildDiscoveryTree, runSyncDiscovery } from '../services/initial-discovery';

const SYNC_DISCOVERY_MAX_DIRS = 50;

export async function handleFinalizeBatch(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const batchId = c.req.param('batchId');

    // ... existing validation and manifest building ...

    // Store manifest in R2 (existing code)
    const manifestKey = `staging/${batchId}/_manifest.json`;
    await c.env.STAGING_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2));

    // Decide sync vs async based on directory count
    const dirCount = manifest.directories.length;
    const useAsyncDiscovery = dirCount >= SYNC_DISCOVERY_MAX_DIRS;

    console.log(`[Finalize] ${dirCount} directories, using ${useAsyncDiscovery ? 'async' : 'sync'} discovery`);

    if (useAsyncDiscovery) {
      // ASYNC PATH: Start discovery via alarms, return immediately
      await stub.startDiscovery(manifest, state.parent_pi);

      return c.json({
        batch_id: batchId,
        status: 'discovery',
        files_uploaded: state.files.length,
        total_bytes: totalBytes,
        r2_prefix: `staging/${batchId}/`,
        discovery_progress: {
          total: dirCount,
          published: 0,
        },
      }, 200);

    } else {
      // SYNC PATH: Run discovery inline, return root_pi
      let discoveryResult = null;
      try {
        discoveryResult = await runSyncDiscovery(manifest, c.env, state.parent_pi);
        await stub.setDiscoveryResults(discoveryResult);
        console.log(`[Finalize] Sync discovery complete, root_pi: ${discoveryResult.root_pi}`);
      } catch (error) {
        console.error('[Finalize] Sync discovery failed:', error);
        // Continue without discovery - preprocessor/orchestrator handles it
      }

      // Build queue message with discovery results
      const queueMessage: QueueMessage = {
        batch_id: batchId,
        manifest_r2_key: manifestKey,
        r2_prefix: `staging/${batchId}/`,
        uploader: state.uploader,
        root_path: state.root_path,
        parent_pi: state.parent_pi,
        total_files: state.files.length,
        total_bytes: totalBytes,
        uploaded_at: state.created_at,
        finalized_at: new Date().toISOString(),
        metadata: state.metadata,
        custom_prompts: state.custom_prompts,

        // Discovery results (if available)
        root_pi: discoveryResult?.root_pi,
        node_pis: discoveryResult?.node_pis,
        node_tips: discoveryResult?.node_tips,
        node_versions: discoveryResult?.node_versions,
      };

      await c.env.PREPROCESS_QUEUE.send(queueMessage);
      await stub.updateStatus('preprocessing', new Date().toISOString());

      return c.json({
        batch_id: batchId,
        root_pi: discoveryResult?.root_pi,
        status: 'preprocessing',
        files_uploaded: state.files.length,
        total_bytes: totalBytes,
        r2_prefix: `staging/${batchId}/`,
      }, 200);
    }

  } catch (error) {
    console.error('Error finalizing batch:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
}
```

---

### Step 6: Update Status Handler

**File: `src/handlers/get-status.ts`**

Add discovery progress:

```typescript
export interface BatchStatusResponse {
  // ... existing fields ...
  root_pi?: string;
  discovery_progress?: {
    total: number;
    published: number;
    phase?: string;
  };
}

export async function handleGetStatus(c: Context<{ Bindings: Env }>): Promise<Response> {
  // ... existing code ...

  const response: BatchStatusResponse = {
    // ... existing fields ...
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
}
```

---

### Step 7: Update Env Type

**File: `src/types.ts`**

Ensure `ARKE_IPFS_API` binding is typed:

```typescript
export interface Env {
  // ... existing ...
  ARKE_IPFS_API: Fetcher;  // Already exists, just verify
}
```

---

## File Summary

| File | Action | Description |
|------|--------|-------------|
| `src/types.ts` | MODIFY | Add `DiscoveryState`, `DiscoveryNode`, extend `BatchState` and `QueueMessage` |
| `src/services/ipfs-wrapper.ts` | CREATE | Copy from orchestrator, IPFS API client |
| `src/services/initial-discovery.ts` | CREATE | Discovery tree building and publishing logic |
| `src/durable-objects/BatchState.ts` | MODIFY | Add alarm handler, discovery methods |
| `src/handlers/finalize.ts` | MODIFY | Sync/async discovery decision |
| `src/handlers/get-status.ts` | MODIFY | Add discovery progress |

---

## Configuration

**File: `wrangler.jsonc`**

Add config vars (optional, can use defaults):

```jsonc
{
  "vars": {
    // ... existing ...
    "SYNC_DISCOVERY_MAX_DIRS": "50",
    "DISCOVERY_BATCH_SIZE": "10",
    "DISCOVERY_ALARM_DELAY": "100"
  }
}
```

Service binding already exists:
```jsonc
{
  "services": [
    { "binding": "ARKE_IPFS_API", "service": "arke-ipfs-api" }
  ]
}
```

---

## Testing Plan

### Unit Tests
1. `buildDiscoveryTree()` - Verify tree structure from manifest
2. `publishDirectory()` - Mock IPFS calls, verify components map
3. Sync vs async threshold decision

### Integration Tests
1. **Small batch (< 50 dirs)**: Verify sync path returns `root_pi` immediately
2. **Large batch (>= 50 dirs)**: Verify async path, poll status for progress
3. **Discovery failure**: Verify retry with exponential backoff
4. **Alarm resumption**: Kill worker mid-discovery, verify resume from checkpoint

### Manual Tests
```bash
# Small batch - should get root_pi immediately
curl -X POST https://ingest.arke.institute/api/batches/{id}/finalize
# Response: { "root_pi": "01ABC...", "status": "preprocessing" }

# Large batch - should get discovery status
curl -X POST https://ingest.arke.institute/api/batches/{id}/finalize
# Response: { "status": "discovery", "discovery_progress": {...} }

# Poll until root_pi available
curl https://ingest.arke.institute/api/batches/{id}/status
# Eventually: { "root_pi": "01ABC...", "status": "preprocessing" }
```

---

## Implementation Order

1. **Types first** - Add types to `src/types.ts`
2. **IPFS client** - Create `src/services/ipfs-wrapper.ts`
3. **Discovery service** - Create `src/services/initial-discovery.ts`
4. **DO changes** - Add alarm handler to `BatchState.ts`
5. **Finalize handler** - Update with sync/async logic
6. **Status handler** - Add discovery progress
7. **Test** - Run type check, then integration tests

---

## Timing Estimates

| Batch Size | Discovery Time | Response Time |
|------------|---------------|---------------|
| 20 dirs | ~2-5s (sync) | Immediate with root_pi |
| 50 dirs | ~5-10s (async) | Immediate, poll ~3-5x |
| 100 dirs | ~15-30s (async) | Immediate, poll ~10-15x |
| 500 dirs | ~1-2 min (async) | Immediate, poll ~30-50x |

**Much faster than waiting for preprocessing** (which can take hours for large batches with TIFFs).
