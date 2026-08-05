const express = require('express');
const { createClient } = require('@libsql/client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 9980;

// =========================================================================
// 配置
// =========================================================================
const APP_AUTH_TOKEN = process.env.APP_AUTH_TOKEN || '';
const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

// 删除墓碑保留时长：文档要求不少于 App 的 90 天
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

// =========================================================================
// Turso 客户端
// =========================================================================
let client = null;
let dbReady = null;

function getDB() {
  if (!client) {
    client = createClient({
      url: TURSO_DATABASE_URL,
      authToken: TURSO_AUTH_TOKEN
    });
  }
  return client;
}

// 建表（幂等，带版本迁移）
let dbInitDone = false;
async function migrateOldTable(c) {
  // 旧表可能缺 token 等新列，补充后再用，避免"no such column"错误
  try {
    const { rows } = await c.execute(`SELECT name FROM pragma_table_info('playback_history')`);
    const existing = new Set(rows.map(r => r.name));
    if (!existing.has('token')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
      existing.add('token');
    }
    if (!existing.has('configKey')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN configKey TEXT NOT NULL DEFAULT ''`);
      existing.add('configKey');
    }
    if (!existing.has('updatedAt')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT 0`);
      existing.add('updatedAt');
    }
    if (!existing.has('speedOverride')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN speedOverride BOOLEAN DEFAULT 0`);
      existing.add('speedOverride');
    }
    if (!existing.has('speed')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN speed REAL DEFAULT 1.0`);
      existing.add('speed');
    }
    if (!existing.has('positionMs')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN positionMs INTEGER DEFAULT 0`);
    }
    if (!existing.has('durationMs')) {
      await c.execute(`ALTER TABLE playback_history ADD COLUMN durationMs INTEGER DEFAULT 0`);
    }
  } catch (e) {
    // 表不存在等情况交给 ensureDB 处理
  }
}

async function ensureDB() {
  if (dbInitDone) return;
  const c = getDB();
  await c.execute(`CREATE TABLE IF NOT EXISTS playback_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL DEFAULT '',
    dedupeKey TEXT NOT NULL,
    configKey TEXT NOT NULL DEFAULT '',
    configName TEXT,
    siteKey TEXT,
    siteName TEXT,
    vodId TEXT,
    vodName TEXT,
    vodPic TEXT,
    flag TEXT,
    episodeName TEXT,
    episodeUrl TEXT,
    episodeIndex INTEGER,
    positionMs INTEGER DEFAULT 0,
    durationMs INTEGER DEFAULT 0,
    speed REAL DEFAULT 1.0,
    speedOverride BOOLEAN DEFAULT 0,
    completed BOOLEAN DEFAULT 0,
    cid TEXT,
    eventId TEXT,
    state TEXT,
    sessionId TEXT,
    client TEXT,
    clientKey TEXT,
    appVersion TEXT,
    updatedAt INTEGER NOT NULL,
    UNIQUE(token, dedupeKey)
  )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_ph_token_config ON playback_history(token, configKey)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_ph_updatedAt ON playback_history(token, configKey, updatedAt)`);

  // 删除墓碑表
  await c.execute(`CREATE TABLE IF NOT EXISTS tombstones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL DEFAULT '',
    configKey TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL,
    historyKey TEXT NOT NULL DEFAULT '',
    siteKey TEXT NOT NULL DEFAULT '',
    vodId TEXT NOT NULL DEFAULT '',
    deletedAt INTEGER NOT NULL,
    UNIQUE(token, configKey, scope, historyKey, siteKey, vodId)
  )`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_ts_token_config ON tombstones(token, configKey)`);
  await c.execute(`CREATE INDEX IF NOT EXISTS idx_ts_deletedAt ON tombstones(deletedAt)`);

  dbInitDone = true;
}

async function withDB(cb) {
  if (!dbReady) dbReady = ensureDB();
  await dbReady;
  const c = getDB();
  // 旧库自愈：补充缺失列，避免 "no such column" 错误
  await migrateOldTable(c);
  return cb(c);
}

// 强制重建：清空 withDB 的缓存，确保 DDL 真正执行（用于 reset-db）
async function rebuildDB() {
  dbReady = null;
  dbInitDone = false;
  const c = getDB();
  try { await c.execute(`DROP INDEX IF EXISTS idx_ph_token_config`); } catch (e) {}
  try { await c.execute(`DROP INDEX IF EXISTS idx_ph_updatedAt`); } catch (e) {}
  try { await c.execute(`DROP INDEX IF EXISTS idx_ts_token_config`); } catch (e) {}
  try { await c.execute(`DROP INDEX IF EXISTS idx_ts_deletedAt`); } catch (e) {}
  await c.execute(`DROP TABLE IF EXISTS playback_history`);
  await c.execute(`DROP TABLE IF EXISTS tombstones`);
  await ensureDB();
}

