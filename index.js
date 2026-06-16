const express = require('express');

if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

// =========================================================================
// Turso 客户端懒加载（Vercel serverless 兼容）
// =========================================================================
let db = null;
let dbInitDone = false;

function getDB() {
    if (!db) {
        const { createClient } = require('@libsql/client');
        db = createClient({
            url: process.env.TURSO_DATABASE_URL,
            authToken: process.env.TURSO_AUTH_TOKEN,
        });
    }
    return db;
}

const app = express();
const PORT = process.env.PORT || 9980;
const APP_AUTH_TOKEN = process.env.APP_AUTH_TOKEN;

app.use(express.json({ limit: '2mb' }));

// =========================================================================
// 全流量参数与上下文监视器
// =========================================================================
app.use((req, res, next) => {
    const startTime = Date.now();

    const originalJson = res.json;
    let capturedResponseBody = null;
    res.json = function (body) {
        capturedResponseBody = body;
        return originalJson.call(this, body);
    };

    res.on('finish', () => {
        const duration = Date.now() - startTime;
        const statusCode = res.statusCode;

        let statusIcon = '[成功放行]';
        if (statusCode === 401) statusIcon = '[鉴权拦截]';
        if (statusCode === 404) statusIcon = '[路径未找到/404]';
        if (statusCode >= 500) statusIcon = '[服务端崩溃/500]';

        console.log(`\n======================================================================`);
        console.log(`访问端点: ${req.method} ${req.originalUrl || req.url}`);
        console.log(`响应耗时: ${duration}ms  |  状态码: ${statusCode}  |  结果: ${statusIcon}`);

        if (req.query && Object.keys(req.query).length > 0) {
            console.log(JSON.stringify(req.query, null, 2));
        } else {
            console.log("    (None)");
        }

        console.log(`\n[Headers] >>>`);
        console.log(`   x-webhtv-token:       "${req.headers['x-webhtv-token'] || '未携带'}"`);
        console.log(`   x-webhtv-config-key:  "${req.headers['x-webhtv-config-key'] || '未携带'}"`);
        console.log(`   x-webhtv-config-name: "${req.headers['x-webhtv-config-name'] || '未携带'}"`);
        console.log(`   x-webhtv-timestamp:   "${req.headers['x-webhtv-timestamp'] || '未携带'}"`);
        console.log(`   x-webhtv-webhook-id:  "${req.headers['x-webhtv-webhook-id'] || '未携带'}"`);
        console.log(`   x-webhtv-dedupe-key:  "${req.headers['x-webhtv-dedupe-key'] || '未携带'}"`);
        console.log(`   idempotency-key:      "${req.headers['idempotency-key'] || '未携带'}"`);

        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
            console.log(`\n[收到原始数据 (Request Body)] >>>`);
            console.log(JSON.stringify(req.body || {}, null, 2));
        }

        console.log(`\n[返回原始数据 (Response Body)] >>>`);
        if (capturedResponseBody) {
            const jsonString = JSON.stringify(capturedResponseBody, null, 2);
            console.log(jsonString.length > 2000 ? jsonString.substring(0, 2000) + `\n\n... (省略 ${jsonString.length - 2000} 字)` : jsonString);
        } else {
            console.log(`   (无 JSON 响应体)`);
        }
        console.log(`======================================================================`);
    });

    next();
});

