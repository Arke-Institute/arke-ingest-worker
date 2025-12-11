# arke-ingest-worker

## Purpose

Edge worker that orchestrates file uploads to R2 storage via presigned URLs, creates IPFS entities during finalization (Early Root PI), and enqueues batch processing jobs. Acts as the ingestion pipeline's entry point.

**Status**: ✅ Implementation complete (v0.2.0 - Early Root PI)

## Quick Start

```bash
# Install dependencies
npm install

# Set up Cloudflare resources (see SETUP.md)
wrangler login
wrangler r2 bucket create arke-staging
wrangler queues create arke-batch-jobs
wrangler kv:namespace create BATCH_STATE

# Run locally
npm run dev

# Deploy to production
npm run deploy
```

See [SETUP.md](./SETUP.md) for detailed setup instructions and [API.md](./API.md) for API documentation.

## Architecture

**Implementation**: Presigned URL-based uploads (client → R2 direct)

**Deployment**: Cloudflare Worker (edge network)

**Runtime**: V8 isolate, lightweight orchestrator

**Bindings**:
- R2 bucket (`STAGING_BUCKET`) - for raw file storage
- Cloudflare Queue (`PREPROCESS_QUEUE`) - for preprocessing job dispatch
- Durable Object (`BATCH_STATE_DO`) - for atomic batch state management
- Service Binding (`ARKE_IPFS_API`) - for IPFS entity creation

## Project Structure

```
arke-ingest-worker/
├── src/
│   ├── handlers/
│   │   ├── init-batch.ts      # POST /api/batches/init
│   │   ├── start-file.ts      # POST /api/batches/:id/files/start
│   │   ├── complete-file.ts   # POST /api/batches/:id/files/complete
│   │   ├── finalize.ts        # POST /api/batches/:id/finalize
│   │   └── get-status.ts      # GET /api/batches/:id/status
│   ├── durable-objects/
│   │   └── BatchState.ts      # Atomic batch state + discovery alarms
│   ├── services/
│   │   ├── initial-discovery.ts  # IPFS entity creation logic
│   │   └── ipfs-wrapper.ts       # IPFS API client
│   ├── lib/
│   │   ├── presigned.ts       # Presigned URL generation
│   │   ├── validation.ts      # Input validation
│   │   └── durable-object-helpers.ts  # DO access helpers
│   ├── types.ts               # TypeScript types
│   └── index.ts               # Hono app entry point
├── wrangler.jsonc             # Cloudflare Worker config
├── package.json
├── tsconfig.json
├── SETUP.md                   # Setup guide
├── API.md                     # API documentation
└── README.md
```

## Responsibilities

- **Upload Orchestration**
  - Generate presigned URLs for direct R2 uploads
  - Support both simple uploads (<5MB) and multipart uploads (≥5MB)
  - Validate file types, sizes, and paths
  - Track upload state atomically in Durable Objects

- **Batch Management**
  - Generate unique `batchId` (ULID)
  - Create R2 prefix: `staging/{batchId}/...`
  - Track upload metadata (uploader, timestamp, file count)
  - Maintain batch state throughout upload session
  - Support custom AI prompts for pipeline processing

- **Early Root PI (Initial Discovery)**
  - Create IPFS entities during finalization (before preprocessing)
  - Upload text files (md, txt, json, xml, csv, html) to IPFS
  - Build directory hierarchy as entity tree
  - Return `root_pi` to client immediately or via polling
  - Sync path for small batches (<50 dirs, <100 text files)
  - Async path with DO alarms for large batches

- **Job Enqueuing**
  - Verify all files completed before finalization
  - Construct batch message with complete file manifest
  - Include discovery results (root_pi, node_pis) in queue message
  - Post to preprocessing queue for further processing

## Interfaces

**Called By**: `arke-upload-cli` or `arke-ingest-ui` (upload clients)

**Calls**:
- R2 API (generate presigned URLs, manage multipart uploads, read files)
- Cloudflare Queue API (enqueue preprocessing jobs)
- Durable Object API (atomic batch state management)
- IPFS API via service binding (upload content, create entities)

**Enqueues For**: `arke-preprocessor` (queue consumer)

## Upload Flow

```
1. Client → Worker: POST /api/batches/init
   Worker → Client: {batch_id, session_id}

2. For each file:
   Client → Worker: POST /api/batches/{id}/files/start
   Worker → Client: {presigned_url(s), r2_key}

   Client → R2: PUT <presigned_url> (direct upload, bypasses worker)
   R2 → Client: {ETag}

   Client → Worker: POST /api/batches/{id}/files/complete
   Worker → R2: Complete multipart upload (if applicable)

3. Client → Worker: POST /api/batches/{id}/finalize
   Worker: Run Initial Discovery (create IPFS entities)
   Worker → Queue: Enqueue preprocessing job
   Worker → Client: {status, root_pi} (sync) or {status: "discovery"} (async)

4. (If async) Client polls: GET /api/batches/{id}/status
   Worker → Client: {status, root_pi, discovery_progress}
```

