# arke-ingest-worker

## Purpose

Edge worker that orchestrates file uploads to R2 storage via presigned URLs and enqueues batch processing jobs. Acts as the ingestion pipeline's entry point.

**Status**: ✅ Implementation complete (v0.1.0)

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
- Cloudflare Queue (`BATCH_QUEUE`) - for job dispatch
- KV namespace (`BATCH_STATE`) - for upload session tracking

## Project Structure

```
arke-ingest-worker/
├── src/
│   ├── handlers/
│   │   ├── init-batch.ts      # POST /api/batches/init
│   │   ├── start-file.ts      # POST /api/batches/:id/files/start
│   │   ├── complete-file.ts   # POST /api/batches/:id/files/complete
│   │   └── finalize.ts        # POST /api/batches/:id/finalize
│   ├── lib/
│   │   ├── batch-state.ts     # KV state management
│   │   ├── presigned.ts       # Presigned URL generation
│   │   └── validation.ts      # Input validation
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
  - Track upload state in KV namespace

- **Batch Management**
  - Generate unique `batchId` (ULID)
  - Create R2 prefix: `staging/{batchId}/...`
  - Track upload metadata (uploader, timestamp, file count)
  - Maintain batch state throughout upload session
  - Support custom AI prompts for pipeline processing

- **Job Enqueuing**
  - Verify all files completed before finalization
  - Construct batch message with complete file manifest
  - Post to Cloudflare Queue for orchestrator processing
  - Return batch status to client

- **Lightweight Design**
  - No file processing (OCR, LLM, IPFS, etc.)
  - Client uploads directly to R2 (worker never touches file data)
  - Pure coordination and state management

## Interfaces

**Called By**: `arke-upload-cli` or `arke-ingest-ui` (upload clients)

**Calls**:
- R2 API (generate presigned URLs, manage multipart uploads)
- Cloudflare Queue API (enqueue batch jobs)
- KV API (track batch state)

**Enqueues For**: `arke-orchestrator` (queue consumer)

## Upload Flow

```
1. Client → Worker: POST /api/batches/init
   Worker → Client: {batch_id}

2. For each file:
   Client → Worker: POST /api/batches/{id}/files/start
   Worker → Client: {presigned_urls}

   Client → R2: PUT <presigned_url> (direct upload, bypasses worker)
   R2 → Client: {ETag}

   Client → Worker: POST /api/batches/{id}/files/complete
   Worker → R2: Complete multipart upload

3. Client → Worker: POST /api/batches/{id}/finalize
   Worker → Queue: Enqueue batch job
   Worker → Client: {status: "enqueued"}
```

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript
- **Framework**: Hono (lightweight web framework)
- **Storage**: Cloudflare R2
- **Queue**: Cloudflare Queues
- **State**: Cloudflare KV
- **ID Generation**: ULID library (`ulidx`)
- **Presigned URLs**: `aws4fetch` (AWS v4 signatures)

## API Endpoints

See [API.md](./API.md) for detailed documentation.

- `POST /api/batches/init` - Initialize batch
- `POST /api/batches/:id/files/start` - Get presigned URLs for file
- `POST /api/batches/:id/files/complete` - Mark file as uploaded
- `POST /api/batches/:id/finalize` - Finalize batch and enqueue

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
- **Batch state TTL**: 24 hours

Allowed file extensions:
- Images: `.tiff`, `.tif`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`
- Documents: `.json`, `.xml`, `.txt`, `.csv`, `.pdf`

## Next Steps

1. **Deploy Worker** - Follow [SETUP.md](./SETUP.md)
2. **Build CLI Client** - Create `arke-upload-cli` to consume this API
3. **Build Orchestrator** - Create queue consumer to process batches
4. **Add Monitoring** - Set up logging, metrics, and alerts
