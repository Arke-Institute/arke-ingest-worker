/**
 * Arke Ingest Worker
 * Cloudflare Worker for handling file uploads to R2 via presigned URLs
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';

// Import handlers
import { handleInitBatch } from './handlers/init-batch';
import { handleStartFileUpload } from './handlers/start-file';
import { handleCompleteFileUpload } from './handlers/complete-file';
import { handleFinalizeBatch } from './handlers/finalize';

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// CORS middleware - allow uploads from any origin
// TODO: Restrict this in production to your frontend domains
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    service: 'arke-ingest-worker',
    version: '0.1.0',
    status: 'healthy',
  });
});

// API Routes
app.post('/api/batches/init', handleInitBatch);
app.post('/api/batches/:batchId/files/start', handleStartFileUpload);
app.post('/api/batches/:batchId/files/complete', handleCompleteFileUpload);
app.post('/api/batches/:batchId/finalize', handleFinalizeBatch);

// 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

// Export the app
export default app;
