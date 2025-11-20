# Queue Message Specification

## Overview

The `arke-ingest-worker` uses two Cloudflare Queues to orchestrate batch processing:

1. **PREPROCESS_QUEUE** (`arke-preprocess-jobs`): For file preprocessing (TIFF conversion, PDF splitting)
2. **BATCH_QUEUE** (`arke-batch-jobs`): For final processing (OCR, LLM, IPFS storage)

Both queues use the **same message format** with a manifest stored in R2 to avoid queue message size limits (128KB).

## Architecture: Manifest Storage Pattern

To support batches with thousands of files and deeply nested directories, the file manifest is **stored in R2** rather than embedded in the queue message. This keeps queue messages under the 128KB limit regardless of batch size.

**Flow:**
1. Worker stores manifest at `staging/{batch_id}/_manifest.json` in R2
2. Worker sends minimal queue message with `manifest_r2_key` reference
3. Consumer fetches manifest from R2 using the provided key
4. Consumer processes files listed in manifest

## Queue Details

### PREPROCESS_QUEUE (`arke-preprocess-jobs`)
- **Trigger**: Sent when `POST /api/batches/:batchId/finalize` is called
- **Consumer**: Cloud Run preprocessor service
- **Purpose**: TIFF conversion, PDF splitting, file transformations

### BATCH_QUEUE (`arke-batch-jobs`)
- **Trigger**: Sent when `POST /api/batches/:batchId/enqueue-processed` is called by preprocessor
- **Consumer**: Orchestrator for OCR, LLM, IPFS processing
- **Purpose**: Final ingestion pipeline processing

## Message Structure

### TypeScript Interfaces

#### Queue Message (Sent to Queue)

```typescript
interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string; // Reference to manifest in R2
  r2_prefix: string;
  uploader: string;
  root_path: string;
  parent_pi: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  custom_prompts?: CustomPrompts;
}

interface CustomPrompts {
  general?: string;           // Applied to all AI service calls
  reorganization?: string;    // Phase-specific: file reorganization
  pinax?: string;             // Phase-specific: PINAX metadata extraction
  description?: string;       // Phase-specific: description generation
  cheimarros?: string;        // Phase-specific: knowledge graph extraction
}
```

#### Batch Manifest (Stored in R2)

```typescript
interface BatchManifest {
  batch_id: string;
  directories: DirectoryGroup[];
  total_files: number;
  total_bytes: number;
}

interface DirectoryGroup {
  directory_path: string;
  processing_config: ProcessingConfig;
  file_count: number;
  total_bytes: number;
  files: QueueFileInfo[];
}

interface ProcessingConfig {
  ocr: boolean;
  describe: boolean;
  pinax: boolean;
}

interface QueueFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
  content_type: string;
  cid?: string;
}
```

### Field Descriptions

#### Queue Message Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `batch_id` | `string` | Unique batch identifier (ULID) | `"01K8RNKN488RQCG3YGG72QBZS5"` |
| `manifest_r2_key` | `string` | **R2 key where the manifest is stored** | `"staging/01K8RNKN488RQCG3YGG72QBZS5/_manifest.json"` |
| `r2_prefix` | `string` | R2 bucket prefix where files are stored | `"staging/01K8RNKN488RQCG3YGG72QBZS5/"` |
| `uploader` | `string` | Identity of the user/system that uploaded the batch | `"john.doe@arke.institute"` |
| `root_path` | `string` | Logical root path for the batch | `"/archives/2025/collection-01"` |
| `parent_pi` | `string` | Parent Persistent Identifier (26-character ULID) | `"00000000000000000000000000"` |
| `total_files` | `number` | Total number of files in the batch | `5` |
| `total_bytes` | `number` | Sum of all file sizes in bytes | `5368709120` |
| `uploaded_at` | `string` | ISO 8601 timestamp when batch was created | `"2025-10-29T19:15:30.123Z"` |
| `finalized_at` | `string` | ISO 8601 timestamp when batch was finalized | `"2025-10-29T19:20:45.456Z"` |
| `metadata` | `object` | Custom metadata provided during batch initialization | `{"project": "archival-2025", "source": "scanner-01"}` |
| `custom_prompts` | `object` (optional) | Custom AI prompts for pipeline processing phases | See below |

