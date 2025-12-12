#!/bin/bash
# Test with large text files (book-sized content)

set -e

BASE_URL="https://ingest.arke.institute"

echo "=== Large Text File Test ==="
echo ""

# Generate large text content (simulating book chapters)
# ~500KB each (roughly 100 pages of text)
generate_large_content() {
  local size_kb=$1
  local label=$2
  # Generate repeated lorem ipsum style content
  local base_text="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. "
  local content="$label\n\n"
  local current_size=0
  local target_size=$((size_kb * 1024))

  while [ $current_size -lt $target_size ]; do
    content="${content}${base_text}"
    current_size=$((current_size + ${#base_text}))
  done

  echo -e "$content"
}

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-large-files",
    "root_path": "/test-large-files",
    "file_count": 5,
    "total_size": 2500000,
    "metadata": {"test": "large-text-files"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
echo "Batch ID: $BATCH_ID"
echo ""

# 2. Upload large text files
echo "2. Uploading 5 large text files (~500KB each)..."

for i in 1 2 3 4 5; do
  FILE_NAME="chapter_${i}.txt"
  echo "   Generating and uploading $FILE_NAME (~500KB)..."

  # Generate content
  CONTENT=$(generate_large_content 500 "Chapter $i: The Adventure Continues")
  CONTENT_SIZE=${#CONTENT}

  # Start upload
  START_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/files/start" \
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

  if [ "$PRESIGNED_URL" == "null" ]; then
    echo "   ERROR: Failed to get presigned URL"
    echo "$START_RESPONSE" | jq .
    exit 1
  fi

  # Upload content
  echo "$CONTENT" | curl -s -X PUT "$PRESIGNED_URL" \
    -H "Content-Type: text/plain" \
    --data-binary @- > /dev/null

  # Complete
  curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null

  echo "   Uploaded $FILE_NAME ($CONTENT_SIZE bytes)"
done

echo ""

# 3. Finalize
echo "3. Finalizing batch..."
FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize")
echo "Finalize response:"
echo "$FINALIZE_RESPONSE" | jq .

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status')
ROOT_PI=$(echo $FINALIZE_RESPONSE | jq -r '.root_pi')

if [ "$STATUS" == "discovery" ]; then
  echo ""
  echo "=== Async discovery started, polling... ==="

  for i in {1..30}; do
    sleep 2
    STATUS_RESPONSE=$(curl -s "$BASE_URL/api/batches/$BATCH_ID/status")
    ROOT_PI=$(echo $STATUS_RESPONSE | jq -r '.root_pi')
    CURRENT_STATUS=$(echo $STATUS_RESPONSE | jq -r '.status')
    PHASE=$(echo $STATUS_RESPONSE | jq -r '.discovery_progress.phase // "N/A"')

    if [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ]; then
      echo ""
      echo "=== SUCCESS! ==="
      echo "Root PI: $ROOT_PI"
      echo "Total time: ~$((i * 2)) seconds"

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

  # Verify entity
  echo ""
  echo "Verifying entity..."
  ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
  COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
  echo "Components: $COMPONENT_COUNT"
else
  echo ""
  echo "Unexpected response"
fi

echo ""
echo "=== Test Complete ==="