// =========================================================================
// 鉴权与请求头
// =========================================================================
function requireAuth(req, res, next) {
  const auth = req.get('X-WebHTV-Token') || '';
  if (!APP_AUTH_TOKEN) return next(); // 未配置 token 时放行（本地/测试）
  if (auth === APP_AUTH_TOKEN) return next();
  if (`Bearer ${auth}` === APP_AUTH_TOKEN) return next();
  return res.status(401).json({ code: 401, message: 'Unauthorized: invalid X-WebHTV-Token' });
}

function requireConfigKey(req, res, next) {
  const configKey = req.get('X-WebHTV-Config-Key') || (req.body && req.body.configKey) || '';
  if (!configKey) {
    return res.status(400).json({ code: 400, message: 'Missing X-WebHTV-Config-Key' });
  }
  req.configKey = configKey;
  next();
}

// =========================================================================
// 字段工具
// =========================================================================
function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function bool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true' || v === true) return true;
  if (v === 0 || v === '0' || v === 'false' || v === false) return false;
  return false;
}
function str(v) {
  return v === undefined || v === null ? null : String(v);
}

// 由 payload 派生 token + dedupeKey（命名空间以 token + configKey 区分）
function deriveKeys(req, payload) {
  const token = req.get('X-WebHTV-Token') || '';
  const configKey = (req.get('X-WebHTV-Config-Key') || payload.configKey || '').toString();
  const dedupeKey = (payload.dedupeKey || '').toString();
  return { token, configKey, dedupeKey };
}

// 把数据库行转换为远端同步项的字段模型
function rowToItem(r) {
  return {
    configKey: r.configKey,
    configName: r.configName,
    siteKey: r.siteKey,
    siteName: r.siteName,
    vodId: r.vodId,
    vodName: r.vodName,
    vodPic: r.vodPic,
    flag: r.flag,
    episodeName: r.episodeName,
    episodeUrl: r.episodeUrl,
    episodeIndex: r.episodeIndex,
    positionMs: num(r.positionMs),
    durationMs: num(r.durationMs),
    speed: num(r.speed, 1.0),
    speedOverride: bool(r.speedOverride),
    completed: bool(r.completed),
    cid: r.cid,
    state: r.state,
    sessionId: r.sessionId,
    client: r.client,
    clientKey: r.clientKey,
    appVersion: r.appVersion,
    updatedAt: num(r.updatedAt)
  };
}