#### Custom Prompts Fields

The `custom_prompts` object allows batch-specific AI prompt customization:

| Field | Type | Max Length | Description | Example |
|-------|------|------------|-------------|---------|
| `general` | `string` (optional) | 10,000 chars | Applied to all AI service calls | `"All content is from 18th century manuscripts"` |
| `reorganization` | `string` (optional) | 10,000 chars | File reorganization phase (arke-organizer-service) | `"Group by subject matter rather than author"` |
| `pinax` | `string` (optional) | 10,000 chars | Metadata extraction phase (arke-metadata-service) | `"Use Library of Congress Subject Headings"` |
| `description` | `string` (optional) | 10,000 chars | Description generation phase (arke-description-service) | `"Write in scholarly, academic tone"` |
| `cheimarros` | `string` (optional) | 10,000 chars | Knowledge graph extraction phase (arke-cheimarros-service) | `"Focus on people and institutions"` |

**Total maximum:** 20,000 characters across all custom prompt fields.

#### Batch Manifest Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `batch_id` | `string` | Unique batch identifier (matches queue message) | `"01K8RNKN488RQCG3YGG72QBZS5"` |
| `directories` | `array` | Array of directory groups with processing configs | See below |
| `total_files` | `number` | Total number of files in the batch | `5` |
| `total_bytes` | `number` | Sum of all file sizes in bytes | `5368709120` |

#### Directory Group Fields

Each object in the `directories` array contains:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `directory_path` | `string` | Directory path (extracted from logical paths) | `"/documents/subfolder"` |
| `processing_config` | `object` | Processing configuration for files in this directory | See below |
| `file_count` | `number` | Number of files in this directory | `3` |
| `total_bytes` | `number` | Total size of files in this directory | `3145728` |
| `files` | `array` | Array of file information objects | See below |

#### Processing Config Fields

The `processing_config` object controls downstream processing:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `ocr` | `boolean` | Enable/disable OCR (Optical Character Recognition) processing | `true` |
| `describe` | `boolean` | Enable/disable AI-powered description generation | `true` |
| `pinax` | `boolean` | Enable/disable Pinax metadata generation (defaults to `true`) | `true` |

#### File Information Fields

Each object in the `files` array within a directory contains:

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `r2_key` | `string` | Full R2 object key (includes staging prefix and logical path) | `"staging/01K8RNKN488RQCG3YGG72QBZS5/documents/report.pdf"` |
| `logical_path` | `string` | Logical path relative to root (includes leading slash and filename) | `"/documents/report.pdf"` |
| `file_name` | `string` | Base filename only | `"report.pdf"` |
| `file_size` | `number` | File size in bytes | `1048576` |
| `content_type` | `string` | MIME type of the file | `"application/pdf"` |
| `cid` | `string` (optional) | Content Identifier for the file | `"bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"` |

## Example Messages

### Queue Message (Sent to Queue)

```json
{
  "batch_id": "01K8RNKN488RQCG3YGG72QBZS5",
  "manifest_r2_key": "staging/01K8RNKN488RQCG3YGG72QBZS5/_manifest.json",
  "r2_prefix": "staging/01K8RNKN488RQCG3YGG72QBZS5/",
  "uploader": "john.doe@arke.institute",
  "root_path": "/archives/2025/collection-01",
  "parent_pi": "00000000000000000000000000",
  "total_files": 3,
  "total_bytes": 3145728,
  "uploaded_at": "2025-10-29T19:15:30.123Z",
  "finalized_at": "2025-10-29T19:20:45.456Z",
  "metadata": {
    "project": "archival-2025",
    "source": "scanner-01",
    "collection_id": "col_12345"
  },
  "custom_prompts": {
    "general": "All content is from 18th century scientific manuscripts.",
    "reorganization": "Group documents by subject matter rather than author.",
    "pinax": "Use Library of Congress Subject Headings when possible."
  }
}
```

