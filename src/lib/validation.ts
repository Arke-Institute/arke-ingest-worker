/**
 * Validation utilities for file uploads
 */

/**
 * Validate file size
 */
export function validateFileSize(size: number, maxSize: number): boolean {
  return size > 0 && size <= maxSize;
}

/**
 * Validate batch size
 */
export function validateBatchSize(size: number, maxSize: number): boolean {
  return size > 0 && size <= maxSize;
}

/**
 * Validate logical path format
 */
export function validateLogicalPath(path: string): boolean {
  // Must start with /
  if (!path.startsWith('/')) {
    return false;
  }

  // No empty segments
  const segments = path.split('/').filter(s => s.length > 0);
  if (segments.length === 0) {
    return false;
  }

  // No invalid characters (.. for directory traversal, etc.)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return false;
    }
    // Check for invalid characters
    if (/[<>:"|?*\x00-\x1f]/.test(segment)) {
      return false;
    }
  }

  return true;
}

/**
 * Validate processing config
 * Returns null if valid, error message if invalid
 */
export function validateProcessingConfig(config: any): string | null {
  if (!config || typeof config !== 'object') {
    return 'processing_config is required and must be an object';
  }

  if (typeof config.ocr !== 'boolean') {
    return 'processing_config.ocr must be a boolean';
  }

  if (typeof config.describe !== 'boolean') {
    return 'processing_config.describe must be a boolean';
  }

  if (typeof config.pinax !== 'boolean') {
    return 'processing_config.pinax must be a boolean';
  }

  return null; // Valid
}

/**
 * Validate parent PI format (26-character ULID)
 * Origin block: "00000000000000000000000000" (26 zeros)
 */
export function validateParentPi(parentPi: string): boolean {
  return /^[0-9A-Z]{26}$/.test(parentPi);
}

/**
 * Check if parent PI exists in Arke archive via service binding
 * Uses worker-to-worker communication (no external HTTP)
 * Returns true if exists (200 OK), false if not found (404)
 */
export async function checkParentPiExists(
  parentPi: string,
  ipfsApiWorker: Fetcher
): Promise<{ exists: boolean; error?: string }> {
  try {
    // Call the IPFS API worker via service binding
    const response = await ipfsApiWorker.fetch(
      new Request(`https://dummy/entities/${parentPi}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      })
    );

    if (response.ok) {
      return { exists: true };
    } else if (response.status === 404) {
      return { exists: false, error: 'Parent PI not found in archive' };
    } else {
      const errorText = await response.text();
      return { exists: false, error: `API error ${response.status}: ${errorText}` };
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return { exists: false, error: `Service binding error: ${errorMsg}` };
  }
}
