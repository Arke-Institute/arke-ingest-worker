#!/bin/bash
set -e

# Phase 1a Smoke Test - Verify ingest-worker creates entities with new schema
# Tests: type field, id field, backward compatible pi field

BASE_URL="https://ingest.arke.institute"
IPFS_API_URL="https://api.arke.institute"

echo "=========================================="
echo "Phase 1a Smoke Test - Ingest Worker"
echo "=========================================="
echo ""

# Step 1: Initialize batch
echo "Step 1: Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: test-user-phase1a" \
  -d '{
    "uploader": "test-user-phase1a",
    "root_path": "/test",
    "file_count": 1,
    "total_size": 50,
    "metadata": {
      "test": "phase1a-schema-test",
      "timestamp": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"
    }
  }')

BATCH_ID=$(echo "$INIT_RESPONSE" | jq -r '.batch_id')
SESSION_ID=$(echo "$INIT_RESPONSE" | jq -r '.session_id')

if [ "$BATCH_ID" == "null" ] || [ -z "$BATCH_ID" ]; then
  echo "❌ Failed to initialize batch"
  echo "$INIT_RESPONSE"
  exit 1
fi

echo "✅ Batch initialized: $BATCH_ID"
echo ""

# Step 2: Start file upload
echo "Step 2: Starting file upload..."
START_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/files/start" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SESSION_ID" \
  -d '{
    "file_name": "test-phase1a.txt",
    "file_size": 50,
    "logical_path": "/test/test-phase1a.txt",
    "content_type": "text/plain",
    "processing_config": {
      "ocr": false,
      "describe": true,
      "pinax": true
    }
  }')

PRESIGNED_URL=$(echo "$START_RESPONSE" | jq -r '.presigned_url')
R2_KEY=$(echo "$START_RESPONSE" | jq -r '.r2_key')

if [ "$PRESIGNED_URL" == "null" ]; then
  echo "❌ Failed to get presigned URL"
  echo "$START_RESPONSE"
  exit 1
fi

echo "✅ Presigned URL obtained"
echo ""

# Step 3: Upload test file
echo "Step 3: Uploading test file to R2..."
TEST_CONTENT="This is a Phase 1a schema test file. Testing type field!"

curl -s -X PUT "$PRESIGNED_URL" \
  -H "Content-Type: text/plain" \
  -d "$TEST_CONTENT" > /dev/null

echo "✅ File uploaded to R2"
echo ""

# Step 4: Complete file upload
echo "Step 4: Completing file upload..."
COMPLETE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/files/complete" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SESSION_ID" \
  -d '{
    "r2_key": "'"$R2_KEY"'"
  }')

echo "✅ File upload completed"
echo ""

# Step 5: Finalize batch
echo "Step 5: Finalizing batch..."
FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize" \
  -H "Content-Type: application/json" \
  -H "X-Session-Id: $SESSION_ID")

ROOT_PI=$(echo "$FINALIZE_RESPONSE" | jq -r '.root_pi')

if [ "$ROOT_PI" == "null" ] || [ -z "$ROOT_PI" ]; then
  echo "❌ Failed to finalize batch"
  echo "$FINALIZE_RESPONSE"
  exit 1
fi

echo "✅ Batch finalized"
echo "   Root PI: $ROOT_PI"
echo ""

# Step 6: Verify entity schema via IPFS API
echo "Step 6: Verifying entity schema..."
sleep 2  # Give IPFS wrapper a moment

ENTITY_RESPONSE=$(curl -s "$IPFS_API_URL/entities/$ROOT_PI")

# Check for required fields
ENTITY_ID=$(echo "$ENTITY_RESPONSE" | jq -r '.id')
ENTITY_PI=$(echo "$ENTITY_RESPONSE" | jq -r '.pi')
ENTITY_TYPE=$(echo "$ENTITY_RESPONSE" | jq -r '.type')
ENTITY_VER=$(echo "$ENTITY_RESPONSE" | jq -r '.ver')

echo ""
echo "=========================================="
echo "Schema Verification Results"
echo "=========================================="
echo ""

# Verify id field (new primary field)
if [ "$ENTITY_ID" == "null" ] || [ -z "$ENTITY_ID" ]; then
  echo "❌ FAIL: 'id' field missing"
  FAILED=1
else
  echo "✅ PASS: 'id' field present: $ENTITY_ID"
fi

# Verify pi field (backward compatibility)
if [ "$ENTITY_PI" == "null" ] || [ -z "$ENTITY_PI" ]; then
  echo "❌ FAIL: 'pi' field missing"
  FAILED=1
else
  echo "✅ PASS: 'pi' field present: $ENTITY_PI"
fi

# Verify type field (new required field)
if [ "$ENTITY_TYPE" != "PI" ]; then
  echo "❌ FAIL: 'type' field not 'PI', got: $ENTITY_TYPE"
  FAILED=1
else
  echo "✅ PASS: 'type' field = 'PI'"
fi

# Verify version (should be >= 1, may be higher due to relationship updates)
if [ "$ENTITY_VER" -lt "1" ]; then
  echo "❌ FAIL: Expected ver >= 1, got: $ENTITY_VER"
  FAILED=1
else
  echo "✅ PASS: Version = $ENTITY_VER (≥ 1 due to relationship updates)"
fi

echo ""
echo "Full entity response:"
echo "$ENTITY_RESPONSE" | jq '.'

echo ""
echo "=========================================="
if [ -z "$FAILED" ]; then
  echo "✅ ALL TESTS PASSED"
  echo "=========================================="
  echo ""
  echo "Phase 1a Complete!"
  echo "- Entity created with 'type: PI' field"
  echo "- New 'id' field present"
  echo "- Backward compatible 'pi' field present"
  echo "- Schema: arke/eidos@v1"
  exit 0
else
  echo "❌ SOME TESTS FAILED"
  echo "=========================================="
  exit 1
fi
