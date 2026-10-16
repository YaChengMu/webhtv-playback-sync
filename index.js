import { createClient } from '@libsql/client';
import 'dotenv/config';
import http from 'node:http';

import { createLibsqlPlaybackStore } from './server/playback-store.js';
import { handlePlaybackSyncRequest } from './server/playback-sync.js';

const PORT = Number(process.env.PORT || 9980);
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file:./playback.db';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

const store = createLibsqlPlaybackStore(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN);

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function normalizePathname(url) {
  const path = String(url.pathname || '/').replace(/\/+$/, '');
  return path || '/';
}

const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const pathname = normalizePathname(url);

    // Keep the legacy management endpoints outside the playback handler.
    if (pathname === '/health') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 0, status: 'ok', message: 'WebHTV playback sync service is running.' }));
      return;
    }
    if (req.method === 'DELETE' && pathname === '/reset-db') {
      await store.reset();
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ code: 0, success: true, message: 'Database reset successfully.' }));
      return;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value == null) continue;
      if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
      else headers.set(key, value);
    }

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
      body = await readBody(req);
    }

    const request = new Request(url, {
      method: req.method,
      headers,
      body: body !== undefined ? body : undefined
    });

    const response = await handlePlaybackSyncRequest(request, store);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    console.error('Playback sync request failed', error && error.stack ? error.stack : error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : 'Internal server error' }));
  }
});

async function start() {
  await store.ready();
  server.listen(PORT, () => {
    console.log(`WebHTV Playback Sync (libsql port) listening on http://localhost:${PORT}`);
    console.log('  sync endpoints: GET/POST / , /api/playback/sync , /playback/sync');
    console.log('  status:        GET /api/playback/sync/status , /playback/sync/status');
    console.log('  identity:      POST /api/playback/identity/resolve , /playback/identity/resolve');
    console.log('  reset:         DELETE /reset-db');
  });
}

start().catch((err) => {
  console.error('Failed to start server', err);
  process.exit(1);
});
