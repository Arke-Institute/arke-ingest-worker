/**
 * Text Chunking Utility
 *
 * Implements recursive separator-based chunking that prioritizes
 * natural text boundaries (paragraphs, sentences, words) over
 * arbitrary character splits.
 */

// ============================================================================
// Types
// ============================================================================

export interface ChunkingConfig {
  /**
   * Algorithm used for chunking
   * "adaptive" = chunk size scales with file size
   * "fixed" = constant chunk size
   */
  algorithm: 'adaptive' | 'fixed';

  /**
   * Target number of chunks per file (for adaptive)
   */
  target_chunks: number;

  /**
   * Minimum chunk size in characters
   */
  min_chunk_size: number;

  /**
   * Maximum chunk size in characters
   */
  max_chunk_size: number;

  /**
   * Overlap between chunks in characters
   */
  overlap: number;
}

export interface ChunkResult {
  /**
   * Chunk identifier (e.g., "chunk_0", "chunk_1")
   */
  id: string;

  /**
   * The chunk text content
   */
  text: string;

  /**
   * Start position in original file (0-indexed)
   */
  char_start: number;

  /**
   * End position in original file (exclusive)
   */
  char_end: number;
}

export interface FileChunks {
  /**
   * Original file CID
   */
  original_cid: string;

  /**
   * Total character count of original file
   */
  total_chars: number;

  /**
   * Array of chunks (empty if file wasn't chunked)
   */
  chunks: ChunkMetadata[];
}

export interface ChunkMetadata {
  /**
   * Chunk identifier (e.g., "chunk_0", "chunk_1")
   */
  id: string;

  /**
   * CID of the chunk content
   */
  cid: string;

  /**
   * Start position in original file (0-indexed)
   */
  char_start: number;

  /**
   * End position in original file (exclusive)
   */
  char_end: number;

  /**
   * Character count of this chunk
   */
  char_count: number;
}

export interface ChunksManifest {
  /**
   * Schema version for future compatibility
   */
  version: 1;

  /**
   * Chunking configuration used to generate these chunks
   */
  config: ChunkingConfig;

  /**
   * Map of filename to file chunk metadata
   */
  files: Record<string, FileChunks>;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default chunking configuration
 */
export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  algorithm: 'adaptive',
  target_chunks: 50,
  min_chunk_size: 1000,
  max_chunk_size: 10000,
  overlap: 200,
};

/**
 * Separators in order of priority (paragraph → line → sentence → word → char)
 * Character-level splitting (empty string) is the absolute last resort.
 */
const SEPARATORS = [
  '\n\n',     // Paragraph break (highest priority)
  '\n',       // Line break
  '. ',       // Sentence end
  ', ',       // Clause break
  ' ',        // Word boundary
  '',         // Character-level (last resort)
];

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Calculate the appropriate chunk size based on file size.
 * Uses adaptive scaling to prevent chunk explosion on large files.
 */
export function calculateChunkSize(fileSize: number, config: ChunkingConfig): number {
  const { min_chunk_size, max_chunk_size, target_chunks } = config;

  // Files smaller than minimum stay as single chunk
  if (fileSize <= min_chunk_size) {
    return fileSize;
  }

  // Calculate ideal chunk size to hit target count
  const idealChunkSize = Math.ceil(fileSize / target_chunks);

  // Clamp to min/max bounds
  return Math.max(min_chunk_size, Math.min(max_chunk_size, idealChunkSize));
}

/**
 * Check if a file should be chunked based on its size.
 */
export function shouldChunk(fileSize: number, config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG): boolean {
  return fileSize >= config.min_chunk_size;
}

/**
 * Chunk text using recursive separator-based splitting.
 * Prioritizes natural text boundaries over arbitrary character splits.
 *
 * @param text - The text to chunk
 * @param config - Chunking configuration
 * @returns Array of chunk results with positions
 */
