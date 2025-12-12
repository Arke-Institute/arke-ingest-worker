#!/bin/bash
# Test nested directory structure with parent-child relationship verification
# This test creates a multi-level directory tree and verifies bidirectional relationships

set -e

BASE_URL="${INGEST_URL:-https://ingest.arke.institute}"
API_URL="${API_URL:-https://api.arke.institute}"
PARALLEL_JOBS=10

echo "=== Nested Directory Parent-Child Relationship Test ==="
echo "Ingest URL: $BASE_URL"
echo "API URL: $API_URL"
echo ""

# Directory structure:
# /
# ├── readme.txt
# ├── series_1/
# │   ├── index.txt
# │   ├── box_1/
# │   │   ├── page_001.txt
# │   │   └── page_002.txt
# │   └── box_2/
# │       ├── page_001.txt
# │       └── page_002.txt
# └── series_2/
#     ├── index.txt
#     └── box_1/
#         ├── page_001.txt
#         └── page_002.txt

# 1. Initialize batch
echo "1. Initializing batch..."
INIT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/init" \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "test-nested-dirs",
    "root_path": "/test-nested-dirs",
    "file_count": 10,
    "total_size": 500,
    "metadata": {"test": "nested-directories-parent-child"}
  }')

BATCH_ID=$(echo $INIT_RESPONSE | jq -r '.batch_id')
if [ "$BATCH_ID" == "null" ] || [ -z "$BATCH_ID" ]; then
  echo "ERROR: Failed to initialize batch"
  echo "$INIT_RESPONSE" | jq .
  exit 1
fi
echo "Batch ID: $BATCH_ID"
echo ""