## Batch Status Flow

```
uploading → discovery → preprocessing → (downstream processing)
    │           │
    │           └── Async discovery in progress (poll for root_pi)
    │
    └── Files being uploaded to R2

Status values:
- uploading: Client is uploading files
- discovery: Initial Discovery running (creating IPFS entities)
- preprocessing: Discovery complete, batch queued for preprocessing
- failed: Discovery or other operation failed
```

## Tech Stack

- **Runtime**: Cloudflare Workers + Durable Objects
- **Language**: TypeScript
- **Framework**: Hono (lightweight web framework)
- **Storage**: Cloudflare R2
- **Queue**: Cloudflare Queues
- **State**: Durable Objects (atomic, single-threaded)
- **ID Generation**: ULID library (`ulidx`)
- **Presigned URLs**: `aws4fetch` (AWS v4 signatures)
- **IPFS**: Service binding to `arke-ipfs-api` worker

## API Endpoints

See [API.md](./API.md) for detailed documentation.

- `POST /api/batches/init` - Initialize batch
- `POST /api/batches/:id/files/start` - Get presigned URLs for file
- `POST /api/batches/:id/files/complete` - Mark file as uploaded
- `POST /api/batches/:id/finalize` - Finalize batch, run discovery, enqueue
- `GET /api/batches/:id/status` - Get batch status and root_pi

## R2 Storage Structure

```
staging/
├── {batchId_1}/
│   ├── series_1/
│   │   ├── box_7/
│   │   │   ├── folder_3/
│   │   │   │   ├── page_004.tiff
│   │   │   │   ├── page_005.tiff
│   │   │   │   └── metadata.json
│   │   │   └── ...
│   │   └── ...
│   └── ...
├── {batchId_2}/
│   └── ...
└── ...
```

## Key Features

- **Direct R2 Uploads**: Client uploads directly to R2 using presigned URLs (no worker bottleneck)
- **Multipart Support**: Handles files up to 5 GB (tested to 10 GB, theoretical max 50 TB)
- **Batch Tracking**: Durable Object-based state management for upload sessions (atomic, no race conditions)
- **Early Root PI**: IPFS entities created during finalization, root_pi available immediately or via polling
- **Scalable Discovery**: Item-level batching handles 1000+ files per directory via DO alarms
- **Validation**: File type, size, and path validation before upload
- **Custom AI Prompts**: Support for batch-specific and phase-specific AI prompt customization (see `SDK_CUSTOM_PROMPTS.md`)
- **Idempotent**: Safe to retry any operation
- **Resumable**: Multipart uploads can be resumed on failure

## Configuration

Size limits (configurable in `wrangler.jsonc`):
- **Max file size**: 5 GB (default)
- **Max batch size**: 100 GB (default)
- **Multipart threshold**: 5 MB (files ≥5MB use multipart)
- **Part size**: 10 MB (multipart chunks)

Discovery thresholds:
- **Sync discovery**: < 50 directories AND < 100 text files
- **Async discovery**: ≥ 50 directories OR ≥ 100 text files
- **Batch size**: 100 files/entities per alarm invocation

Allowed file extensions:
- Images: `.tiff`, `.tif`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`
- Documents: `.json`, `.xml`, `.txt`, `.csv`, `.pdf`, `.md`
- Text files uploaded to IPFS: `.md`, `.txt`, `.json`, `.xml`, `.csv`, `.html`, `.htm`

## Client Integration

Upload clients should:

1. **Initialize batch** - Call `POST /api/batches/init`
2. **Upload files** - For each file: start → upload to R2 → complete
3. **Finalize** - Call `POST /api/batches/:id/finalize`
4. **Get root_pi**:
   - If response contains `root_pi`: done (sync path)
   - If `status: "discovery"`: poll `GET /api/batches/:id/status` until `root_pi` appears
5. **Use root_pi** - Entity is immediately browsable at `https://arke.institute/e/{root_pi}`

Example polling logic:
```javascript
const response = await fetch(`/api/batches/${batchId}/finalize`, { method: 'POST' });
const data = await response.json();

if (data.root_pi) {
  // Sync path - root_pi available immediately
  return data.root_pi;
}

// Async path - poll for root_pi
while (true) {
  await sleep(2000);
  const status = await fetch(`/api/batches/${batchId}/status`).then(r => r.json());
  if (status.root_pi) return status.root_pi;
  if (status.status === 'failed') throw new Error('Discovery failed');
  console.log(`Discovery: ${status.discovery_progress?.phase}`);
}
```