// =========================================================================
// 🛡️ 鉴权中心
// =========================================================================
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Token, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name, X-WebHTV-Webhook-Id, X-WebHTV-Dedupe-Key, X-WebHTV-Timestamp, Idempotency-Key');

    if (req.method === 'OPTIONS') return res.sendStatus(204);

    const rawHeaders = req.headers;
    let clientToken = '';

    // 按文档协议：App 通过 X-WebHTV-Token header 发送 token
    const possibleKeys = ['x-webhtv-token', 'x-sync-token', 'authorization'];
    for (const key of possibleKeys) {
        if (rawHeaders[key]) { clientToken = String(rawHeaders[key]).trim(); break; }
        if (rawHeaders[key.toUpperCase()]) { clientToken = String(rawHeaders[key.toUpperCase()]).trim(); break; }
    }
    if (!clientToken) {
        clientToken = req.query.token || req.query.X_WebHTV_Token || '';
        clientToken = String(clientToken).trim();
    }

    const expectedToken = String(APP_AUTH_TOKEN || '').trim();
    if (expectedToken && clientToken !== expectedToken) {
        return res.status(401).json({ code: 401, message: "Unauthorized: Token Mismatch" });
    }

    next();
});

// =========================================================================
// 远端同步源端点 (GET /)
// 文档 13.4.4：App 发送 GET，带 X-WebHTV-Token、X-WebHTV-Config-Key、X-WebHTV-Config-Name
// 返回 { "items": [...], "nextSince": ... } 格式
// =========================================================================
app.get('/', async (req, res) => {
    const configKey = (req.headers['x-webhtv-config-key'] || '').trim();
    const configName = (req.headers['x-webhtv-config-name'] || '').trim();
    const token = (req.headers['x-webhtv-token'] || '').trim();

    console.log(`\n[远端同步请求] configKey="${configKey}" configName="${configName}" token="${token ? token.substring(0,8)+'...' : '(无)'}"`);

    try {
        await ensureDB();
        const safeSql = `
            SELECT 
                coalesce(dedupeKey, '') as dedupeKey,
                coalesce(configKey, '') as configKey,
                coalesce(configName, '') as configName,
                coalesce(siteKey, '') as siteKey,
                coalesce(siteName, '') as siteName,
                coalesce(vodId, '') as vodId,
                coalesce(vodPic, '') as vodPic,
                coalesce(vodName, '未知视频') as vodName,
                coalesce(flag, '') as flag,
                coalesce(episodeName, '') as episodeName,
                coalesce(episodeUrl, '') as episodeUrl,
                coalesce(sessionId, '') as sessionId,
                coalesce(state, '') as state,
                coalesce(progress, 0.0) as progress,
                coalesce(revSort, 0) as revSort,
                coalesce(revPlay, 0) as revPlay,
                coalesce(createTime, 0) as createTime,
                coalesce(opening, 0) as opening,
                coalesce(ending, 0) as ending,
                coalesce(position, 0) as position,
                coalesce(duration, 0) as duration,
                coalesce(speed, 1.0) as speed,
                coalesce(scale, 0) as scale,
                coalesce(cid, 0) as cid,
                coalesce(completed, 0) as completed,
                coalesce(eventId, '') as eventId,
                coalesce(webhookTimestamp, 0) as webhookTimestamp
            FROM playback_history 
            ORDER BY createTime DESC
        `;

        const client = getDB();
        const result = await client.execute(safeSql) || {};
        const rawRows = result.rows || [];

        console.log(`[远端同步] 数据库总行数: ${rawRows.length}`);
        if (rawRows.length > 0) {
            console.log(`[远端同步] 各行的 configKey:`);
            rawRows.forEach((r, i) => {
                console.log(`  [${i}] dedupeKey="${r.dedupeKey}" configKey="${r.configKey}" vodName="${r.vodName}"`);
            });
        }

        // 按文档：同一 token 下同一 configKey 为同一套记录
        // configKey 为空时按当前点播接口写入（兼容旧服务端）
        const filteredRows = rawRows.filter(r => {
            if (!r) return false;
            const rowConfigKey = (r.configKey || '').trim();
            if (configKey) {
                return rowConfigKey === '' || rowConfigKey === configKey;
            }
            return true;
        });

        console.log(`[远端同步] configKey 过滤后: ${filteredRows.length} 条`);

        // 转换为文档 13.4.4 规定的字段名
        const items = filteredRows.map(r => {
            const finalDuration = Number(r.duration) || 3600000;
            const finalPosition = Number(r.position) || 1000;
            const isCompleted = r.completed === 1 || r.completed === true ||
                (finalPosition > 0 && finalDuration > 0 && finalPosition >= finalDuration * 0.95);

            const item = {
                // === 文档 13.4.1/13.4.4 规定字段 ===
                configKey: r.configKey || '',
                configName: r.configName || '',
                siteKey: r.siteKey || '',
                siteName: r.siteName || '',
                vodId: r.vodId || '',
                vodName: r.vodName || '未知视频',
                vodPic: r.vodPic || '',
                flag: r.flag || r.siteKey || '默认线路',
                episodeName: r.episodeName || '已观看',
                episodeUrl: r.episodeUrl || '',
                positionMs: finalPosition,
                durationMs: finalDuration,
                speed: Number(r.speed) || 1.0,
                completed: isCompleted,
                updatedAt: Number(r.createTime) || Date.now(),
                sessionId: r.sessionId || '',
                state: r.state || '',
                progress: Number(r.progress) || (finalDuration > 0 ? finalPosition / finalDuration : 0),

                // === 附加字段（兼容旧客户端） ===
                dedupeKey: r.dedupeKey || '',
                revSort: r.revSort === 1 || r.revSort === true,
                revPlay: r.revPlay === 1 || r.revPlay === true,
                createTime: Number(r.createTime) || Date.now(),
                opening: Number(r.opening) || 0,
                ending: Number(r.ending) || 0,
                position: finalPosition,
                duration: finalDuration,
                scale: Number(r.scale) || 0,
                cid: Number(r.cid) || 0
            };

            console.log(`[远端同步] 返回: siteKey="${item.siteKey}" vodId="${item.vodId}" vodName="${item.vodName}" episodeName="${item.episodeName}" configKey="${item.configKey}" positionMs=${item.positionMs} durationMs=${item.durationMs} updatedAt=${item.updatedAt}`);

            return item;
        });

        // 按文档 13.4.4 格式：{ "items": [...], "nextSince": ... }
        const lastItem = items.length > 0 ? items[items.length - 1] : null;
        const nextSince = lastItem ? lastItem.updatedAt : 0;

        const response = {
            items: items,
            nextSince: nextSince
        };

        console.log(`[远端同步] 最终返回 items=${items.length} nextSince=${nextSince}`);

        res.status(200).json(response);

    } catch (err) {
        console.error(`查库失败:`, err.message);
        res.status(500).json({ code: 500, message: `Database error: ${err.message}` });
    }
});