### Batch Manifest (Stored in R2 at `staging/{batch_id}/_manifest.json`)

```json
{
  "batch_id": "01K8RNKN488RQCG3YGG72QBZS5",
  "total_files": 3,
  "total_bytes": 3145728,
  "directories": [
    {
      "directory_path": "/",
      "processing_config": {
        "ocr": false,
        "describe": false,
        "pinax": true
      },
      "file_count": 1,
      "total_bytes": 524288,
      "files": [
        {
          "r2_key": "staging/01K8RNKN488RQCG3YGG72QBZS5/metadata.json",
          "logical_path": "/metadata.json",
          "file_name": "metadata.json",
          "file_size": 524288,
          "content_type": "application/json"
        }
      ]
    },
    {
      "directory_path": "/documents",
      "processing_config": {
        "ocr": true,
        "describe": true,
        "pinax": true
      },
      "file_count": 1,
      "total_bytes": 1048576,
      "files": [
        {
          "r2_key": "staging/01K8RNKN488RQCG3YGG72QBZS5/documents/report.pdf",
          "logical_path": "/documents/report.pdf",
          "file_name": "report.pdf",
          "file_size": 1048576,
          "content_type": "application/pdf",
          "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
        }
      ]
    },
    {
      "directory_path": "/images",
      "processing_config": {
        "ocr": true,
        "describe": true,
        "pinax": false
      },
      "file_count": 1,
      "total_bytes": 1572864,
      "files": [
        {
          "r2_key": "staging/01K8RNKN488RQCG3YGG72QBZS5/images/photo1.tiff",
          "logical_path": "/images/photo1.tiff",
          "file_name": "photo1.tiff",
          "file_size": 1572864,
          "content_type": "image/tiff",
          "cid": "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"
        }
      ]
    }
  ]
}
```

## Consumer Implementation

Both the **Cloud Run preprocessor** (PREPROCESS_QUEUE consumer) and the **orchestrator** (BATCH_QUEUE consumer) need to fetch the manifest from R2 before processing files.

### Setting Up the Consumer

#### Cloudflare Worker Consumer (wrangler.toml)

```toml
[[queues.consumers]]
queue = "arke-batch-jobs"  # or "arke-preprocess-jobs"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "arke-batch-jobs-dlq"
```

#### Cloud Run Consumer

Use the Google Cloud Storage client to access R2 (via S3-compatible API) or use HTTP fetch with presigned URLs.

### Consumer Handler Example (Cloudflare Worker)

```typescript
export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = message.body;

        console.log(`Processing batch ${payload.batch_id}`);
        console.log(`- Files: ${payload.total_files}`);
        console.log(`- Total size: ${payload.total_bytes} bytes`);
        console.log(`- Manifest: ${payload.manifest_r2_key}`);

        // **CRITICAL: Fetch manifest from R2**
        const manifestObj = await env.STAGING_BUCKET.get(payload.manifest_r2_key);
        if (!manifestObj) {
          throw new Error(`Manifest not found: ${payload.manifest_r2_key}`);
        }

        const manifest: BatchManifest = await manifestObj.json();

        console.log(`Loaded manifest with ${manifest.directories.length} directories`);

        // Process each directory group
        for (const directory of manifest.directories) {
          console.log(`Processing directory: ${directory.directory_path}`);
          console.log(`- Files: ${directory.file_count}`);
          console.log(`- Processing config:`, directory.processing_config);

          // Process each file in the directory
          for (const file of directory.files) {
            await processFile({
              r2Key: file.r2_key,
              logicalPath: file.logical_path,
              fileName: file.file_name,
              fileSize: file.file_size,
              contentType: file.content_type,
              cid: file.cid,
              processingConfig: directory.processing_config,
            });
          }
        }

        // Mark message as successfully processed
        message.ack();

      } catch (error) {
        console.error(`Error processing message:`, error);
        // Message will be retried automatically
        message.retry();
      }
    }
  }
};
```

