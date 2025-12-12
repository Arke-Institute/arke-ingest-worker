#!/bin/bash
# Test with very few but massive text files (1MB+ each)

set -e

BASE_URL="https://ingest.arke.institute"
NUM_FILES=10
SIZE_KB=1024   # 1MB each

echo "=== Mega Text File Test ==="
echo "Files: $NUM_FILES x ${SIZE_KB}KB = $((NUM_FILES * SIZE_KB / 1024))MB total"
echo ""

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-mega-files",
    "root_path": "/test-mega-files",
    "file_count": '"$NUM_FILES"',
    "total_size": '"$((NUM_FILES * SIZE_KB * 1024))"',
    "metadata": {"test": "mega-text-files"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
echo "Batch ID: $BATCH_ID"
echo ""

# 2. Upload files
echo "2. Generating and uploading $NUM_FILES files (${SIZE_KB}KB = 1MB each)..."

BASE_TEXT="Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. "

for i in $(seq 1 $NUM_FILES); do
  FILE_NAME="novel_${i}.txt"
  echo "   Generating $FILE_NAME (1MB)..."

  # Generate 1MB of content
  CONTENT="Novel $i: A Very Long Story\n\n"
  for j in $(seq 1 2200); do  # ~1MB
    CONTENT="${CONTENT}${BASE_TEXT}"
  done

  CONTENT_SIZE=${#CONTENT}
  echo "   Uploading $FILE_NAME ($((CONTENT_SIZE / 1024))KB)..."

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
  echo -e "$CONTENT" | curl -s -X PUT "$PRESIGNED_URL" \
    -H "Content-Type: text/plain" \
    --data-binary @- > /dev/null

  # Complete
  curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null

  echo "   Done with $FILE_NAME"
done

echo ""

# 3. Finalize
echo "3. Finalizing batch..."
echo "   (10 files < 100 threshold, so should use SYNC path)"
echo "   This will upload 10MB to IPFS synchronously - might timeout!"
echo ""

START_TIME=$(date +%s)
FINALIZE_RESPONSE=$(curl -s --max-time 120 -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize" 2>&1)
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "Finalize took ${ELAPSED}s"
echo "Response:"
echo "$FINALIZE_RESPONSE" | jq . 2>/dev/null || echo "$FINALIZE_RESPONSE"

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status' 2>/dev/null)
ROOT_PI=$(echo $FINALIZE_RESPONSE | jq -r '.root_pi' 2>/dev/null)

if [ "$ROOT_PI" != "null" ] && [ -n "$ROOT_PI" ] && [ "$ROOT_PI" != "" ]; then
  echo ""
  echo "=== SUCCESS! ==="
  echo "Root PI: $ROOT_PI"

  # Verify entity
  echo ""
  echo "Verifying entity..."
  ENTITY=$(curl -s "https://api.arke.institute/entities/$ROOT_PI")
  COMPONENT_COUNT=$(echo $ENTITY | jq '.components | keys | length')
  echo "Components: $COMPONENT_COUNT"
elif [ "$STATUS" == "discovery" ]; then
  echo ""
  echo "=== Async discovery started, polling... ==="
  # ... polling logic
else
  echo ""
  echo "=== Potential timeout or error ==="
  echo "Check logs for details"
fi

echo ""
echo "=== Test Complete ==="