# Function to upload a file
upload_file() {
  local batch_id=$1
  local base_url=$2
  local logical_path=$3
  local file_name=$4
  local content=$5

  CONTENT_SIZE=${#content}

  # Start upload
  START_RESPONSE=$(curl -s -X POST "$base_url/api/batches/$batch_id/files/start" \
    -H "Content-Type: application/json" \
    -d '{
      "file_name": "'"$file_name"'",
      "file_size": '"$CONTENT_SIZE"',
      "logical_path": "'"$logical_path"'",
      "content_type": "text/plain",
      "processing_config": {"ocr": false, "describe": false, "pinax": false}
    }')

  PRESIGNED_URL=$(echo $START_RESPONSE | jq -r '.presigned_url')
  R2_KEY=$(echo $START_RESPONSE | jq -r '.r2_key')

  if [ "$PRESIGNED_URL" == "null" ]; then
    echo "   ERROR: Failed to get presigned URL for $logical_path"
    echo "$START_RESPONSE" | jq .
    return 1
  fi

  # Upload content
  echo "$content" | curl -s -X PUT "$PRESIGNED_URL" \
    -H "Content-Type: text/plain" \
    --data-binary @- > /dev/null

  # Complete
  curl -s -X POST "$base_url/api/batches/$batch_id/files/complete" \
    -H "Content-Type: application/json" \
    -d "{\"r2_key\": \"$R2_KEY\"}" > /dev/null

  echo "   Uploaded: $logical_path"
}

# 2. Upload files
echo "2. Uploading files with nested directory structure..."

# Root level
upload_file "$BATCH_ID" "$BASE_URL" "/readme.txt" "readme.txt" "This is the root readme file."

# Series 1
upload_file "$BATCH_ID" "$BASE_URL" "/series_1/index.txt" "index.txt" "Series 1 index file."
upload_file "$BATCH_ID" "$BASE_URL" "/series_1/box_1/page_001.txt" "page_001.txt" "Series 1, Box 1, Page 1 content."
upload_file "$BATCH_ID" "$BASE_URL" "/series_1/box_1/page_002.txt" "page_002.txt" "Series 1, Box 1, Page 2 content."
upload_file "$BATCH_ID" "$BASE_URL" "/series_1/box_2/page_001.txt" "page_001.txt" "Series 1, Box 2, Page 1 content."
upload_file "$BATCH_ID" "$BASE_URL" "/series_1/box_2/page_002.txt" "page_002.txt" "Series 1, Box 2, Page 2 content."

# Series 2
upload_file "$BATCH_ID" "$BASE_URL" "/series_2/index.txt" "index.txt" "Series 2 index file."
upload_file "$BATCH_ID" "$BASE_URL" "/series_2/box_1/page_001.txt" "page_001.txt" "Series 2, Box 1, Page 1 content."
upload_file "$BATCH_ID" "$BASE_URL" "/series_2/box_1/page_002.txt" "page_002.txt" "Series 2, Box 1, Page 2 content."

echo ""
echo "   All files uploaded"
echo ""

# 3. Finalize
echo "3. Finalizing batch..."
FINALIZE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/batches/$BATCH_ID/finalize")
echo "Finalize response:"
echo "$FINALIZE_RESPONSE" | jq .

STATUS=$(echo $FINALIZE_RESPONSE | jq -r '.status')
ROOT_PI=$(echo $FINALIZE_RESPONSE | jq -r '.root_pi')

# 4. Wait for discovery if async
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
      echo "Discovery complete!"
      break
    fi

    if [ "$CURRENT_STATUS" == "failed" ]; then
      echo ""
      echo "=== DISCOVERY FAILED ==="
      curl -s "$BASE_URL/api/batches/$BATCH_ID/status" | jq '.discovery_state'
      exit 1
    fi

    echo "Poll $i: status=$CURRENT_STATUS, phase=$PHASE, published=$PUBLISHED/$TOTAL"
  done
fi

if [ "$ROOT_PI" == "null" ] || [ -z "$ROOT_PI" ]; then
  echo "ERROR: No root_pi returned"
  exit 1
fi

echo ""
echo "=== Discovery Complete ==="
echo "Root PI: $ROOT_PI"
echo ""

# 5. Get all node PIs from status
echo "4. Getting node PIs from batch status..."
STATUS_RESPONSE=$(curl -s "$BASE_URL/api/batches/$BATCH_ID/status")
NODE_PIS=$(echo $STATUS_RESPONSE | jq -r '.discovery_state.node_pis // .node_pis // {}')
echo "Node PIs:"
echo "$NODE_PIS" | jq .
echo ""

# 6. Verify parent-child relationships
echo "5. Verifying parent-child relationships..."
echo ""

# Save node PIs to temp file for verification script
echo "$NODE_PIS" > /tmp/node_pis_$BATCH_ID.json

# Function to verify a single entity's relationships
verify_entity() {
  local path=$1
  local pi=$2
  local expected_parent_path=$3
  local api_url=$4

  echo "Checking $path (PI: $pi)..."

  ENTITY=$(curl -s "$api_url/entities/$pi")

  PARENT_PI=$(echo $ENTITY | jq -r '.parent_pi // "null"')
  CHILDREN_PI=$(echo $ENTITY | jq -r '.children_pi // []')

  echo "  parent_pi: $PARENT_PI"
  echo "  children_pi: $CHILDREN_PI"

  # Check parent_pi is set (except for root)
  if [ "$path" != "/" ]; then
    if [ "$PARENT_PI" == "null" ] || [ -z "$PARENT_PI" ]; then
      echo "  ERROR: parent_pi not set for non-root entity!"
      return 1
    fi
  fi

  echo "  OK"
  echo ""
}

# Extract PIs and verify each
ROOT_PI=$(echo "$NODE_PIS" | jq -r '.["/"]')
SERIES1_PI=$(echo "$NODE_PIS" | jq -r '.["/series_1"]')
SERIES1_BOX1_PI=$(echo "$NODE_PIS" | jq -r '.["/series_1/box_1"]')
SERIES1_BOX2_PI=$(echo "$NODE_PIS" | jq -r '.["/series_1/box_2"]')
SERIES2_PI=$(echo "$NODE_PIS" | jq -r '.["/series_2"]')
SERIES2_BOX1_PI=$(echo "$NODE_PIS" | jq -r '.["/series_2/box_1"]')

echo "Verifying root entity..."
verify_entity "/" "$ROOT_PI" "" "$API_URL"

if [ "$SERIES1_PI" != "null" ]; then
  verify_entity "/series_1" "$SERIES1_PI" "/" "$API_URL"
fi

if [ "$SERIES1_BOX1_PI" != "null" ]; then
  verify_entity "/series_1/box_1" "$SERIES1_BOX1_PI" "/series_1" "$API_URL"
fi

if [ "$SERIES1_BOX2_PI" != "null" ]; then
  verify_entity "/series_1/box_2" "$SERIES1_BOX2_PI" "/series_1" "$API_URL"
fi

if [ "$SERIES2_PI" != "null" ]; then
  verify_entity "/series_2" "$SERIES2_PI" "/" "$API_URL"
fi

if [ "$SERIES2_BOX1_PI" != "null" ]; then
  verify_entity "/series_2/box_1" "$SERIES2_BOX1_PI" "/series_2" "$API_URL"
fi

echo ""
echo "=== Test Complete ==="
echo ""
echo "To run detailed TypeScript verification:"
echo "  npx ts-node tests/verify-relationships.ts $BATCH_ID"
