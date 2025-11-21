# Orchestrator: Custom Prompts Integration Guide

## Overview

The `arke-ingest-worker` now sends `custom_prompts` in queue messages to both:
1. **PREPROCESS_QUEUE** (`arke-preprocess-jobs`) - for Cloud Run preprocessor
2. **BATCH_QUEUE** (`arke-batch-jobs`) - for orchestrator

This guide explains the exact format the orchestrator should expect and how to use it.

---

## Queue Message Format

### Location in Message

Custom prompts are included as a **top-level field** in the queue message:

```typescript
interface QueueMessage {
  batch_id: string;
  manifest_r2_key: string;
  r2_prefix: string;
  uploader: string;
  root_path: string;
  parent_pi: string;
  total_files: number;
  total_bytes: number;
  uploaded_at: string;
  finalized_at: string;
  metadata: Record<string, any>;
  custom_prompts?: CustomPrompts;  // ← HERE
}
```

### CustomPrompts Structure

```typescript
interface CustomPrompts {
  general?: string;           // Applied to ALL AI service calls
  reorganization?: string;    // arke-organizer-service only
  pinax?: string;             // arke-metadata-service only
  description?: string;       // arke-description-service only
  cheimarros?: string;        // arke-cheimarros-service only
}
```

---

## Example Queue Message (JSON)

```json
{
  "batch_id": "01KAHTV88C21B76TF9DCV3AEPP",
  "manifest_r2_key": "staging/01KAHTV88C21B76TF9DCV3AEPP/_manifest.json",
  "r2_prefix": "staging/01KAHTV88C21B76TF9DCV3AEPP/",
  "uploader": "test",
  "root_path": "/test-2",
  "parent_pi": "00000000000000000000000000",
  "total_files": 6,
  "total_bytes": 60734,
  "uploaded_at": "2025-11-20T23:50:56.524Z",
  "finalized_at": "2025-11-20T23:51:04.937Z",
  "metadata": {
    "institution": "test-2"
  },
  "custom_prompts": {
    "general": "\"Make sure to use the style of hermann melville.\"",
    "reorganization": "\"put everything except modern indulgence into one folder and modern indulgence into its own\"",
    "pinax": "\"SET THE AUTHOR EXCLUSIVELY TO BILL BO BAGGINS (even if it is innnacurate)\"",
    "description": "\"Write your description in the guise of captain ahab\"",
    "cheimarros": "\"focus on the most controversial entities/concepts\""
  }
}
```

---

## Orchestrator Implementation

### 1. Read Custom Prompts from Queue Message

```typescript
async function processQueueMessage(message: QueueMessage) {
  const { batch_id, custom_prompts } = message;

  console.log(`Processing batch ${batch_id}`);

  // Custom prompts are optional
  if (custom_prompts) {
    console.log('Custom prompts provided:', custom_prompts);
  } else {
    console.log('No custom prompts for this batch');
  }

  // Continue with processing...
}
```

### 2. Merge Prompts for AI Service Calls

When calling each AI service, merge the `general` prompt with the phase-specific prompt:

```typescript
function buildCustomPrompt(
  customPrompts: CustomPrompts | undefined,
  phase: 'reorganization' | 'pinax' | 'description' | 'cheimarros'
): string | undefined {
  if (!customPrompts) {
    return undefined;
  }

  const parts: string[] = [];

  // Add general prompt (applies to all phases)
  if (customPrompts.general) {
    parts.push(customPrompts.general);
  }

  // Add phase-specific prompt
  const phasePrompt = customPrompts[phase];
  if (phasePrompt) {
    parts.push(phasePrompt);
  }

  // Return merged prompt (or undefined if no prompts)
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}
```

### 3. Call AI Services with Custom Prompts

#### Example: Organizer Service

```typescript
const customPrompt = buildCustomPrompt(message.custom_prompts, 'reorganization');

const response = await fetch('https://organizer.arke.institute/organize', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    directory_path: directoryPath,
    files: files,
    custom_prompt: customPrompt,  // ← Pass to service
  }),
});
```

#### Example: Metadata Service (PINAX)

```typescript
const customPrompt = buildCustomPrompt(message.custom_prompts, 'pinax');

const response = await fetch('https://metadata.arke.institute/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    directory_name: directoryName,
    files: files,
    access_url: accessUrl,
    manual_metadata: manualMetadata,
    custom_prompt: customPrompt,  // ← Pass to service
  }),
});
```

