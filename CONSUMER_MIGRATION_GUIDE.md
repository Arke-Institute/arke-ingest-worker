# Consumer Migration Guide: Queue Message Size Limit Fix

## Problem

Queue messages were exceeding Cloudflare's 128KB limit when batches contained many files (1000s) with nested directory structures. The error was:

```
Error finalizing batch: Error: Queue send failed: message length of 172905 bytes exceeds limit of 128000
```

## Solution

**Store the file manifest in R2 instead of embedding it in the queue message.**

The queue message now contains only metadata + a reference to the manifest stored in R2. This keeps messages tiny (< 1KB) regardless of batch size.

## What Changed

### Worker Changes (Already Implemented)

1. **Type Definitions** (`src/types.ts`):
   - `QueueMessage` now has `manifest_r2_key` field instead of `directories` array
   - New `BatchManifest` type for manifest stored in R2

2. **Finalize Handler** (`src/handlers/finalize.ts`):
   - Stores manifest at `staging/{batch_id}/_manifest.json` in R2
   - Sends minimal queue message to PREPROCESS_QUEUE

3. **Enqueue-Processed Handler** (`src/handlers/enqueue-processed.ts`):
   - Stores manifest at `staging/{batch_id}/_manifest.json` in R2 (overwrites preprocessing manifest)
   - Sends minimal queue message to BATCH_QUEUE

### Consumer Changes Required

**Both consumers must be updated:**

1. **Cloud Run Preprocessor** (PREPROCESS_QUEUE consumer)
2. **Orchestrator** (BATCH_QUEUE consumer)

---

## Migration Instructions

### Step 1: Understand the New Queue Message Format

#### Old Format (No Longer Used)

```typescript
interface QueueMessage {
  batch_id: string;
  r2_prefix: string;
  uploader: string;
  root_path: string;
  parent_pi: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  directories: DirectoryGroup[];  // ❌ No longer in queue message
}
```

#### New Format (Current)

```typescript
interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string;  // ✅ NEW: Reference to manifest
  r2_prefix: string;
  uploader: string;
  root_path: string;
  parent_pi: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  // directories removed
}

interface BatchManifest {  // ✅ NEW: Stored in R2
  batch_id: string;
  directories: DirectoryGroup[];
  total_files: number;
  total_bytes: number;
}
```

### Step 2: Update Consumer Code

#### Before (Old Code - BREAKS)

```typescript
export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const payload = message.body;

      // ❌ This will fail - directories no longer in queue message
      for (const directory of payload.directories) {
        for (const file of directory.files) {
          await processFile(file);
        }
      }

      message.ack();
    }
  }
};
```

#### After (New Code - REQUIRED)

```typescript
export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const payload = message.body;

      // ✅ STEP 1: Fetch manifest from R2
      const manifestObj = await env.STAGING_BUCKET.get(payload.manifest_r2_key);
      if (!manifestObj) {
        throw new Error(`Manifest not found: ${payload.manifest_r2_key}`);
      }

      const manifest: BatchManifest = await manifestObj.json();

      // ✅ STEP 2: Process directories from manifest
      for (const directory of manifest.directories) {
        for (const file of directory.files) {
          await processFile(file);
        }
      }

      message.ack();
    }
  }
};
```

### Step 3: Environment Configuration

Ensure your consumer has access to R2:

#### Cloudflare Worker Consumer

```toml
# wrangler.toml
[[r2_buckets]]
binding = "STAGING_BUCKET"
bucket_name = "arke-staging"

[[queues.consumers]]
queue = "arke-preprocess-jobs"  # or "arke-batch-jobs"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
```

#### Cloud Run Consumer (Python)

You'll need S3-compatible credentials to access R2:

```python
import json
from google.cloud import storage
import boto3

# Configure S3 client for R2
s3_client = boto3.client(
    's3',
    endpoint_url=f'https://{ACCOUNT_ID}.r2.cloudflarestorage.com',
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
)

def process_queue_message(message):
    payload = message
    manifest_key = payload['manifest_r2_key']

    # Fetch manifest from R2
    response = s3_client.get_object(Bucket='arke-staging', Key=manifest_key)
    manifest = json.loads(response['Body'].read())

    # Process directories
    for directory in manifest['directories']:
        for file_info in directory['files']:
            process_file(file_info, directory['processing_config'])
```

### Step 4: Update Type Definitions in Your Consumer

**TypeScript Consumers:**

Copy the updated types from `arke-ingest-worker/src/types.ts`:

```typescript
export interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string;
  r2_prefix: string;
  uploader: string;
  root_path: string;
  parent_pi: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
}

export interface BatchManifest {
  batch_id: string;
  directories: DirectoryGroup[];
  total_files: number;
  total_bytes: number;
}

export interface DirectoryGroup {
  directory_path: string;
  processing_config: ProcessingConfig;
  file_count: number;
  total_bytes: number;
  files: QueueFileInfo[];
}

export interface ProcessingConfig {
  ocr: boolean;
  describe: boolean;
  pinax: boolean;
}

export interface QueueFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
  content_type: string;
  cid?: string;
}
```

**Python Consumers:**

