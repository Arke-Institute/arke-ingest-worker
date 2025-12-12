/**
 * Type definitions for the arke-ingest-worker
 */

// ============================================================================
// Environment Bindings
// ============================================================================

export interface Env {
  // R2 bucket for staging files
  STAGING_BUCKET: R2Bucket;

  // Queue for preprocessing jobs (TIFF conversion, PDF splitting, etc.)
  PREPROCESS_QUEUE: Queue;

  // Queue for batch processing jobs (after preprocessing)
  BATCH_QUEUE: Queue;

  // Durable Object for tracking batch state (atomic, no race conditions)
  BATCH_STATE_DO: DurableObjectNamespace;

  // Service binding to Arke IPFS API worker
  ARKE_IPFS_API: Fetcher;

  // Service binding to Collections Worker for permission checks
  COLLECTIONS_WORKER: Fetcher;

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
  parent_pi: string;
  file_count: number;
  total_size: number;
  metadata: Record<string, any>;
  custom_prompts?: CustomPrompts;
  files: FileState[];
  status: BatchStatus;
  created_at: string;
  enqueued_at?: string;
  // Discovery state (populated during finalization)
  root_pi?: string;
  discovery_state?: DiscoveryState;
}

export type BatchStatus = 'uploading' | 'discovery' | 'preprocessing' | 'enqueued' | 'processing' | 'completed' | 'failed';

// ============================================================================
// Discovery State (Initial Discovery during finalization)
// ============================================================================

export type DiscoveryPhase = 'UPLOADING' | 'PUBLISHING' | 'RELATIONSHIPS' | 'DONE' | 'ERROR';

export interface DiscoveryTextFile {
  filename: string;
  r2_key: string;
  cid?: string; // Set after upload to IPFS
}

export interface DiscoveryNode {
  path: string;
  depth: number;
  parent_path?: string;
  children_paths: string[];
  text_files: DiscoveryTextFile[];
  published: boolean;
  relationships_set?: boolean; // True once parent_pi has been set on all children
  pi?: string;
  tip?: string;
  version?: number;
}

export interface DiscoveryState {
  nodes: Record<string, DiscoveryNode>;
  directories_total: number;
  directories_published: number;
  node_pis: Record<string, string>;
  node_tips: Record<string, string>;
  node_versions: Record<string, number>;
  phase: DiscoveryPhase;
  current_depth: number;
  // Item-level tracking
  files_total: number;
  files_uploaded: number;
  error?: string;
  retry_count?: number;
}

export interface DiscoveryResult {
  root_pi: string;
  node_pis: Record<string, string>;
  node_tips: Record<string, string>;
  node_versions: Record<string, number>;
}

// ============================================================================
// File State
// ============================================================================

export interface FileState {
  r2_key: string;
  file_name: string;
  file_size: number;
  logical_path: string;
  content_type: string;
  processing_config: ProcessingConfig;
  upload_type: UploadType;
  upload_id?: string;
  status: FileStatus;
  completed_at?: string;
  cid?: string;
}

export type UploadType = 'simple' | 'multipart';
export type FileStatus = 'uploading' | 'completed';

// ============================================================================
// Processing Configuration
// ============================================================================

export interface ProcessingConfig {
  ocr: boolean;
  describe: boolean;
  pinax: boolean;
}

// ============================================================================
// Custom Prompts
// ============================================================================

export interface CustomPrompts {
  general?: string;           // Applied to all AI service calls
  reorganization?: string;    // Phase-specific: file reorganization
  pinax?: string;             // Phase-specific: PINAX metadata extraction
  description?: string;       // Phase-specific: description generation
  cheimarros?: string;        // Phase-specific: knowledge graph extraction
}

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
  parent_pi?: string;
  custom_prompts?: CustomPrompts;
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
  cid?: string;
  processing_config: ProcessingConfig;
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
  root_pi?: string;
  discovery_progress?: {
    total: number;
    published: number;
  };
}

// GET /api/batches/:batchId/status
export interface BatchStatusResponse {
  batch_id: string;
  session_id: string;
  status: BatchStatus;
  uploader: string;
  root_path: string;
  parent_pi: string;
  file_count: number;
  files_uploaded: number;
  total_size: number;
  total_bytes_uploaded: number;
  created_at: string;
  enqueued_at?: string;
  metadata: Record<string, any>;
  custom_prompts?: CustomPrompts;
  files: BatchStatusFileInfo[];
  root_pi?: string;
  discovery_progress?: {
    total: number;
    published: number;
    phase?: string;
  };
}

export interface BatchStatusFileInfo {
  r2_key: string;
  file_name: string;
  file_size: number;
  logical_path: string;
  content_type: string;
  processing_config: ProcessingConfig;
  upload_type: UploadType;
  status: FileStatus;
  completed_at?: string;
  cid?: string;
}

// ============================================================================
// Queue Message
// ============================================================================

export interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string; // Reference to manifest stored in R2
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
  // Discovery results (from Initial Discovery phase)
  root_pi?: string;
  node_pis?: Record<string, string>;
  node_tips?: Record<string, string>;
  node_versions?: Record<string, number>;
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

export interface QueueFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
  content_type: string;
  cid?: string;
}

// ============================================================================
// Upload Configuration
// ============================================================================

export const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
export const PART_SIZE = 10 * 1024 * 1024; // 10 MB

// ============================================================================
// Preprocessing Types
// ============================================================================

// POST /api/batches/:batchId/enqueue-processed
export interface EnqueueProcessedRequest {
  files: ProcessedFileInfo[];
  // Entity tracking from Initial Discovery (passed through preprocessing)
  root_pi?: string;
  node_pis?: Record<string, string>;
  node_tips?: Record<string, string>;
  node_versions?: Record<string, number>;
}

export interface ProcessedFileInfo {
  r2_key: string;
  logical_path: string;
  file_name: string;
  file_size: number;
  content_type: string;
  cid: string;
  processing_config?: ProcessingConfig;
}

export interface EnqueueProcessedResponse {
  success: boolean;
  batch_id: string;
  status: string;
  total_files: number;
}
