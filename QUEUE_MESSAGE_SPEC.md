# Queue Message Specification

## Overview

The `arke-ingest-worker` enqueues batch upload jobs to the **`arke-batch-jobs`** Cloudflare Queue after all files in a batch have been successfully uploaded to R2. The orchestrator (consumer) should process these messages to trigger the ingestion pipeline.

## Queue Details

- **Queue Name**: `arke-batch-jobs`
- **Queue ID**: `f63fa9961c58472c995e9fe7a8d9fc4d`
- **Message Format**: JSON
- **Trigger**: Sent when `POST /api/batches/:batchId/finalize` is called after all files are uploaded

## Message Structure

### TypeScript Interface

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
  directories: DirectoryGroup[];
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

#### Top-Level Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `batch_id` | `string` | Unique batch identifier (ULID) | `"01K8RNKN488RQCG3YGG72QBZS5"` |
| `r2_prefix` | `string` | R2 bucket prefix where files are stored | `"staging/01K8RNKN488RQCG3YGG72QBZS5/"` |
| `uploader` | `string` | Identity of the user/system that uploaded the batch | `"john.doe@arke.institute"` |
| `root_path` | `string` | Logical root path for the batch | `"/archives/2025/collection-01"` |
| `parent_pi` | `string` | Parent Persistent Identifier (26-character ULID) | `"00000000000000000000000000"` |
| `total_files` | `number` | Total number of files in the batch | `5` |
| `total_bytes` | `number` | Sum of all file sizes in bytes | `5368709120` |
| `uploaded_at` | `string` | ISO 8601 timestamp when batch was created | `"2025-10-29T19:15:30.123Z"` |
| `finalized_at` | `string` | ISO 8601 timestamp when batch was finalized | `"2025-10-29T19:20:45.456Z"` |
| `metadata` | `object` | Custom metadata provided during batch initialization | `{"project": "archival-2025", "source": "scanner-01"}` |
| `directories` | `array` | Array of directory groups with processing configs | See below |

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

## Example Message

```json
{
  "batch_id": "01K8RNKN488RQCG3YGG72QBZS5",
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

## Orchestrator Consumer Implementation

### Setting Up the Consumer

The orchestrator should be configured as a consumer of the `arke-batch-jobs` queue in its `wrangler.toml`:

```toml
[[queues.consumers]]
queue = "arke-batch-jobs"
max_batch_size = 10
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "arke-batch-jobs-dlq"
```

### Consumer Handler Example

```typescript
export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = message.body;

        console.log(`Processing batch ${payload.batch_id}`);
        console.log(`- Files: ${payload.file_count}`);
        console.log(`- Total size: ${payload.total_bytes} bytes`);
        console.log(`- R2 prefix: ${payload.r2_prefix}`);

        // Process each file in the batch
        for (const file of payload.files) {
          await processFile({
            r2Key: file.r2_key,
            logicalPath: file.logical_path,
            fileName: file.file_name,
            fileSize: file.file_size,
            cid: file.cid,
          });
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

## Processing Workflow

### 1. Receive Message

The orchestrator receives a message from the queue when a batch is finalized.

### 2. Access Files in R2

All files are stored in the `STAGING_BUCKET` R2 bucket under the `r2_prefix`:

```typescript
// Example: Read a file from R2
const object = await env.STAGING_BUCKET.get(file.r2_key);
if (object === null) {
  throw new Error(`File not found: ${file.r2_key}`);
}
const fileData = await object.arrayBuffer();
```

### 3. Process Files

Process each file according to your ingestion pipeline requirements:
- Extract metadata
- Validate file format
- Convert/transform as needed
- Store in final destination
- Update database records

### 4. Reconstruct Directory Structure

Use the `logical_path` field to reconstruct the original directory structure:

```typescript
// Root path: "/archives/2025/collection-01"
// File logical path: "/documents/subfolder/report.pdf"
// Final path: "/archives/2025/collection-01/documents/subfolder/report.pdf"

const finalPath = payload.root_path + file.logical_path;
```

### 5. Cleanup (Optional)

After successful processing, you may want to:
- Delete files from the staging bucket
- Archive the batch metadata
- Update status in a tracking database

```typescript
// Delete processed files from staging
for (const file of payload.files) {
  await env.STAGING_BUCKET.delete(file.r2_key);
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
