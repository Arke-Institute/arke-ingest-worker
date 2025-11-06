# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**arke-ingest-worker** is a Cloudflare Worker that orchestrates file uploads to R2 storage via presigned URLs and enqueues batch processing jobs. It acts as the ingestion pipeline's entry point, handling upload coordination and state management without ever touching file data directly.

**Key Design Principle**: Clients upload files directly to R2 using presigned URLs - the worker never processes file content, only coordinates uploads and manages state.

## Development Commands

```bash
# Install dependencies
npm install

# Run locally (starts on port 8787)
npm run dev

# Type checking
npm run typecheck

# Run tests
npm test

# Deploy to production
npm run deploy
```

## Cloudflare Setup

Before running locally or deploying, ensure these resources exist:

```bash
# Login to Cloudflare
wrangler login

# Create R2 bucket
wrangler r2 bucket create arke-staging

# Create queue
wrangler queues create arke-batch-jobs

# Set secrets (required for presigned URLs)
wrangler secret put R2_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

## Architecture

### Request Flow

1. **Initialize Batch** (`POST /api/batches/init`)
   - Client provides uploader info, file count, total size, metadata
   - Worker generates unique batch_id (ULID) and session_id
   - Creates Durable Object instance for atomic state management
   - Returns batch_id and session_id to client

2. **Get Batch Status** (`GET /api/batches/:batchId/status`)
   - Client requests current batch status and progress
   - Worker retrieves state from Durable Object
   - Returns comprehensive batch info: status, progress, file list, metadata
   - Use this to monitor upload progress or debug issues

3. **Start File Upload** (`POST /api/batches/:batchId/files/start`)
   - Client provides file_name, file_size, logical_path, content_type
   - Worker validates file extension, size, and path
   - Determines upload type: simple (<5MB) or multipart (≥5MB)
   - For multipart: creates multipart upload in R2, generates presigned URLs for each part
   - For simple: generates single presigned PUT URL
   - **Atomically** adds file to batch state via Durable Object (prevents race conditions)
   - Returns presigned URL(s) to client

4. **Client Uploads Directly to R2**
   - Client uses presigned URL(s) to upload file data directly to R2
   - Worker is not involved in this step (no bandwidth bottleneck)
   - For multipart uploads, client collects ETag from each part response

5. **Complete File Upload** (`POST /api/batches/:batchId/files/complete`)
   - Client confirms upload completion
   - For multipart: client provides upload_id and parts array with ETags
   - Worker completes multipart upload in R2 if applicable
   - **Atomically** marks file as completed in batch state
   - Returns success response

6. **Finalize Batch** (`POST /api/batches/:batchId/finalize`)
   - Client signals all files uploaded
   - Worker verifies all files are completed
   - Constructs queue message with full file manifest
   - Enqueues to Cloudflare Queue for orchestrator processing
   - Returns batch status to client

### State Management: Durable Objects (Critical Architecture)

**Why Durable Objects?** The worker previously used KV for state management, which caused **race conditions** when multiple files were uploaded concurrently. The same batch state could be read, modified, and written by multiple requests simultaneously, leading to lost file entries.

**Solution**: Durable Objects provide **single-threaded, atomic execution** for each batch. All operations on a batch's state are serialized through its Durable Object instance, eliminating race conditions entirely.

**Key Implementation Details**:
- Each batch gets its own Durable Object instance (keyed by batch_id)
- The `addFile()` method is truly atomic - no concurrent modifications possible
- The Durable Object is located in `src/durable-objects/BatchState.ts`
- Access DO instances via `getBatchStateStub()` helper in `src/lib/durable-object-helpers.ts`
- DO configuration in `wrangler.jsonc` includes SQLite storage backend via migrations

**Critical Operations**:
- `initBatch()` - Creates new batch state
- `addFile()` - Atomically adds file to batch (called during start-file)
- `completeFile()` - Atomically marks file as completed (called during complete-file)
- `getState()` - Retrieves current batch state
- `updateStatus()` - Updates batch status (e.g., to 'enqueued')

### Presigned URLs

Presigned URLs are generated using AWS Signature Version 4 via the `aws4fetch` library. Key points:

- **Simple uploads** (<5MB): Single presigned PUT URL with expiry (default 1 hour)
- **Multipart uploads** (≥5MB): Array of presigned URLs, one per part (10MB chunks)
- Presigned URL generation is in `src/lib/presigned.ts`
- Requires R2 credentials: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`

### File Validation

All uploads are validated (see `src/lib/validation.ts`):