// =========================================================================
// Webhook 接收端点 (POST /)
// 文档 13.4.5：
//   - schema 校验 "webhtv.playback.v1"
//   - 区分 playback.progress / playback.ended 事件
//   - 用 dedupeKey 做主键（同一播放条目合并）
//   - 用 eventId / Idempotency-Key 做幂等去重
//   - configKey 优先从 body 取，header 作为 fallback
// =========================================================================
async function handleWebhookPlayback(req, res) {
    const body = req.body || {};

    // 1. schema 校验
    if (body.schema !== 'webhtv.playback.v1') {
        console.log(`[Webhook] schema 不匹配: "${body.schema}"`);
        return res.status(400).json({ code: 400, message: "Bad Request: Invalid schema" });
    }

    // 2. 事件类型
    const event = body.event || '';
    console.log(`\n[Webhook 接收] event="${event}"`);

    // 3. configKey：优先从 body 取，header 作为 fallback
    const configKey = body.configKey || (req.headers['x-webhtv-config-key'] || '').trim();
    const configName = body.configName || (req.headers['x-webhtv-config-name'] || '').trim();

    // 4. 幂等 key：eventId 或 Idempotency-Key
    const eventId = body.eventId || (req.headers['x-webhtv-webhook-id'] || req.headers['idempotency-key'] || '').trim();
    const dedupeKey = body.dedupeKey || (req.headers['x-webhtv-dedupe-key'] || '').trim();

    console.log(`[Webhook] configKey="${configKey}" configName="${configName}" eventId="${eventId}" dedupeKey="${dedupeKey}"`);

    // 必须有 dedupeKey（用于主键去重同一播放条目）
    if (!dedupeKey) {
        console.log(`[Webhook] 缺少 dedupeKey`);
        return res.status(400).json({ code: 400, message: "Bad Request: Missing dedupeKey" });
    }

    // 必须有 eventId（用于幂等去重）
    if (!eventId) {
        console.log(`[Webhook] 缺少 eventId`);
        return res.status(400).json({ code: 400, message: "Bad Request: Missing eventId" });
    }

    // playback.ended 事件强制标记 completed
    const isEndedEvent = (event === 'playback.ended');
    const bodyCompleted = body.completed === true || body.completed === 1;
    const finalCompleted = isEndedEvent ? true : bodyCompleted;

    // 字段映射：优先使用文档字段名
    const finalPosition = body.positionMs !== undefined ? Number(body.positionMs) : Number(body.position || 0);
    const finalDuration = body.durationMs !== undefined ? Number(body.durationMs) : Number(body.duration || 0);
    const finalProgress = body.progress !== undefined ? Number(body.progress) : (finalDuration > 0 ? finalPosition / finalDuration : 0);
    const finalFlag = body.flag || body.vodFlag || '';
    const finalEpisodeName = body.episodeName || body.vodRemarks || '';
    const finalSiteName = body.siteName || '';
    const finalSessionId = body.sessionId || '';
    const finalState = body.state || '';

    // X-WebHTV-Timestamp（必填 header，秒级时间戳转为毫秒存储）
    const headerTimestamp = (req.headers['x-webhtv-timestamp'] || '').trim();
    const webhookTimestamp = headerTimestamp ? Number(headerTimestamp) * 1000 : Date.now();

    console.log(`[Webhook 写入] dedupeKey="${dedupeKey}" vodName="${body.vodName}" episodeName="${finalEpisodeName}" position=${finalPosition} duration=${finalDuration} completed=${finalCompleted} configKey="${configKey}"`);

    try {
        await ensureDB();
        const client = getDB();

        // 幂等检查：同一 eventId 已处理过则跳过
        const existing = await client.execute({
            sql: `SELECT dedupeKey FROM playback_history WHERE eventId = ? LIMIT 1`,
            args: [eventId]
        });
        if (existing.rows && existing.rows.length > 0) {
            console.log(`[Webhook] eventId="${eventId}" 已处理过，跳过（幂等）`);
            return res.status(200).json({ code: 0, message: "Already processed (idempotent)", skipped: true });
        }

        // 写入：用 dedupeKey 做主键，同一播放条目合并更新
        await client.execute({
            sql: `INSERT INTO playback_history (
                    dedupeKey, eventId, configKey, configName,
                    siteKey, siteName, vodId, vodPic, vodName,
                    flag, episodeName, episodeUrl,
                    sessionId, state, progress,
                    revSort, revPlay, createTime, opening, ending,
                    position, duration, speed, scale, cid, completed,
                    webhookTimestamp
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(dedupeKey) DO UPDATE SET
                    eventId=excluded.eventId,
                    configKey=excluded.configKey, configName=excluded.configName,
                    siteKey=excluded.siteKey, siteName=excluded.siteName,
                    vodId=excluded.vodId, vodPic=excluded.vodPic, vodName=excluded.vodName,
                    flag=excluded.flag, episodeName=excluded.episodeName, episodeUrl=excluded.episodeUrl,
                    sessionId=excluded.sessionId, state=excluded.state, progress=excluded.progress,
                    revSort=excluded.revSort, revPlay=excluded.revPlay, createTime=excluded.createTime,
                    opening=excluded.opening, ending=excluded.ending,
                    position=excluded.position, duration=excluded.duration,
                    speed=excluded.speed, scale=excluded.scale, cid=excluded.cid,
                    completed=excluded.completed,
                    webhookTimestamp=excluded.webhookTimestamp`,
            args: [
                dedupeKey,
                eventId,
                configKey,
                configName,
                body.siteKey || '',
                finalSiteName,
                body.vodId || '',
                body.vodPic || '',
                body.vodName || '未知视频',
                finalFlag,
                finalEpisodeName,
                body.episodeUrl || '',
                finalSessionId,
                finalState,
                finalProgress,
                body.revSort ? 1 : 0,
                body.revPlay ? 1 : 0,
                body.createTime || body.timestamp || Date.now(),
                body.opening || 0,
                body.ending || 0,
                finalPosition,
                finalDuration,
                body.speed || 1.0,
                body.scale || 0,
                body.cid || 0,
                finalCompleted ? 1 : 0,
                webhookTimestamp
            ]
        });

        console.log(`[Webhook 写入] 成功写入 dedupeKey="${dedupeKey}"`);
        // 按文档 13.4.3 写入 API 响应格式
        res.status(200).json({
            code: 0,
            success: true,
            action: 'created',
            affected: 1,
            dedupeKey: dedupeKey,
            configKey: configKey,
            siteKey: body.siteKey || '',
            vodId: body.vodId || '',
            episodeName: finalEpisodeName,
            message: 'Synced'
        });
    } catch (err) {
        console.error("Webhook 写入失败:", err.message);
        res.status(500).json({ code: 500, message: err.message });
    }
}