export function chunkText(
  text: string,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunkResult[] {
  // Don't chunk if below minimum size
  if (text.length < config.min_chunk_size) {
    return [];
  }

  const chunkSize = calculateChunkSize(text.length, config);
  const results = recursiveChunk(text, chunkSize, config.overlap, SEPARATORS);

  // Assign IDs to chunks
  return results.map((chunk, index) => ({
    id: `chunk_${index}`,
    text: chunk.text,
    char_start: chunk.char_start,
    char_end: chunk.char_end,
  }));
}

// ============================================================================
// Internal Chunking Logic
// ============================================================================

interface InternalChunkResult {
  text: string;
  char_start: number;
  char_end: number;
}

/**
 * Recursively chunk text using natural boundaries.
 * Tries each separator in priority order, falling back to finer
 * separators when chunks are still too large.
 */
function recursiveChunk(
  text: string,
  chunkSize: number,
  overlap: number,
  separators: string[]
): InternalChunkResult[] {
  // If text fits in one chunk, return as-is
  if (text.length <= chunkSize) {
    return [{
      text,
      char_start: 0,
      char_end: text.length,
    }];
  }

  // Try each separator in priority order
  for (let i = 0; i < separators.length; i++) {
    const separator = separators[i];
    if (separator === undefined) continue;

    const remainingSeparators = separators.slice(i + 1);

    const chunks = splitBySeparator(
      text,
      chunkSize,
      overlap,
      separator,
      remainingSeparators
    );

    if (chunks.length > 0) {
      return chunks;
    }
  }

  // Fallback: character-level split (should rarely happen)
  return characterLevelSplit(text, chunkSize, overlap);
}

/**
 * Split text by a specific separator, recursing to finer separators if needed.
 */
function splitBySeparator(
  text: string,
  chunkSize: number,
  overlap: number,
  separator: string,
  remainingSeparators: string[]
): InternalChunkResult[] {
  // Empty separator = character-level split
  if (separator === '') {
    return characterLevelSplit(text, chunkSize, overlap);
  }

  const parts = text.split(separator);

  // If no splits occurred, signal to try next separator
  if (parts.length === 1) {
    return [];
  }

  const chunks: InternalChunkResult[] = [];
  let currentChunk = '';
  let currentStart = 0;
  let position = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    const isLast = i === parts.length - 1;
    const partWithSep = isLast ? part : part + separator;

    // Check if adding this part would exceed chunk size
    const candidate = currentChunk + partWithSep;

    if (candidate.length <= chunkSize) {
      // Part fits, add to current chunk
      currentChunk = candidate;
    } else if (currentChunk.length === 0) {
      // Part alone is too big, recurse with finer separators
      if (part.length > chunkSize && remainingSeparators.length > 0) {
        const subChunks = recursiveChunk(part, chunkSize, overlap, remainingSeparators);
        for (const sub of subChunks) {
          chunks.push({
            text: sub.text,
            char_start: position + sub.char_start,
            char_end: position + sub.char_end,
          });
        }
        position += partWithSep.length;
        currentStart = position;
      } else {
        // Can't split further, take what we can (truncate if necessary)
        const truncated = partWithSep.slice(0, chunkSize);
        chunks.push({
          text: truncated,
          char_start: position,
          char_end: position + truncated.length,
        });
        position += partWithSep.length;
        currentStart = position;
      }
    } else {
      // Current chunk is full, save it and start new one
      chunks.push({
        text: currentChunk,
        char_start: currentStart,
        char_end: currentStart + currentChunk.length,
      });

      // Apply overlap: include end of previous chunk in new chunk
      const overlapText = getOverlapText(currentChunk, overlap);
      const overlapStart = currentStart + currentChunk.length - overlapText.length;

      // Start new chunk with overlap + current part
      currentStart = overlapStart;
      currentChunk = overlapText + partWithSep;

      // If the new chunk is already too big, we need to handle it
      if (currentChunk.length > chunkSize) {
        // Just use the part without overlap
        currentStart = position;
        currentChunk = partWithSep;
      }
    }

    // Track position for next iteration
    if (i < parts.length - 1) {
      position += part.length + separator.length;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk,
      char_start: currentStart,
      char_end: currentStart + currentChunk.length,
    });
  }

  return chunks;
}

/**
 * Get overlap text from end of chunk, preferring natural boundaries.
 */
function getOverlapText(chunk: string, overlap: number): string {
  if (overlap <= 0 || chunk.length <= overlap) {
    return '';
  }

  // Take last `overlap` characters
  let overlapText = chunk.slice(-overlap);

  // Try to start at a natural boundary (space)
  const spaceIndex = overlapText.indexOf(' ');
  if (spaceIndex > 0 && spaceIndex < overlap / 2) {
    overlapText = overlapText.slice(spaceIndex + 1);
  }

  return overlapText;
}

/**
 * Last resort: split at character boundaries with overlap.
 */
function characterLevelSplit(
  text: string,
  chunkSize: number,
  overlap: number
): InternalChunkResult[] {
  const chunks: InternalChunkResult[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);

    chunks.push({
      text: text.slice(start, end),
      char_start: start,
      char_end: end,
    });

    // Move forward, accounting for overlap
    const step = chunkSize - overlap;
    if (step <= 0) {
      // Prevent infinite loop if overlap >= chunkSize
      start = end;
    } else {
      start += step;
    }

    // Don't create tiny trailing chunks
    if (text.length - start < overlap && start < text.length) {
      // Extend the last chunk to include remaining text
      const lastChunk = chunks[chunks.length - 1];
      if (lastChunk) {
        lastChunk.text = text.slice(lastChunk.char_start);
        lastChunk.char_end = text.length;
      }
      break;
    }
  }

  return chunks;
}

// ============================================================================
// Manifest Building
// ============================================================================

/**
 * Build a chunks.json manifest from processed files.
 */
export function buildChunksManifest(
  files: Array<{
    filename: string;
    original_cid: string;
    total_chars: number;
    chunks: Array<{
      id: string;
      cid: string;
      char_start: number;
      char_end: number;
      char_count: number;
    }>;
  }>,
  config: ChunkingConfig = DEFAULT_CHUNKING_CONFIG
): ChunksManifest {
  const manifest: ChunksManifest = {
    version: 1,
    config,
    files: {},
  };

  for (const file of files) {
    manifest.files[file.filename] = {
      original_cid: file.original_cid,
      total_chars: file.total_chars,
      chunks: file.chunks,
    };
  }

  return manifest;
}