### Consumer Handler Example (Cloud Run - Python)

```python
import json
from google.cloud import storage
from typing import Dict, Any

def process_queue_message(message: Dict[str, Any], r2_client: storage.Client):
    """Process a queue message from PREPROCESS_QUEUE or BATCH_QUEUE"""

    payload = message
    batch_id = payload['batch_id']
    manifest_key = payload['manifest_r2_key']

    print(f"Processing batch {batch_id}")
    print(f"- Files: {payload['total_files']}")
    print(f"- Manifest: {manifest_key}")

    # **CRITICAL: Fetch manifest from R2**
    bucket = r2_client.bucket('arke-staging')
    blob = bucket.blob(manifest_key)
    manifest_json = blob.download_as_text()
    manifest = json.loads(manifest_json)

    print(f"Loaded manifest with {len(manifest['directories'])} directories")

    # Process each directory group
    for directory in manifest['directories']:
        print(f"Processing directory: {directory['directory_path']}")
        print(f"- Files: {directory['file_count']}")
        print(f"- Processing config: {directory['processing_config']}")

        # Process each file
        for file_info in directory['files']:
            process_file(
                r2_key=file_info['r2_key'],
                logical_path=file_info['logical_path'],
                file_name=file_info['file_name'],
                file_size=file_info['file_size'],
                content_type=file_info['content_type'],
                cid=file_info.get('cid'),
                processing_config=directory['processing_config']
            )
```

## Processing Workflow

### 1. Receive Message

The consumer receives a message from the queue when a batch is finalized (PREPROCESS_QUEUE) or when preprocessing completes (BATCH_QUEUE).

### 2. Fetch Manifest from R2

**This is the key change:** Instead of reading directories from the queue message, fetch the manifest from R2:

```typescript
// Get manifest key from queue message
const manifestKey = message.body.manifest_r2_key;

// Fetch from R2
const manifestObj = await env.STAGING_BUCKET.get(manifestKey);
const manifest: BatchManifest = await manifestObj.json();

// Now you have access to all directories and files
const directories = manifest.directories;
```

### 3. Access Files in R2

All files are stored in the `STAGING_BUCKET` R2 bucket under the `r2_prefix`:

```typescript
// Example: Read a file from R2
const object = await env.STAGING_BUCKET.get(file.r2_key);
if (object === null) {
  throw new Error(`File not found: ${file.r2_key}`);
}
const fileData = await object.arrayBuffer();
```

### 4. Process Files

Process each file according to your ingestion pipeline requirements:
- Extract metadata
- Validate file format
- Convert/transform as needed
- Store in final destination
- Update database records

### 5. Reconstruct Directory Structure

Use the `logical_path` field to reconstruct the original directory structure:

```typescript
// Root path: "/archives/2025/collection-01"
// File logical path: "/documents/subfolder/report.pdf"
// Final path: "/archives/2025/collection-01/documents/subfolder/report.pdf"

const finalPath = payload.root_path + file.logical_path;
```

### 6. Cleanup (Optional)

After successful processing, you may want to:
- Delete files from the staging bucket
- Archive the batch metadata
- Update status in a tracking database

```typescript
// Delete entire batch directory (includes all files + manifest)
// This is more efficient than deleting files one by one
const objects = await env.STAGING_BUCKET.list({ prefix: payload.r2_prefix });
for (const obj of objects.objects) {
  await env.STAGING_BUCKET.delete(obj.key);
}
```

## File Validation

All files in the queue message have been validated and meet these criteria:

### Allowed Extensions