#### Example: Description Service

```typescript
const customPrompt = buildCustomPrompt(message.custom_prompts, 'description');

const response = await fetch('https://description.arke.institute/generate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    directory_name: directoryName,
    files: files,
    custom_prompt: customPrompt,  // ← Pass to service
  }),
});
```

#### Example: Cheimarros Service

```typescript
const customPrompt = buildCustomPrompt(message.custom_prompts, 'cheimarros');

const response = await fetch('https://cheimarros.arke.institute/extract', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    // ... existing fields ...
    custom_prompt: customPrompt,  // ← Pass to service
  }),
});
```

---

## Important Notes

### 1. Custom Prompts are Optional

**ALWAYS check if `custom_prompts` exists before using it:**

```typescript
// ✅ CORRECT
if (message.custom_prompts?.general) {
  // Use it
}

// ❌ WRONG - will crash if undefined
const prompt = message.custom_prompts.general;
```

### 2. Backward Compatibility

**Batches created before this feature will NOT have `custom_prompts`.** Your code must handle both cases:

```typescript
const customPrompt = buildCustomPrompt(message.custom_prompts, 'pinax');
// customPrompt will be undefined for old batches - that's fine!

await callMetadataService({
  // ... other fields ...
  custom_prompt: customPrompt,  // Service should handle undefined
});
```

### 3. Prompt Merging Strategy

For each AI service call:
1. **If `general` exists**: Include it first
2. **If phase-specific prompt exists**: Add it after `general`
3. **Separate with blank line** (`\n\n`) when both exist
4. **If neither exists**: Pass `undefined` to the service

**Example merging:**

```typescript
// Input:
custom_prompts = {
  general: "All content is from 18th century manuscripts.",
  pinax: "Use Library of Congress Subject Headings."
}

// Output for PINAX service:
"All content is from 18th century manuscripts.

Use Library of Congress Subject Headings."
```

### 4. Don't Store Prompts in Manifest

**IMPORTANT**: The `custom_prompts` field is:
- ✅ In the queue message (top-level)
- ✅ In the batch state (Durable Object)
- ❌ NOT in the R2 manifest (`_manifest.json`)

The manifest only contains file/directory info. Custom prompts come from the queue message.

---

## Testing

### Check if a Batch Has Custom Prompts

```bash
# Get batch status
curl https://ingest.arke.institute/api/batches/{BATCH_ID}/status | jq '.custom_prompts'
```

**Example output:**

```json
{
  "general": "All content is from 18th century manuscripts.",
  "pinax": "Use Library of Congress Subject Headings."
}
```

### Test Batch (with custom prompts)

Batch ID: `01KAHTV88C21B76TF9DCV3AEPP`

This batch includes all 5 custom prompt types and can be used for testing.

---

## Troubleshooting

### Issue: "Custom prompts not being used by AI services"

**Check:**
1. Does the queue message include `custom_prompts`? (Check orchestrator logs)
2. Is the orchestrator reading it from the message?
3. Is the orchestrator passing it to the AI services?
4. Are the AI services accepting the `custom_prompt` parameter?

### Issue: "Orchestrator crashes on old batches"

**Fix:** Ensure you're handling `undefined` properly:

```typescript
// ✅ Safe
const prompt = buildCustomPrompt(message.custom_prompts, 'pinax');

// ❌ Unsafe - will crash if custom_prompts is undefined
const general = message.custom_prompts.general;
```

### Issue: "Only phase-specific prompt is being used"

**Fix:** Make sure you're merging `general` with phase-specific prompts:

```typescript
// ✅ CORRECT - includes both
function buildCustomPrompt(prompts, phase) {
  const parts = [];
  if (prompts?.general) parts.push(prompts.general);
  if (prompts?.[phase]) parts.push(prompts[phase]);
  return parts.join('\n\n') || undefined;
}

// ❌ WRONG - only uses phase-specific
function buildCustomPrompt(prompts, phase) {
  return prompts?.[phase];  // Misses general!
}
```

---

## Summary

1. **Queue messages** include `custom_prompts` as a top-level optional field
2. **Orchestrator** should read it and pass merged prompts to each AI service
3. **Merging strategy**: `general` (if exists) + phase-specific (if exists)
4. **Always handle `undefined`** - old batches won't have custom prompts
5. **Not in manifest** - only in queue message and batch state

See `QUEUE_MESSAGE_SPEC.md` for the complete queue message specification.