**Allowed Extensions**:
- Images: `.tiff`, `.tif`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`
- Documents: `.json`, `.xml`, `.txt`, `.csv`, `.pdf`, `.md`

**Size Limits** (configurable in `wrangler.jsonc`):
- Max file size: 5 GB (default)
- Max batch size: 100 GB (default)
- Multipart threshold: 5 MB
- Part size: 10 MB

**Path Validation**:
- Must start with `/`
- No empty segments
- No `..` or `.` directory traversal
- No invalid characters: `< > : " | ? * \x00-\x1f`

## Project Structure

```
src/
├── handlers/              # HTTP endpoint handlers
│   ├── init-batch.ts     # POST /api/batches/init
│   ├── start-file.ts     # POST /api/batches/:id/files/start
│   ├── complete-file.ts  # POST /api/batches/:id/files/complete
│   └── finalize.ts       # POST /api/batches/:id/finalize
├── durable-objects/       # State management
│   └── BatchState.ts     # Atomic batch state DO
├── lib/                   # Utility modules
│   ├── presigned.ts      # AWS v4 signature generation
│   ├── validation.ts     # File/path validation
│   └── durable-object-helpers.ts  # DO access helpers
├── types.ts              # TypeScript type definitions
└── index.ts              # Hono app entry point
```

## Type System

All types are centralized in `src/types.ts`:

- `Env` - Environment bindings (R2, Queue, DO, secrets, config vars)
- `BatchState` - Durable Object state structure
- `FileState` - Individual file tracking within batch
- `QueueMessage` - Message format sent to orchestrator queue
- Request/Response types for each API endpoint

**Key Statuses**:
- Batch: `'uploading' | 'enqueued' | 'processing' | 'completed' | 'failed'`
- File: `'uploading' | 'completed'`
- Upload type: `'simple' | 'multipart'`

## Queue Integration

When a batch is finalized, a message is sent to the `arke-batch-jobs` Cloudflare Queue. The message format is documented in `QUEUE_MESSAGE_SPEC.md` and includes:

- Batch metadata (uploader, timestamps, file count, total bytes)
- Complete file manifest with R2 keys and logical paths
- Custom metadata passed during initialization

The orchestrator consumer should process these messages to trigger the full ingestion pipeline (OCR, LLM processing, IPFS storage, etc.).

## R2 Storage Layout

Files are stored in R2 with this structure:

```
staging/{batch_id}{logical_path}
```

Example:
- Batch ID: `01K8ABCDEFGHIJKLMNOPQRSTUV`
- Logical path: `/series_1/box_7/page_004.tiff`
- R2 key: `staging/01K8ABCDEFGHIJKLMNOPQRSTUV/series_1/box_7/page_004.tiff`

The `r2_prefix` in the queue message is always `staging/{batch_id}/`.

## Common Development Patterns

### Adding a New Handler

1. Create handler file in `src/handlers/`
2. Import types from `src/types.ts`
3. Use `getBatchStateStub()` to access Durable Object
4. Add validation using functions from `src/lib/validation.ts`
5. Register route in `src/index.ts`

### Modifying Batch State

Always use the Durable Object methods - never try to manage state directly in handlers:

```typescript
// Get DO stub
const stub = getBatchStateStub(env.BATCH_STATE_DO, batchId);

// Read state
const state = await stub.getState();

// Modify state (atomic operations)
await stub.addFile(fileState);
await stub.completeFile(r2Key, uploadId, parts);
await stub.updateStatus('enqueued', new Date().toISOString());
```

### Testing Locally

The worker runs locally with `npm run dev`, but note:
- Durable Objects work in local mode but state is ephemeral
- R2 operations require actual Cloudflare account and bucket
- Queue messages can be inspected via wrangler logs

## Configuration

All configuration is in `wrangler.jsonc`:

- `r2_buckets` - R2 binding for staging bucket
- `queues.producers` - Queue binding for batch jobs
- `durable_objects` - DO class registration
- `migrations` - DO SQLite storage setup
- `vars` - Environment variables (URL expiry, size limits)
- Secrets must be set via `wrangler secret put`

## Important Constraints

- **No file processing**: Worker never reads file content, only coordinates uploads
- **Atomic operations**: Always use Durable Object methods for state changes
- **Idempotency**: All endpoints should handle duplicate requests safely
- **24-hour TTL**: Batch state is stored in DO (no automatic expiry, but can be cleaned up)
- **Direct uploads**: Clients must upload to presigned URLs, not through worker
- **CORS**: Currently allows all origins (`*`) - restrict in production via `src/index.ts:24`

## Related Documentation

- `API.md` - Complete API reference with request/response examples
- `QUEUE_MESSAGE_SPEC.md` - Queue message format and orchestrator integration
- `README.md` - Project overview and architecture
- `SETUP.md` - Detailed setup instructions for Cloudflare resources
