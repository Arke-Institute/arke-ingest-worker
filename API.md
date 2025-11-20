# API Reference

## Base URL

- **Local Dev**: `http://localhost:8787`
- **Production**: `https://ingest.arke.institute`

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
  },
  "custom_prompts": {
    "general": "All content is from 18th century scientific manuscripts.",
    "reorganization": "Group documents by subject matter rather than author.",
    "pinax": "Use Library of Congress Subject Headings when possible."
  }
}
```

**Fields:**

- `uploader` (required): Name or identifier of the person uploading
- `root_path` (required): Logical path prefix for all files in this batch
- `file_count` (required): Expected number of files to upload
- `total_size` (required): Total size in bytes of all files
- `metadata` (optional): Custom metadata object
- `parent_pi` (optional): Parent entity ULID (defaults to origin block)
- `custom_prompts` (optional): Custom AI prompts for pipeline processing
  - `general` (optional): Applied to all AI service calls (max 10,000 chars)
  - `reorganization` (optional): File organization phase (max 10,000 chars)
  - `pinax` (optional): Metadata extraction phase (max 10,000 chars)
  - `description` (optional): Description generation phase (max 10,000 chars)
  - `cheimarros` (optional): Knowledge graph extraction phase (max 10,000 chars)
  - Total maximum: 20,000 characters across all prompts

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

### 3. Get Batch Status

```
GET /api/batches/:batchId/status
```

**Description:**

Returns the current status and progress of a batch upload, including individual file states.

**Response (200):**

```json
{
  "batch_id": "01K8ABCDEFGHIJKLMNOPQRSTUV",
  "session_id": "sess_01K8WXYZABCDEFGHIJKLMNOPQ",
  "status": "uploading",
  "uploader": "Jane Doe",
  "root_path": "/series_1/box_7",
  "parent_pi": "00000000000000000000000000",
  "file_count": 47,
  "files_uploaded": 23,
  "total_size": 1234567890,
  "total_bytes_uploaded": 600000000,
  "created_at": "2025-01-29T12:30:00Z",
  "enqueued_at": null,
  "metadata": {
    "collection": "historical_records",
    "year": "1923"
  },
  "custom_prompts": {
    "general": "All content is from 18th century scientific manuscripts.",
    "reorganization": "Group documents by subject matter rather than author.",
    "pinax": "Use Library of Congress Subject Headings when possible."
  },
  "files": [
    {
      "r2_key": "staging/01K8ABCDEFGHIJKLMNOPQRSTUV/series_1/box_7/page_001.tiff",
      "file_name": "page_001.tiff",
      "file_size": 25000000,
      "logical_path": "/series_1/box_7/page_001.tiff",
      "content_type": "image/tiff",
      "processing_config": {
        "ocr": true,
        "describe": true,
        "pinax": true
      },
      "upload_type": "multipart",
      "status": "completed",
      "completed_at": "2025-01-29T12:35:00Z",
      "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"
    },
    {
      "r2_key": "staging/01K8ABCDEFGHIJKLMNOPQRSTUV/series_1/box_7/page_002.tiff",
      "file_name": "page_002.tiff",
      "file_size": 24500000,
      "logical_path": "/series_1/box_7/page_002.tiff",
      "content_type": "image/tiff",
      "processing_config": {
        "ocr": true,
        "describe": true,
        "pinax": false
      },
      "upload_type": "multipart",
      "status": "uploading",
      "cid": null
    }
  ]
}
```

**Status Values:**
- `uploading` - Files are currently being uploaded
- `enqueued` - Batch has been finalized and queued for processing
- `processing` - Orchestrator is processing the batch
- `completed` - All processing complete
- `failed` - Batch processing failed

**Error Responses:**

- `404` - Batch not found
- `500` - Internal server error

---

### 4. Start File Upload

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
  "cid": "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "processing_config": {
    "ocr": true,
    "describe": true,
    "pinax": true
  }
}
```

**Notes:**
- The `cid` (Content Identifier) field is optional.
- The `processing_config` object is required and controls downstream processing:
  - `ocr`: Enable/disable OCR processing (boolean, required)
  - `describe`: Enable/disable AI-powered description generation (boolean, required)
  - `pinax`: Enable/disable Pinax metadata generation (boolean, required, defaults to `true`)

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

### 5. Complete File Upload

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

### 6. Finalize Batch

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
  "parent_pi": "00000000000000000000000000",
  "total_files": 47,
  "total_bytes": 1234567890,
  "uploaded_at": "2025-01-29T12:30:00Z",
  "finalized_at": "2025-01-29T12:45:00Z",
  "metadata": {
    "collection": "historical_records"
  },
  "directories": [
    {
      "directory_path": "/series_1/box_7",
      "processing_config": {
        "ocr": true,
        "describe": true,
        "pinax": true
      },
      "file_count": 1,
      "total_bytes": 25000000,
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
  ]
}
```

This message is consumed by the `arke-orchestrator` for processing.
