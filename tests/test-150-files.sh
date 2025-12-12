#!/bin/bash
# Test async discovery with 150 files (above 100 threshold)

set -e

BASE_URL="https://ingest.arke.institute"
NUM_FILES=150
PARALLEL_JOBS=20

echo "=== Async Discovery Test ($NUM_FILES text files in 1 directory) ==="
echo ""

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-async-150",
    "root_path": "/test-async-150",
    "file_count": '"$NUM_FILES"',
    "total_size": '"$((NUM_FILES * 50))"',
    "metadata": {"test": "async-150-files"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
echo "Batch ID: $BATCH_ID"
echo ""

# 2. Upload files in parallel
echo "2. Uploading $NUM_FILES text files ($PARALLEL_JOBS parallel jobs)..."

upload_file() {
  local i=$1
  local batch_id=$2
  local base_url=$3

  FILE_NAME="file_$(printf '%03d' $i).txt"

  # Start upload
  START_RESPONSE=$(curl -s -X POST "$base_url/api/batches/$batch_id/files/start" \
    -H "Content-Type: application/json" \
    -d '{
      "file_name": "'"$FILE_NAME"'",
      "file_size": 30,
      "logical_path": "/'"$FILE_NAME"'",
      "content_type": "text/plain",
      "processing_config": {"ocr": false, "describe": false, "pinax": false}
    }')

  PRESIGNED_URL=$(echo $START_RESPONSE | jq -r '.presigned_url')
  R2_KEY=$(echo $START_RESPONSE | jq -r '.r2_key')

  # Upload content
  curl -s -X PUT "$PRESIGNED_URL" \
    -H "Content-Type: text/plain" \
    -d "File $i content for async test" > /dev/null

  # Complete
  curl -s -X POST "$base_url/api/batches/$batch_id/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null
}

export -f upload_file

seq 1 $NUM_FILES | xargs -P $PARALLEL_JOBS -I {} bash -c "upload_file {} $BATCH_ID $BASE_URL"

echo "   All $NUM_FILES files uploaded"
echo ""

# 3. Finalize - should trigger async discovery
echo "3. Finalizing batch (should use async discovery since $NUM_FILES >= 100)..."
FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize")
echo "Finalize response:"
echo "$FINALIZE_RESPONSE" | jq .

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status')

if [ "$STATUS" == "discovery" ]; then
  echo ""
  echo "=== Async discovery started, polling for completion... ==="

  for i in {1..60}; do
    sleep 2
    STATUS_RESPONSE=$(curl -s "$BASE_URL/api/batches/$BATCH_ID/status")
    ROOT_PI=$(echo $STATUS_RESPONSE | jq -r '.root_pi')
    CURRENT_STATUS=$(echo $STATUS_RESPONSE | jq -r '.status')
    PHASE=$(echo $STATUS_RESPONSE | jq -r '.discovery_progress.phase // "N/A"')
    PUBLISHED=$(echo $STATUS_RESPONSE | jq -r '.discovery_progress.published // "N/A"')
    TOTAL=$(echo $STATUS_RESPONSE | jq -r '.discovery_progress.total // "N/A"')

    if [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
      echo ""
      echo "=== SUCCESS! ==="
      echo "Root PI: $ROOT_PI"
      echo "Total polls: $i ($(($i * 2)) seconds)"

      # Verify entity
      echo ""
      echo "Verifying entity..."
      ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
      COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
      echo "Components in root entity: $COMPONENT_COUNT"
      break
    fi

    if [ "$CURRENT_STATUS" == "failed" ]; then
      echo ""
      echo "=== FAILED ==="
      curl -s "$BASE_URL/api/batches/$BATCH_ID/status" | jq '.discovery_state'
      break
    fi

    echo "Poll $i: status=$CURRENT_STATUS, phase=$PHASE, published=$PUBLISHED/$TOTAL"
  done
else
  echo ""
  echo "Unexpected status: $STATUS (expected 'discovery' for async path)"
fi

echo ""
echo "=== Test Complete ==="
