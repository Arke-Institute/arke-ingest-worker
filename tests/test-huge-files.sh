#!/bin/bash
# Test with very large text files (full book sized)

set -e

BASE_URL="https://ingest.arke.institute"
NUM_FILES=120  # Over 100 to trigger async
SIZE_KB=200    # 200KB each = 24MB total

echo "=== Huge Text File Test ==="
echo "Files: $NUM_FILES x ${SIZE_KB}KB = $((NUM_FILES * SIZE_KB / 1024))MB total"
echo ""

# Pre-generate base content once
BASE_TEXT="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. "

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-huge-files",
    "root_path": "/test-huge-files",
    "file_count": '"$NUM_FILES"',
    "total_size": '"$((NUM_FILES * SIZE_KB * 1024))"',
    "metadata": {"test": "huge-text-files"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
echo "Batch ID: $BATCH_ID"
echo ""

# 2. Upload files
echo "2. Uploading $NUM_FILES files (${SIZE_KB}KB each)..."

# Create temp file for content generation
TEMP_FILE=$(mktemp)
trap "rm -f $TEMP_FILE" EXIT

# Generate content template
echo "Chapter: PLACEHOLDER" > $TEMP_FILE
for j in $(seq 1 $((SIZE_KB * 2))); do
  echo "$BASE_TEXT" >> $TEMP_FILE
done

upload_file() {
  local i=$1
  local batch_id=$2
  local base_url=$3
  local temp_file=$4

  FILE_NAME="book_$(printf '%03d' $i).txt"

  # Modify temp content with unique identifier
  CONTENT="Chapter $i: The Adventure\n\n$(cat $temp_file)"
  CONTENT_SIZE=${#CONTENT}

  # Start upload
  START_RESPONSE=$(curl -s -X POST "$base_url/api/batches/$batch_id/files/start" \
    -H "Content-Type: application/json" \
    -d '{
      "file_name": "'"$FILE_NAME"'",
      "file_size": '"$CONTENT_SIZE"',
      "logical_path": "/'"$FILE_NAME"'",
      "content_type": "text/plain",
      "processing_config": {"ocr": false, "describe": false, "pinax": false}
    }')

  PRESIGNED_URL=$(echo $START_RESPONSE | jq -r '.presigned_url')
  R2_KEY=$(echo $START_RESPONSE | jq -r '.r2_key')

  # Upload content
  echo -e "$CONTENT" | curl -s -X PUT "$PRESIGNED_URL" \
    -H "Content-Type: text/plain" \
    --data-binary @- > /dev/null

  # Complete
  curl -s -X POST "$base_url/api/batches/$batch_id/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null
}

export -f upload_file
export BASE_TEXT

# Upload in parallel
seq 1 $NUM_FILES | xargs -P 10 -I {} bash -c "upload_file {} $BATCH_ID $BASE_URL $TEMP_FILE"

echo "   All $NUM_FILES files uploaded"
echo ""

# 3. Finalize
echo "3. Finalizing batch (should trigger async with $NUM_FILES files)..."
FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize")
echo "Finalize response:"
echo "$FINALIZE_RESPONSE" | jq .

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status')
ROOT_PI=$(echo $FINALIZE_RESPONSE | jq -r '.root_pi')

if [ "$STATUS" == "discovery" ]; then
  echo ""
  echo "=== Async discovery started, polling... ==="

  START_TIME=$(date +%s)
  for i in {1..120}; do
    sleep 2
    STATUS_RESPONSE=$(curl -s "$BASE_URL/api/batches/$BATCH_ID/status")
    ROOT_PI=$(echo $STATUS_RESPONSE | jq -r '.root_pi')
    CURRENT_STATUS=$(echo $STATUS_RESPONSE | jq -r '.status')
    PHASE=$(echo $STATUS_RESPONSE | jq -r '.discovery_progress.phase // "N/A"')

    if [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
      END_TIME=$(date +%s)
      ELAPSED=$((END_TIME - START_TIME))
      echo ""
      echo "=== SUCCESS! ==="
      echo "Root PI: $ROOT_PI"
      echo "Discovery time: ${ELAPSED}s"

      # Verify entity
      echo ""
      echo "Verifying entity..."
      ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
      COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
      echo "Components: $COMPONENT_COUNT"
      break
    fi

    if [ "$CURRENT_STATUS" == "failed" ]; then
      echo ""
      echo "=== FAILED ==="
      curl -s "$BASE_URL/api/batches/$BATCH_ID/status" | jq '.discovery_state'
      break
    fi

    echo "Poll $i: status=$CURRENT_STATUS, phase=$PHASE"
  done
elif [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
  echo ""
  echo "=== SUCCESS (sync)! ==="
  echo "Root PI: $ROOT_PI"
else
  echo ""
  echo "Unexpected response"
fi

echo ""
echo "=== Test Complete ==="
