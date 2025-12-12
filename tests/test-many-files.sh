#!/bin/bash
# Test subrequest limits with many files in one directory

set -e

BASE_URL="https://ingest.arke.institute"
NUM_FILES=1000  # Testing the 1000 subrequest limit
PARALLEL_JOBS=30

echo "=== Subrequest Limit Test ($NUM_FILES files in 1 directory) ==="
echo ""

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-subrequest",
    "root_path": "/test-subrequest-limit",
    "file_count": '"$NUM_FILES"',
    "total_size": '"$((NUM_FILES * 50))"',
    "metadata": {"test": "subrequest-limit"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
echo "Batch ID: $BATCH_ID"
echo ""

# 2. Upload all files to single directory in parallel
echo "2. Uploading $NUM_FILES files to root directory ($PARALLEL_JOBS parallel jobs)..."

upload_file() {
  local i=$1
  local batch_id=$2
  local base_url=$3

  FILE_NAME="file_$(printf '%04d' $i).txt"

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
    -d "File $i content" > /dev/null

  # Complete
  curl -s -X POST "$base_url/api/batches/$batch_id/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null
}

export -f upload_file

seq 1 $NUM_FILES | xargs -P $PARALLEL_JOBS -I {} bash -c "upload_file {} $BATCH_ID $BASE_URL"

echo "   All $NUM_FILES files uploaded"
echo ""

# 3. Finalize - this is where subrequest limit matters
echo "3. Finalizing batch (this tests subrequest limits)..."
echo "   Expected: 1 directory with $NUM_FILES text files"
echo "   Subrequests needed: $NUM_FILES uploads + 1 entity creation = $((NUM_FILES + 1))"
echo ""

FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize")
echo "Response:"
echo "$FINALIZE_RESPONSE" | jq .

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status')
ROOT_PI=$(echo $FINALIZE_RESPONSE | jq -r '.root_pi')
ERROR=$(echo $FINALIZE_RESPONSE | jq -r '.error // empty')

echo ""
if [ -n "$ERROR" ]; then
  echo "=== ERROR: $ERROR ==="
elif [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
  echo "=== SUCCESS! Root PI: $ROOT_PI ==="

  # Verify entity
  echo ""
  echo "Verifying entity..."
  ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
  COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
  echo "Components in entity: $COMPONENT_COUNT"
elif [ "$STATUS" == "discovery" ]; then
  echo "=== Async discovery started, polling... ==="
  for i in {1..30}; do
    sleep 2
    STATUS_RESPONSE=$(curl -s "$BASE_URL/api/batches/$BATCH_ID/status")
    ROOT_PI=$(echo $STATUS_RESPONSE | jq -r '.root_pi')
    CURRENT_STATUS=$(echo $STATUS_RESPONSE | jq -r '.status')

    if [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
      echo "Root PI: $ROOT_PI"
      ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
      COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
      echo "Components in entity: $COMPONENT_COUNT"
      break
    fi

    if [ "$CURRENT_STATUS" == "failed" ]; then
      echo "Discovery failed!"
      curl -s "$BASE_URL/api/batches/$BATCH_ID/status" | jq .
      break
    fi

    echo "Poll $i: status=$CURRENT_STATUS"
  done
else
  echo "=== Unexpected status: $STATUS ==="
fi

echo ""
echo "=== Test Complete ==="