- **Images**: `.tiff`, `.tif`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`
- **Documents**: `.json`, `.xml`, `.txt`, `.csv`, `.pdf`, `.md`

### Size Constraints

- **Per-file maximum**: 5 GB (configurable via `MAX_FILE_SIZE`)
- **Batch maximum**: 100 GB (configurable via `MAX_BATCH_SIZE`)

### Upload Verification

- All files have been successfully uploaded to R2
- All files have status `completed` in batch state
- Multipart uploads (>5 MB) have been properly finalized

## Error Handling

### Message Retry

If the consumer throws an error or calls `message.retry()`:
- Message will be retried up to `max_retries` times
- Exponential backoff is applied between retries
- After max retries, message is moved to dead letter queue (if configured)

### Dead Letter Queue

Failed messages (after max retries) will be sent to the dead letter queue for manual inspection:

```bash
# View messages in DLQ
wrangler queues consumer add arke-batch-jobs-dlq --type http --url https://your-dlq-handler.com/
```

### Idempotency

The orchestrator should be **idempotent** - processing the same message multiple times should produce the same result. Use the `batch_id` to track processed batches:

```typescript
// Check if batch was already processed
const processed = await env.DB.get(`processed:${payload.batch_id}`);
if (processed) {
  console.log(`Batch ${payload.batch_id} already processed, skipping`);
  message.ack();
  return;
}

// Process batch...

// Mark as processed
await env.DB.put(`processed:${payload.batch_id}`, Date.now().toString());
message.ack();
```

## Monitoring

### Queue Metrics

Monitor the queue in the Cloudflare dashboard:
- Message throughput
- Consumer lag
- Retry rate
- Dead letter queue size

### Logging

The orchestrator should log:
- Batch processing start/end
- Individual file processing
- Errors and retries
- Performance metrics

```typescript
console.log({
  event: 'batch_processing_complete',
  batch_id: payload.batch_id,
  file_count: payload.file_count,
  total_bytes: payload.total_bytes,
  duration_ms: endTime - startTime,
  uploader: payload.uploader,
});
```

## Testing

### Send Test Message

You can manually send a test message to the queue:

```bash
# Create a test message file
cat > test-message.json <<'EOF'
{
  "batch_id": "01K8TEST1234567890ABCDEFG",
  "r2_prefix": "staging/01K8TEST1234567890ABCDEFG/",
  "uploader": "test@arke.institute",
  "root_path": "/test/batch",
  "file_count": 1,
  "total_bytes": 1024,
  "uploaded_at": "2025-10-29T12:00:00.000Z",
  "finalized_at": "2025-10-29T12:01:00.000Z",
  "metadata": {"test": true},
  "files": [{
    "r2_key": "staging/01K8TEST1234567890ABCDEFG/test.txt",
    "logical_path": "/test.txt",
    "file_name": "test.txt",
    "file_size": 1024,
    "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
  }]
}
EOF

# Send to queue
wrangler queues producer send arke-batch-jobs --body "$(cat test-message.json)"
```

## Security Considerations

### Authentication

- Messages are internal to Cloudflare infrastructure
- No external authentication required
- Queue access is controlled via Cloudflare dashboard

### Data Privacy

- Consider encrypting sensitive metadata fields
- Rotate R2 access credentials regularly
- Implement audit logging for compliance

### Resource Limits

- Set appropriate `max_batch_size` to prevent memory exhaustion
- Implement timeouts for long-running processing
- Monitor CPU time and adjust concurrency as needed

## Migration Notes

If you're migrating from an existing system:

1. The queue is already created and configured
2. Consumer needs to be added via wrangler configuration
3. No data migration needed - queue is empty on first deployment
4. Messages are ephemeral - no historical data to migrate

## Support

For questions or issues:
- Review worker logs: `wrangler tail arke-ingest-worker`
- Check queue metrics in Cloudflare dashboard
- Inspect batch state via Durable Objects
- Contact development team with `batch_id` for debugging
