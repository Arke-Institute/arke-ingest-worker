/**
 * Type definitions for the arke-ingest-worker
 */

// ============================================================================
// Environment Bindings
// ============================================================================

export interface Env {
  // R2 bucket for staging files
  STAGING_BUCKET: R2Bucket;

  // Queue for batch processing jobs
  BATCH_QUEUE: Queue;

  // KV for tracking batch state
  BATCH_STATE: KVNamespace;

  // Environment variables
  R2_ACCOUNT_ID: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  PRESIGNED_URL_EXPIRY: string;
  MAX_FILE_SIZE: string;
  MAX_BATCH_SIZE: string;
}

// ============================================================================
// Batch State Management
// ============================================================================

export interface BatchState {
  batch_id: string;
  session_id: string;
  uploader: string;
  root_path: string;
  file_count: number;
  total_size: number;
  metadata: Record<string, any>;
  files: FileState[];
  status: BatchStatus;
  created_at: string;
  enqueued_at?: string;
}

export type BatchStatus = 'uploading' | 'enqueued' | 'processing' | 'completed' | 'failed';

export interface FileState {
  r2_key: string;
  file_name: string;
  file_size: number;
  logical_path: string;
  upload_type: UploadType;
  upload_id?: string;
  status: FileStatus;
  completed_at?: string;
}

export type UploadType = 'simple' | 'multipart';
export type FileStatus = 'uploading' | 'completed';

// ============================================================================
// API Request/Response Types
// ============================================================================

// POST /api/batches/init
export interface InitBatchRequest {
  uploader: string;
  root_path: string;
  file_count: number;
  total_size: number;
  metadata?: Record<string, any>;
}

export interface InitBatchResponse {
  batch_id: string;
  session_id: string;
}

// POST /api/batches/:batchId/files/start
export interface StartFileUploadRequest {
  file_name: string;
  file_size: number;
  logical_path: string;
  content_type: string;
}

export interface StartFileUploadResponse {
  r2_key: string;
  upload_type: UploadType;
  upload_id?: string;
  part_size?: number;
  presigned_urls?: PresignedPartUrl[];
  presigned_url?: string;
}

export interface PresignedPartUrl {
  part_number: number;
  url: string;
}

// POST /api/batches/:batchId/files/complete
export interface CompleteFileUploadRequest {
  r2_key: string;
  upload_id?: string;
  parts?: CompletedPart[];
}

export interface CompletedPart {
  part_number: number;
  etag: string;
}

export interface CompleteFileUploadResponse {
  success: boolean;
}

// POST /api/batches/:batchId/finalize
export interface FinalizeBatchResponse {
  batch_id: string;
  status: string;
  files_uploaded: number;
  total_bytes: number;
  r2_prefix: string;
}

// ============================================================================
// Queue Message
// ============================================================================

export interface QueueMessage {
  batch_id: string;
  r2_prefix: string;
  uploader: string;
  root_path: string;
  file_count: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  files: QueueFileInfo[];
}

export interface QueueFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
}

// ============================================================================
// Validation
// ============================================================================

export const ALLOWED_EXTENSIONS = [
  '.tiff', '.tif',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp',
  '.json', '.xml', '.txt', '.csv',
  '.pdf'
] as const;

export const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
export const PART_SIZE = 10 * 1024 * 1024; // 10 MB