// =========================================================================
// 写入/删除辅助
// =========================================================================
async function upsertHistory(c, token, dedupeKey, configKey, payload) {
  const updatedAt = num(payload.updatedAt || payload.timestamp || Date.now());
  const columns = [
    'token', 'dedupeKey', 'configKey', 'configName', 'siteKey', 'siteName',
    'vodId', 'vodName', 'vodPic', 'flag', 'episodeName', 'episodeUrl',
    'episodeIndex', 'positionMs', 'durationMs', 'speed', 'speedOverride',
    'completed', 'cid', 'eventId', 'state', 'sessionId', 'client', 'clientKey',
    'appVersion', 'updatedAt'
  ];
  const values = [
    token, dedupeKey, configKey, str(payload.configName),
    str(payload.siteKey), str(payload.siteName), str(payload.vodId),
    str(payload.vodName), str(payload.vodPic), str(payload.flag),
    str(payload.episodeName), str(payload.episodeUrl), num(payload.episodeIndex),
    num(payload.positionMs ?? payload.position ?? 0),
    num(payload.durationMs ?? payload.duration ?? 0),
    num(payload.speed, 1.0), bool(payload.speedOverride),
    bool(payload.completed), str(payload.cid), str(payload.eventId),
    str(payload.state), str(payload.sessionId), str(payload.client),
    str(payload.clientKey), str(payload.appVersion), updatedAt
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.map(c => `${c} = excluded.${c}`).join(', ');
  await c.execute({
    sql: `INSERT INTO playback_history (${columns.join(', ')}) VALUES (${placeholders})
          ON CONFLICT(token, dedupeKey) DO UPDATE SET ${updates}`,
    args: values
  });
}

async function addTombstone(c, token, configKey, scope, locator, deletedAt) {
  // null 统一转为 ''，配合列 DEFAULT '' 让空值也能参与 UNIQUE 约束
  const historyKey = locator.historyKey ? String(locator.historyKey) : '';
  const siteKey = locator.siteKey ? String(locator.siteKey) : '';
  const vodId = locator.vodId ? String(locator.vodId) : '';
  await c.execute({
    sql: `INSERT INTO tombstones (token, configKey, scope, historyKey, siteKey, vodId, deletedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(token, configKey, scope, historyKey, siteKey, vodId)
          DO UPDATE SET deletedAt = excluded.deletedAt
          WHERE excluded.deletedAt > tombstones.deletedAt`,
    args: [token, configKey, scope, historyKey, siteKey, vodId, num(deletedAt)]
  });
}

// 应用删除墓碑到数据集（物理删除 + 记录墓碑）；返回受影响条数
async function applyDelete(c, token, configKey, scope, locator, deletedAt) {
  let deleted = 0;
  if (scope === 'all') {
    const r = await c.execute(
      `DELETE FROM playback_history WHERE token = ? AND configKey = ?`,
      [token, configKey]
    );
    deleted = r.rowsAffected || 0;
  } else if (scope === 'site' || (locator.siteKey && !locator.vodId && !locator.historyKey)) {
    const r = await c.execute(
      `DELETE FROM playback_history WHERE token = ? AND configKey = ? AND siteKey = ?`,
      [token, configKey, locator.siteKey]
    );
    deleted = r.rowsAffected || 0;
  } else {
    // 单条：优先 historyKey，其次 siteKey + vodId
    if (locator.historyKey) {
      const r = await c.execute(
        `DELETE FROM playback_history WHERE token = ? AND configKey = ? AND dedupeKey = ?`,
        [token, configKey, locator.historyKey]
      );
      deleted = r.rowsAffected || 0;
    } else if (locator.siteKey && locator.vodId) {
      const r = await c.execute(
        `DELETE FROM playback_history WHERE token = ? AND configKey = ? AND siteKey = ? AND vodId = ?`,
        [token, configKey, locator.siteKey, locator.vodId]
      );
      deleted = r.rowsAffected || 0;
    }
  }
  await addTombstone(c, token, configKey, scope, locator, deletedAt);
  return deleted;
}

// =========================================================================
// Webhook 接收（POST）
// =========================================================================
async function handleWebhook(req, res) {
  try {
    const payload = req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ code: 400, message: 'Invalid JSON body' });
    }

    const { token, configKey, dedupeKey } = deriveKeys(req, payload);

    // 幂等：eventId / Idempotency-Key
    const eventId = str(payload.eventId) || req.get('X-WebHTV-Webhook-Id') || req.get('Idempotency-Key') || null;
    const dedupe = dedupeKey || eventId;
    if (!dedupe) {
      return res.status(400).json({ code: 400, message: 'Missing dedupeKey / eventId' });
    }

    const event = (payload.event || '').toString();
    const deletedAt = num(payload.deletedAt || payload.timestamp || Date.now());

    await withDB(async (c) => {
      if (event === 'playback.deleted') {
        const scope = (payload.scope || 'item').toString();
        if (scope === 'all' && !payload.historyKey && !payload.siteKey && !payload.vodId) {
          // 全量删除必须显式 scope=all，已在上面约束
        } else if (scope !== 'all' && scope !== 'site' && !payload.historyKey && !(payload.siteKey && payload.vodId)) {
          return res.status(400).json({ code: 400, message: 'Delete requires historyKey, siteKey+vodId, or scope=site/all' });
        }
        const affected = await applyDelete(c, token, configKey, scope, {
          historyKey: payload.historyKey,
          siteKey: payload.siteKey,
          vodId: payload.vodId
        }, deletedAt);
        return res.status(200).json({
          code: 0,
          action: 'deleted',
          scope,
          affected,
          localUpdatedAt: deletedAt
        });
      }

      // playback.progress / playback.ended → upsert
      await upsertHistory(c, token, dedupe, configKey, payload);
      const { rows } = await c.execute(
        `SELECT updatedAt FROM playback_history WHERE token = ? AND dedupeKey = ?`,
        [token, dedupe]
      );
      const remoteUpdatedAt = rows.length ? num(rows[0].updatedAt) : deletedAt;
      return res.status(200).json({
        code: 0,
        action: event === 'playback.ended' ? 'updated' : 'created',
        historyKey: dedupe,
        configKey,
        siteKey: payload.siteKey,
        vodId: payload.vodId,
        episodeName: payload.episodeName,
        affected: 1,
        localUpdatedAt: remoteUpdatedAt,
        remoteUpdatedAt
      });
    });
  } catch (err) {
    console.error('Webhook 处理失败:', err.message);
    res.status(500).json({ code: 500, message: `Server error: ${err.message}` });
  }
}

