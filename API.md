# API Reference

## Base URL

- **Local Dev**: `http://localhost:8787`
- **Production**: `https://arke-ingest-worker.<your-subdomain>.workers.dev`

---

## Endpoints

### 1. Health Check

```
GET /
```

**Response:**

```json
{
  "service": "arke-ingest-worker",
  "version": "0.1.0",
  "status": "healthy"
}
```

---

### 2. Initialize Batch

```
POST /api/batches/init
```

**Request Body:**

```json
{
  "uploader": "Jane Doe",
  "root_path": "/series_1/box_7",
  "file_count": 47,
  "total_size": 1234567890,
  "metadata": {
    "collection": "historical_records",
    "year": "1923"
  }
}
```

**Response (201):**

```json
{
  "batch_id": "01K8ABCDEFGHIJKLMNOPQRSTUV",
  "session_id": "sess_01K8WXYZABCDEFGHIJKLMNOPQ"
}
```

**Error Responses:**

- `400` - Invalid request (missing fields, invalid paths)
- `500` - Internal server error

---

### 3. Start File Upload

```
POST /api/batches/:batchId/files/start
```

**Request Body (any file):**

```json
{
  "file_name": "page_004.tiff",
  "file_size": 25000000,
  "logical_path": "/series_1/box_7/folder_3/page_004.tiff",
  "content_type": "image/tiff",
  "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
}
```

**Note:** The `cid` (Content Identifier) field is optional.

**Response (200) - Simple Upload (<5MB):**

```json
{
  "r2_key": "staging/01K8.../series_1/box_7/metadata.json",
  "upload_type": "simple",
  "presigned_url": "https://account.r2.cloudflarestorage.com/..."
}
```

**Response (200) - Multipart Upload (≥5MB):**

```json
{
  "r2_key": "staging/01K8.../series_1/box_7/page_004.tiff",
  "upload_type": "multipart",
  "upload_id": "multipart_abc123",
  "part_size": 10485760,
  "presigned_urls": [
    {
      "part_number": 1,
      "url": "https://account.r2.cloudflarestorage.com/...?uploadId=...&partNumber=1"
    },
    {
      "part_number": 2,
      "url": "https://account.r2.cloudflarestorage.com/...?uploadId=...&partNumber=2"
    }
  ]
}
```

**Error Responses:**

- `400` - Invalid request (bad file name, size too large, invalid extension)
- `404` - Batch not found
- `500` - Internal server error

---

### 4. Complete File Upload

```
POST /api/batches/:batchId/files/complete
```

**Request Body - Simple Upload:**

```json
{
  "r2_key": "staging/01K8.../series_1/box_7/metadata.json"
}
```

**Request Body - Multipart Upload:**

```json
{
  "r2_key": "staging/01K8.../series_1/box_7/page_004.tiff",
  "upload_id": "multipart_abc123",
  "parts": [
    {
      "part_number": 1,
      "etag": "abc123def456"
    },
    {
      "part_number": 2,
      "etag": "ghi789jkl012"
    }
  ]
}
```

**Response (200):**

```json
{
  "success": true
}
```

**Error Responses:**

- `400` - Invalid request (missing parts, upload_id mismatch)
- `404` - Batch or file not found
- `500` - Internal server error

---

### 5. Finalize Batch

```
POST /api/batches/:batchId/finalize
```

**Request Body:** (empty)

**Response (200):**

```json
{
  "batch_id": "01K8ABCDEFGHIJKLMNOPQRSTUV",
  "status": "enqueued",
  "files_uploaded": 47,
  "total_bytes": 1234567890,
  "r2_prefix": "staging/01K8ABCDEFGHIJKLMNOPQRSTUV/"
}
```

**Error Responses:**

- `400` - Not all files completed, or no files uploaded
- `404` - Batch not found
- `500` - Internal server error

---

## Upload Flow

### Simple Upload (< 5MB)

1. Client calls `/batches/init` → receives `batch_id`
2. For each file:
   - Client calls `/batches/{id}/files/start` → receives `presigned_url`
   - Client uploads file directly to R2 using presigned URL (PUT request)
   - Client calls `/batches/{id}/files/complete`
3. Client calls `/batches/{id}/finalize` → batch enqueued

### Multipart Upload (≥ 5MB)

1. Client calls `/batches/init` → receives `batch_id`
2. For each file:
   - Client calls `/batches/{id}/files/start` → receives array of `presigned_urls`
   - Client splits file into chunks (10MB each)
   - For each chunk: Client uploads to corresponding presigned URL (PUT request) → receives `ETag` header
   - Client calls `/batches/{id}/files/complete` with all `{part_number, etag}` pairs
3. Client calls `/batches/{id}/finalize` → batch enqueued

---

## Validation Rules

### File Extensions

Allowed extensions (case-insensitive):

- Images: `.tiff`, `.tif`, `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`
- Documents: `.json`, `.xml`, `.txt`, `.csv`, `.pdf`

### Size Limits

- **Max file size**: 5 GB (default, configurable)
- **Max batch size**: 100 GB (default, configurable)
- **Multipart threshold**: 5 MB (files ≥5MB use multipart)
- **Part size**: 10 MB (multipart chunks)

### Path Validation

- Must start with `/`
- No empty segments
- No `..` or `.` directory traversal
- No invalid characters: `< > : " | ? * \x00-\x1f`

---

## State Management

Batch state is stored in Cloudflare KV with:

- **TTL**: 24 hours
- **Key pattern**: `batch:{batchId}`

After 24 hours, batch state expires. Complete uploads within this window.

---

## Queue Message Format

When a batch is finalized, this message is sent to `BATCH_QUEUE`:

```json
{
  "batch_id": "01K8ABCDEFGHIJKLMNOPQRSTUV",
  "r2_prefix": "staging/01K8ABCDEFGHIJKLMNOPQRSTUV/",
  "uploader": "Jane Doe",
  "root_path": "/series_1/box_7",
  "file_count": 47,
  "total_bytes": 1234567890,
  "uploaded_at": "2025-01-29T12:30:00Z",
  "finalized_at": "2025-01-29T12:45:00Z",
  "metadata": {
    "collection": "historical_records"
  },
  "files": [
    {
      "r2_key": "staging/01K8.../series_1/box_7/page_001.tiff",
      "logical_path": "/series_1/box_7/page_001.tiff",
      "file_name": "page_001.tiff",
      "file_size": 25000000,
      "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
    }
  ]
}
```

This message is consumed by the `arke-orchestrator` for processing.