```python
from typing import TypedDict, List, Optional

class ProcessingConfig(TypedDict):
    ocr: bool
    describe: bool
    pinax: bool

class QueueFileInfo(TypedDict):
    r2_key: str
    logical_path: str
    file_name: str
    file_size: int
    content_type: str
    cid: Optional[str]

class DirectoryGroup(TypedDict):
    directory_path: str
    processing_config: ProcessingConfig
    file_count: int
    total_bytes: int
    files: List[QueueFileInfo]

class BatchManifest(TypedDict):
    batch_id: str
    directories: List[DirectoryGroup]
    total_files: int
    total_bytes: int

class QueueMessage(TypedDict):
    batch_id: str
    manifest_r2_key: str  # NEW
    r2_prefix: str
    uploader: str
    root_path: str
    parent_pi: str
    total_files: int
    total_bytes: int
    uploaded_at: str
    finalized_at: str
    metadata: dict
```

---

## Testing the Migration

### 1. Local Testing

Create a test manifest in R2:

```bash
# Create test manifest
cat > test-manifest.json <<'EOF'
{
  "batch_id": "01TEST000000000000000000000",
  "total_files": 1,
  "total_bytes": 1024,
  "directories": [
    {
      "directory_path": "/test",
      "processing_config": {"ocr": true, "describe": true, "pinax": true},
      "file_count": 1,
      "total_bytes": 1024,
      "files": [
        {
          "r2_key": "staging/01TEST000000000000000000000/test/file.txt",
          "logical_path": "/test/file.txt",
          "file_name": "file.txt",
          "file_size": 1024,
          "content_type": "text/plain"
        }
      ]
    }
  ]
}
EOF

# Upload to R2
wrangler r2 object put arke-staging/staging/01TEST000000000000000000000/_manifest.json --file test-manifest.json
```

### 2. Send Test Queue Message

```bash
cat > test-queue-message.json <<'EOF'
{
  "batch_id": "01TEST000000000000000000000",
  "manifest_r2_key": "staging/01TEST000000000000000000000/_manifest.json",
  "r2_prefix": "staging/01TEST000000000000000000000/",
  "uploader": "test@example.com",
  "root_path": "/test",
  "parent_pi": "00000000000000000000000000",
  "total_files": 1,
  "total_bytes": 1024,
  "uploaded_at": "2025-01-01T00:00:00.000Z",
  "finalized_at": "2025-01-01T00:01:00.000Z",
  "metadata": {}
}
EOF

# Send to preprocessing queue
wrangler queues producer send arke-preprocess-jobs --body "$(cat test-queue-message.json)"

# Send to batch queue
wrangler queues producer send arke-batch-jobs --body "$(cat test-queue-message.json)"
```

### 3. Verify Consumer Behavior

Check consumer logs to ensure:
1. Manifest is fetched successfully from R2
2. Directories are parsed correctly
3. Files are processed as expected

---

## Rollback Plan

If you need to rollback (not recommended - old format will break):

1. Revert worker code to previous commit
2. Redeploy: `wrangler deploy`
3. Update consumers back to old format

**Note:** This is not a viable long-term solution as batches with many files will still exceed the 128KB limit.

---

## Performance Impact

### Before (Old Format)
- Queue message size: 172KB (breaks at 128KB limit)
- Consumer startup: Immediate (data in message)
- R2 reads: N/A

### After (New Format)
- Queue message size: ~500 bytes (always under 128KB)
- Consumer startup: +1 R2 read per message (~10-50ms)
- R2 reads: 1 per batch (free up to 10M/month)

**Net result:** Slightly slower consumer startup (<50ms) but enables batches of ANY size (10 files or 100,000 files).

---

## FAQ

### Q: What if the manifest is missing from R2?

The consumer should throw an error and retry. Check worker logs to ensure manifest was written successfully.

### Q: Can I still access batch metadata without fetching the manifest?

Yes! All high-level metadata is still in the queue message: `batch_id`, `total_files`, `total_bytes`, `uploader`, `metadata`, etc. You only need to fetch the manifest if you need the file list.

### Q: What if I have 100,000 files in a batch?

The manifest in R2 can be arbitrarily large. R2 object size limit is 5TB, far exceeding any batch size you'll encounter.

### Q: Does this affect the preprocessing manifest?

The preprocessing manifest is stored at the same key (`staging/{batch_id}/_manifest.json`). When the preprocessor calls `/enqueue-processed`, it **overwrites** the manifest with the processed file list.

### Q: How do I clean up manifests?

Delete the entire batch directory when done: `await env.STAGING_BUCKET.delete(r2_prefix)` (this deletes all files + manifest).

---

## Support

If you encounter issues during migration:

1. Check worker logs: `wrangler tail arke-ingest-worker`
2. Check consumer logs for R2 access errors
3. Verify R2 credentials and bucket access
4. Check `QUEUE_MESSAGE_SPEC.md` for detailed examples

---

## Summary

**Key Changes:**
1. Queue messages now contain `manifest_r2_key` instead of `directories`
2. Consumers must fetch manifest from R2 before processing files
3. Both PREPROCESS_QUEUE and BATCH_QUEUE consumers need updates

**Benefits:**
- Scales to any batch size (1000s of files, deeply nested directories)
- Queue messages stay under 128KB limit
- Minimal performance impact (+10-50ms per batch)

**Action Required:**
Update both Cloud Run preprocessor and orchestrator to fetch manifest from R2 using `manifest_r2_key` from queue message.
