import { createClient } from '@libsql/client';
// Load local .env in development. On Vercel the platform injects env vars at
// runtime. dotenv is a production dependency, so this never fails to resolve.
import 'dotenv/config';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createLibsqlPlaybackStore } from './server/playback-store.js';
import { handlePlaybackSyncRequest } from './server/playback-sync.js';

const PORT = Number(process.env.PORT || 9980);
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || 'file:./playback.db';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

const store = createLibsqlPlaybackStore(TURSO_DATABASE_URL, TURSO_AUTH_TOKEN);

// Memoized table creation so it runs once per cold start (Vercel) and before
// the first local request.
let readyPromise = null;
function ensureReady() {
  if (!readyPromise) {
    readyPromise = store.ready().catch((err) => {
      readyPromise = null;
      throw err;
    });
  }
  return readyPromise;
}

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
  const value = String(url.pathname || '/').replace(/\/+$/, '');
  return value || '/';
}

// Default export = Vercel serverless handler (Node IncomingMessage/ServerResponse).
// Also used by the local http server below.
export default async function handler(req, res) {
  try {
    await ensureReady();
    const host = req.headers.host || `localhost:${PORT}`;
    const url = new URL(req.url, `http://${host}`);
    const pathname = normalizePathname(url);

    // Keep the management endpoints outside the playback handler.
    if (pathname === '/health') {
      const usingRemote = /^libsql:|^https?:/i.test(TURSO_DATABASE_URL);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        code: 0,
        status: 'ok',
        message: 'WebHTV playback sync service is running.',
        storage: usingRemote ? 'remote' : 'local-file',
        persistent: usingRemote,
        warning: usingRemote ? '' : 'local-file storage is ephemeral on serverless platforms (Vercel); configure TURSO_DATABASE_URL for persistence'
      }));
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
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error('Playback sync request failed', error && error.stack ? error.stack : error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ ok: false, error: error && error.message ? error.message : 'Internal server error' }));
  }
}

// When run directly (`node index.js`) start a long-lived HTTP server for local
// development. On Vercel the module is imported and the default export is
// invoked per request, so we must not call listen() there.
const isMain = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
    === path.resolve(process.argv[1]).toLowerCase();

if (isMain) {
  http.createServer(handler).listen(PORT, () => {
    console.log(`WebHTV Playback Sync (libsql port) listening on http://localhost:${PORT}`);
    console.log('  sync endpoints: GET/POST /api/playback/sync , /playback/sync');
    console.log('  status:        GET /api/playback/sync/status , /playback/sync/status');
    console.log('  identity:      POST /api/playback/identity/resolve , /playback/identity/resolve');
    console.log('  reset:         DELETE /reset-db');
  });
}