app.post('/', handleWebhookPlayback);

// =========================================================================
// 404 兜底
// =========================================================================
app.use((req, res) => { res.status(404).json({ code: 404, message: "Not found" }); });

// =========================================================================
// 数据库初始化
// =========================================================================
async function ensureDB() {
    if (dbInitDone) return;

    try {
        const client = getDB();

        // 创建新表：以 dedupeKey 为主键（文档要求用 dedupeKey 合并同一播放条目）
        await client.execute(`CREATE TABLE IF NOT EXISTS playback_history (
            dedupeKey TEXT PRIMARY KEY,
            eventId TEXT DEFAULT '',
            configKey TEXT DEFAULT '',
            configName TEXT DEFAULT '',
            siteKey TEXT DEFAULT '',
            siteName TEXT DEFAULT '',
            vodId TEXT DEFAULT '',
            vodPic TEXT,
            vodName TEXT,
            flag TEXT,
            episodeName TEXT,
            episodeUrl TEXT,
            sessionId TEXT DEFAULT '',
            state TEXT DEFAULT '',
            progress REAL DEFAULT 0.0,
            revSort INTEGER DEFAULT 0,
            revPlay INTEGER DEFAULT 0,
            createTime INTEGER DEFAULT 0,
            opening INTEGER DEFAULT 0,
            ending INTEGER DEFAULT 0,
            position INTEGER DEFAULT 0,
            duration INTEGER DEFAULT 0,
            speed REAL DEFAULT 1.0,
            scale INTEGER DEFAULT 0,
            cid INTEGER DEFAULT 0,
            completed INTEGER DEFAULT 0,
            webhookTimestamp INTEGER DEFAULT 0
        )`);

        // 兼容迁移：基于 PRAGMA table_info 检测所有缺失列并自动添加
        // 注意：迁移必须在任何引用新列的 DDL（如 CREATE INDEX）之前执行
        let tableInfo = { rows: [] };
        try {
            const result = await client.execute(`PRAGMA table_info(playback_history)`);
            tableInfo = result;
        } catch (e) { /* 忽略 */ }
        const existingColumns = new Set((tableInfo.rows || []).map(r => r.name));

        const hasOldKeyColumn = existingColumns.has('key');

        // 目标列定义：列名 -> DDL 片段
        const targetColumns = {
            dedupeKey:        "TEXT DEFAULT ''",
            eventId:          "TEXT DEFAULT ''",
            configKey:        "TEXT DEFAULT ''",
            configName:       "TEXT DEFAULT ''",
            siteKey:          "TEXT DEFAULT ''",
            siteName:         "TEXT DEFAULT ''",
            vodId:            "TEXT DEFAULT ''",
            vodPic:           "TEXT",
            vodName:          "TEXT",
            flag:             "TEXT",
            episodeName:      "TEXT",
            episodeUrl:       "TEXT",
            sessionId:        "TEXT DEFAULT ''",
            state:            "TEXT DEFAULT ''",
            progress:         "REAL DEFAULT 0.0",
            revSort:          "INTEGER DEFAULT 0",
            revPlay:          "INTEGER DEFAULT 0",
            createTime:       "INTEGER DEFAULT 0",
            opening:          "INTEGER DEFAULT 0",
            ending:           "INTEGER DEFAULT 0",
            position:         "INTEGER DEFAULT 0",
            duration:         "INTEGER DEFAULT 0",
            speed:            "REAL DEFAULT 1.0",
            scale:            "INTEGER DEFAULT 0",
            cid:              "INTEGER DEFAULT 0",
            completed:        "INTEGER DEFAULT 0",
            webhookTimestamp: "INTEGER DEFAULT 0"
        };

        const addedColumns = [];
        for (const [colName, colDef] of Object.entries(targetColumns)) {
            if (!existingColumns.has(colName)) {
                const sql = `ALTER TABLE playback_history ADD COLUMN ${colName} ${colDef}`;
                try {
                    await client.execute(sql);
                    addedColumns.push(colName);
                } catch (e) {
                    console.log(`[迁移] 添加列 ${colName} 失败（可能已存在）: ${e.message}`);
                }
            }
        }
        if (addedColumns.length > 0) {
            console.log(`[迁移] 已添加 ${addedColumns.length} 个缺失列: ${addedColumns.join(', ')}`);
        }

        // 为 eventId 创建索引（幂等查询用）
        try {
            await client.execute(`CREATE INDEX IF NOT EXISTS idx_eventId ON playback_history(eventId)`);
        } catch (e) { /* 忽略 */ }

        // 如果有旧数据（key 列有值，dedupeKey 为空），尝试迁移
        if (hasOldKeyColumn) {
            try {
                // 将旧 key 数据迁移到 dedupeKey，并将 vodRemarks 迁移到 episodeName
                await client.execute(`
                    UPDATE playback_history SET 
                        dedupeKey = CASE WHEN dedupeKey = '' OR dedupeKey IS NULL THEN COALESCE([key], '') ELSE dedupeKey END,
                        episodeName = CASE WHEN episodeName = '' OR episodeName IS NULL THEN COALESCE(vodRemarks, '') ELSE episodeName END,
                        flag = CASE WHEN flag = '' OR flag IS NULL THEN COALESCE(vodFlag, '') ELSE flag END
                    WHERE dedupeKey = '' OR dedupeKey IS NULL
                `);
                console.log('旧数据迁移完成');
            } catch (e) {
                console.log('旧数据迁移（可能无需迁移）:', e.message);
            }
        }

        dbInitDone = true;
        console.log('数据库初始化成功');
    } catch (e) {
        console.error('数据库初始化失败:', e.message);
        throw e;
    }
}

// =========================================================================
// 启动（本地开发时监听端口；Vercel serverless 自动导出 app）
// =========================================================================
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    ensureDB().then(() => {
        app.listen(PORT, () => { console.log(`同步服务已启动。端口: ${PORT}`); });
    }).catch(err => {
        console.error('启动失败，请检查 Turso 连接配置:', err.message);
        app.listen(PORT, () => { console.log(`同步服务已启动（数据库待连接）。端口: ${PORT}`); });
    });
}

module.exports = app;
