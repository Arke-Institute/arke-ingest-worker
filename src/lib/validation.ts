/**
 * Validation utilities for file uploads
 */

import type { CustomPrompts } from '../types';

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

/**
 * Validate custom prompts
 * Returns null if valid, error message if invalid
 */
export function validateCustomPrompts(customPrompts: CustomPrompts | undefined): string | null {
  if (!customPrompts) {
    return null; // Optional field
  }

  const MAX_PROMPT_LENGTH = 60000;  // 60KB per field - supports metadata file uploads
  const MAX_TOTAL_LENGTH = 80000;   // 80KB total - slightly more permissive than SDK

  const fields: Array<keyof CustomPrompts> = [
    'general',
    'reorganization',
    'pinax',
    'description',
    'cheimarros'
  ];

  let totalLength = 0;

  for (const field of fields) {
    const value = customPrompts[field];
    if (value !== undefined) {
      if (typeof value !== 'string') {
        return `custom_prompts.${field} must be a string`;
      }

      if (value.length > MAX_PROMPT_LENGTH) {
        return `custom_prompts.${field} exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`;
      }

      totalLength += value.length;
    }
  }

  if (totalLength > MAX_TOTAL_LENGTH) {
    return `Total custom prompts length (${totalLength}) exceeds maximum of ${MAX_TOTAL_LENGTH} characters`;
  }

  return null; // Valid
}

/**
 * Permission check response from collections worker
 */
export interface PiPermissions {
  pi: string;
  canView: boolean;
  canEdit: boolean;
  canAdminister: boolean;
  collection: {
    id: string;
    title: string;
    slug: string;
    visibility: string;
    role: string | null;
    rootPi: string;
    hops: number;
  } | null;
}

/**
 * Check if user has permission to upload to a parent PI
 * Uses worker-to-worker communication via service binding
 *
 * Returns:
 * - { allowed: true } if user can edit the PI
 * - { allowed: false, error: string } if permission denied
 */
export async function checkUploadPermission(
  parentPi: string,
  userId: string,
  collectionsWorker: Fetcher
): Promise<{ allowed: boolean; error?: string }> {
  try {
    // Call the collections worker via service binding
    // Only X-User-Id is required for authentication
    const response = await collectionsWorker.fetch(
      new Request(`https://internal/pi/${parentPi}/permissions`, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-User-Id': userId,
        }
      })
    );

    if (!response.ok) {
      const errorText = await response.text();
      return {
        allowed: false,
        error: `Permission check failed: ${response.status} - ${errorText}`
      };
    }

    const permissions: PiPermissions = await response.json();

    // canEdit is true for:
    // 1. "Free" PIs (not in any collection) - collection is null
    // 2. Users with owner or editor role on the collection
    if (permissions.canEdit) {
      return { allowed: true };
    }

    // Build descriptive error message
    if (permissions.collection) {
      const role = permissions.collection.role || 'none';
      return {
        allowed: false,
        error: `Permission denied: You need editor or owner role on collection "${permissions.collection.title}" (current role: ${role})`
      };
    }

    // Shouldn't reach here (free PIs should have canEdit=true), but handle defensively
    return {
      allowed: false,
      error: 'Permission denied: Unable to determine edit access'
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    return {
      allowed: false,
      error: `Permission check error: ${errorMsg}`
    };
  }
}
