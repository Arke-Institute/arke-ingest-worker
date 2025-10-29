# Arke Ingest Worker - Setup Guide

## Prerequisites

- Node.js 18+ installed
- Cloudflare account
- Wrangler CLI installed (`npm install -g wrangler`)

## Step 1: Install Dependencies

```bash
npm install
```

## Step 2: Authenticate with Cloudflare

```bash
wrangler login
```

This will open a browser window to authenticate.

## Step 3: Create R2 Bucket

```bash
wrangler r2 bucket create arke-staging
```

Verify it was created:

```bash
wrangler r2 bucket list
```

## Step 4: Create Queue

```bash
wrangler queues create arke-batch-jobs
```

## Step 5: Create KV Namespace

```bash
wrangler kv:namespace create BATCH_STATE
```

Copy the namespace ID from the output and update `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "BATCH_STATE",
    "id": "paste-namespace-id-here"  // Replace with your ID
  }
]
```

## Step 6: Create R2 API Token

1. Go to Cloudflare Dashboard > R2
2. Click "Manage R2 API Tokens"
3. Click "Create API Token"
4. Select permissions: "Object Read & Write"
5. Copy the following values:
   - Account ID
   - Access Key ID
   - Secret Access Key

## Step 7: Set Secrets

```bash
# Set R2 Account ID
wrangler secret put R2_ACCOUNT_ID
# Paste your account ID when prompted

# Set R2 Access Key ID
wrangler secret put R2_ACCESS_KEY_ID
# Paste your access key ID when prompted

# Set R2 Secret Access Key
wrangler secret put R2_SECRET_ACCESS_KEY
# Paste your secret access key when prompted
```

## Step 8: Test Locally

```bash
npm run dev
```

The worker will start at http://localhost:8787

Test the health check:

```bash
curl http://localhost:8787/
```

Expected response:

```json
{
  "service": "arke-ingest-worker",
  "version": "0.1.0",
  "status": "healthy"
}
```

## Step 9: Test API Endpoints

### Initialize a batch

```bash
curl -X POST http://localhost:8787/api/batches/init \
  -H "Content-Type: application/json" \
  -d '{
    "uploader": "Test User",
    "root_path": "/test",
    "file_count": 1,
    "total_size": 1024,
    "metadata": {"test": true}
  }'
```

Expected response:

```json
{
  "batch_id": "01K8ABCDEFGHIJKLMNOPQRSTUV",
  "session_id": "sess_01K8WXYZABCDEFGHIJKLMNOPQ"
}
```

### Start a file upload

```bash
curl -X POST http://localhost:8787/api/batches/{batch_id}/files/start \
  -H "Content-Type: application/json" \
  -d '{
    "file_name": "test.txt",
    "file_size": 1024,
    "logical_path": "/test/test.txt",
    "content_type": "text/plain"
  }'
```

Expected response (simple upload):

```json
{
  "r2_key": "staging/{batch_id}/test/test.txt",
  "upload_type": "simple",
  "presigned_url": "https://..."
}
```

## Step 10: Deploy to Production

```bash
npm run deploy
```

This will deploy the worker to Cloudflare's edge network.

Your worker will be available at: `https://arke-ingest-worker.<your-subdomain>.workers.dev`

## Step 11: Update CORS Settings (Production)

Edit `src/index.ts` and restrict CORS to your frontend domain:

```typescript
app.use('/*', cors({
  origin: 'https://your-frontend-domain.com',  // Replace with your domain
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));
```

Redeploy:

```bash
npm run deploy
```

## Architecture Overview

```
Client → Worker (Presigned URLs) → R2 Storage
                ↓
         Cloudflare Queue → Orchestrator
```

### Endpoints

- `GET /` - Health check
- `POST /api/batches/init` - Initialize batch upload
- `POST /api/batches/:id/files/start` - Get presigned URLs for file
- `POST /api/batches/:id/files/complete` - Mark file as uploaded
- `POST /api/batches/:id/finalize` - Finalize batch and enqueue

## Monitoring

View logs in real-time:

```bash
wrangler tail
```

View deployed worker details:

```bash
wrangler deployments list
```

## Troubleshooting

### Error: "Batch not found"

- Check that the KV namespace is correctly configured in `wrangler.jsonc`
- Verify the batch ID is correct
- Note: Batch state expires after 24 hours

### Error: "File extension not allowed"

- Check the `ALLOWED_EXTENSIONS` in `src/types.ts`
- Ensure the file name includes a valid extension

### Error: "File size exceeds maximum"

- Default max file size: 5 GB
- Default max batch size: 100 GB
- Adjust in `wrangler.jsonc` vars if needed

### Presigned URLs not working

- Verify R2 secrets are set correctly: `wrangler secret list`
- Check that R2 API token has "Object Read & Write" permissions
- Ensure account ID matches your Cloudflare account

## Next Steps

1. Build the CLI client to consume this API
2. Set up the orchestrator to process queue messages
3. Configure monitoring and alerting
4. Set up CI/CD for automated deployments
