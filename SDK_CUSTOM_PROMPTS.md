# SDK Custom Prompts Integration Guide

This document describes what the Upload SDK needs to pass to the arke-ingest-worker for custom prompts support.

## Overview

The SDK must accept custom prompts from the application and pass them to the ingest worker during batch initialization. The prompts are then stored and forwarded through the pipeline to AI services.

## Type Definition

The SDK must define this interface:

```typescript
export interface CustomPrompts {
  general?: string;           // Applied to all AI service calls
  reorganization?: string;    // Phase-specific: file reorganization
  pinax?: string;             // Phase-specific: PINAX metadata extraction
  description?: string;       // Phase-specific: description generation
  cheimarros?: string;        // Phase-specific: knowledge graph extraction
}
```

## API Integration

### Batch Initialization Request

The SDK must include `custom_prompts` in the POST `/api/batches/init` request body:

```typescript
POST /api/batches/init

{
  "uploader": "string",
  "root_path": "string",
  "file_count": number,
  "total_size": number,
  "metadata": object,          // optional
  "parent_pi": "string",       // optional
  "custom_prompts": {          // optional
    "general": "string",       // optional
    "reorganization": "string", // optional
    "pinax": "string",         // optional
    "description": "string",   // optional
    "cheimarros": "string"     // optional
  }
}
```

### Updated SDK Interface

```typescript
export interface BatchInitOptions {
  uploader: string;
  rootPath: string;
  fileCount: number;
  totalSize: number;
  metadata?: Record<string, any>;
  parentPi?: string;
  customPrompts?: CustomPrompts;  // NEW
}
```

## Usage Example

```typescript
import { ArkeUploadClient } from '@arke/upload-sdk';

const client = new ArkeUploadClient({
  workerUrl: 'https://ingest.arke.io',
});

// Initialize batch with custom prompts
const batch = await client.initializeBatch({
  uploader: 'researcher@university.edu',
  rootPath: '/18th-century-manuscripts',
  fileCount: 50,
  totalSize: 5000000000,
  customPrompts: {
    general: 'All content is from 18th century scientific manuscripts. Use period-appropriate terminology.',
    reorganization: 'Group documents by subject matter (astronomy, biology, chemistry, physics).',
    pinax: 'Focus on extracting dates, locations, and institutional affiliations. Use Library of Congress Subject Headings.',
  },
});
```

## Validation Recommendations

The SDK should optionally validate:
- Maximum prompt length: 10,000 characters per field
- Maximum total length: 20,000 characters across all fields
- Provide clear error messages if limits exceeded

Example validation:

```typescript
function validateCustomPrompts(prompts?: CustomPrompts): void {
  if (!prompts) return;

  const MAX_PROMPT_LENGTH = 10000;
  const MAX_TOTAL_LENGTH = 20000;

  const fields: Array<keyof CustomPrompts> = [
    'general', 'reorganization', 'pinax', 'description', 'cheimarros'
  ];

  let totalLength = 0;

  for (const field of fields) {
    const value = prompts[field];
    if (value) {
      if (value.length > MAX_PROMPT_LENGTH) {
        throw new Error(`Custom prompt '${field}' exceeds maximum length of ${MAX_PROMPT_LENGTH} characters`);
      }
      totalLength += value.length;
    }
  }

  if (totalLength > MAX_TOTAL_LENGTH) {
    throw new Error(`Total custom prompts length exceeds maximum of ${MAX_TOTAL_LENGTH} characters`);
  }
}
```

## Field Descriptions

| Field | Purpose | Example Use Case |
|-------|---------|------------------|
| `general` | Applied to ALL AI service calls | "All content is from 18th century manuscripts" |
| `reorganization` | Used by arke-organizer-service | "Group by subject matter rather than author" |
| `pinax` | Used by arke-metadata-service | "Use Library of Congress Subject Headings" |
| `description` | Used by arke-description-service | "Write descriptions in scholarly, academic tone" |
| `cheimarros` | Used by arke-cheimarros-service | "Focus on extracting people and institutions" |

## Backward Compatibility

**All fields are optional.** The SDK must work correctly when:
- No `customPrompts` provided (existing behavior)
- Empty `customPrompts` object provided
- Only some fields provided (partial customization)

## Implementation Checklist

- [ ] Add `CustomPrompts` interface to SDK types
- [ ] Update `BatchInitOptions` interface with `customPrompts` field
- [ ] Update API client to serialize `custom_prompts` in request body
- [ ] Add validation function (optional but recommended)
- [ ] Update SDK documentation with examples
- [ ] Add integration tests for custom prompts
- [ ] Verify backward compatibility (SDK works without custom prompts)

## Notes

- Custom prompts are stored in the batch state and forwarded to the orchestrator
- The orchestrator merges `general` + phase-specific prompts when calling AI services
- Prompts are appended AFTER base system prompts (reduces prompt injection risk)
- Consider adding user-facing warnings about token costs when using custom prompts