// =========================================================================
// 远端同步源（GET 增量）
// =========================================================================
async function handleSyncSource(req, res) {
  try {
    const token = req.get('X-WebHTV-Token') || '';
    const configKey = req.get('X-WebHTV-Config-Key') || '';
    const since = num(req.get('X-WebHTV-Since'), 0);
    const limit = Math.min(Math.max(num(req.get('X-WebHTV-Limit'), 200), 1), 1000);

    await withDB(async (c) => {
      // 普通记录增量
      const { rows: histRows } = await c.execute(
        `SELECT * FROM playback_history
         WHERE token = ? AND configKey = ? AND updatedAt > ?
         ORDER BY updatedAt ASC LIMIT ?`,
        [token, configKey, since, limit + 1]
      );
      // 未过期删除墓碑
      const cutoff = Date.now() - TOMBSTONE_TTL_MS;
      const { rows: tombRows } = await c.execute(
        `SELECT * FROM tombstones
         WHERE token = ? AND configKey = ? AND deletedAt > ? AND deletedAt > ?
         ORDER BY deletedAt ASC`,
        [token, configKey, cutoff, since]
      );

      const hasMore = histRows.length > limit;
      const items = histRows.slice(0, limit).map(rowToItem);

      const deleted = tombRows.map(t => ({
        configKey: t.configKey,
        historyKey: t.historyKey,
        siteKey: t.siteKey,
        vodId: t.vodId,
        scope: t.scope,
        deletedAt: num(t.deletedAt)
      }));

      // nextSince = 集合中最大 updatedAt/deletedAt
      let nextSince = since;
      for (const r of histRows) nextSince = Math.max(nextSince, num(r.updatedAt));
      for (const t of tombRows) nextSince = Math.max(nextSince, num(t.deletedAt));

      res.status(200).json({
        items,
        deleted,
        nextSince,
        hasMore
      });
    });
  } catch (err) {
    console.error('同步源读取失败:', err.message);
    res.status(500).json({ code: 500, message: `Server error: ${err.message}` });
  }
}

// =========================================================================
// 路由
// =========================================================================
app.use(express.json({ limit: '1mb' }));

app.options('/api/playback/sync', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers',
    'Content-Type, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name, ' +
    'X-WebHTV-Webhook-Id, X-WebHTV-Dedupe-Key, X-WebHTV-Timestamp, Idempotency-Key');
  res.status(204).end();
});

app.get('/api/playback/sync', requireAuth, requireConfigKey, handleSyncSource);
app.post('/api/playback/sync', requireAuth, requireConfigKey, handleWebhook);

// =========================================================================
// 数据库重置接口 (DELETE /reset-db)
// 删除 playback_history 与 tombstones 表并重新初始化，用于清空所有数据
// 需要携带有效的 X-WebHTV-Token（与正常鉴权一致）
// =========================================================================
app.delete('/reset-db', requireAuth, async (req, res) => {
  try {
    await rebuildDB();
    console.log('[重置] 数据库已重置，playback_history 与 tombstones 表已重建');
    res.status(200).json({
      code: 0,
      success: true,
      message: 'Database reset successfully. All playback history and tombstones have been cleared.'
    });
  } catch (err) {
    console.error('数据库重置失败:', err.message);
    res.status(500).json({ code: 500, message: `Reset failed: ${err.message}` });
  }
});

// =========================================================================
// 健康检查
// =========================================================================
app.get('/', async (req, res) => {
  try {
    await withDB(async () => {});
    res.status(200).json({ code: 0, status: 'ok', message: 'WebHTV playback sync service is running.' });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

// =========================================================================
// 404 兜底
// =========================================================================
app.use((req, res) => {
  res.status(404).json({ code: 404, message: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 WebHTV Playback Sync 服务已启动: http://localhost:${PORT}`);
  console.log(`   同步端点: GET/POST /api/playback/sync`);
  console.log(`   重置端点: DELETE /reset-db`);
});
