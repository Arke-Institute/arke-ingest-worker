/**
 * Validation utilities for file uploads
 */

import { ALLOWED_EXTENSIONS } from '../types';

/**
 * Validate file extension
 */
export function validateFileExtension(fileName: string): boolean {
  const ext = fileName.toLowerCase().slice(fileName.lastIndexOf('.'));
  return ALLOWED_EXTENSIONS.includes(ext as any);
}

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
