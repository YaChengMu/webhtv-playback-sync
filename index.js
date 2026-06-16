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
        console.log(`   x-webhtv-token:      "${req.headers['x-webhtv-token'] || '未携带'}"`);
        console.log(`   x-webhtv-config-key: "${req.headers['x-webhtv-config-key'] || '未携带'}"`);
        console.log(`   x-webhtv-config-name: "${req.headers['x-webhtv-config-name'] || '未携带'}"`);

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Token, X-WebHTV-Token, X-WebHTV-Config-Key, X-WebHTV-Config-Name');

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
                coalesce([key], '') as [key],
                coalesce(configKey, '') as configKey,
                coalesce(configName, '') as configName,
                coalesce(siteName, '') as siteName,
                coalesce(vodPic, '') as vodPic,
                coalesce(vodName, '未知视频') as vodName,
                coalesce(vodFlag, '') as vodFlag,
                coalesce(vodRemarks, '') as vodRemarks,
                coalesce(episodeUrl, '') as episodeUrl,
                coalesce(revSort, 0) as revSort,
                coalesce(revPlay, 0) as revPlay,
                coalesce(createTime, 0) as createTime,
                coalesce(opening, 0) as opening,
                coalesce(ending, 0) as ending,
                coalesce(position, 0) as position,
                coalesce(duration, 0) as duration,
                coalesce(speed, 1.0) as speed,
                coalesce(scale, 0) as scale,
                coalesce(cid, 0) as cid
            FROM playback_history 
            ORDER BY createTime DESC
        `;

        const client = getDB();
        const result = await client.execute(safeSql) || {};
        const rawRows = result.rows || [];

        console.log(`[远端同步] 数据库总行数: ${rawRows.length}`);
        // 打印每行的 configKey 用于诊断
        if (rawRows.length > 0) {
            console.log(`[远端同步] 各行的 configKey:`);
            rawRows.forEach((r, i) => {
                console.log(`  [${i}] key="${r.key}" configKey="${r.configKey}" vodName="${r.vodName}"`);
            });
        }

        // 过滤匹配的 configKey（空 configKey 视为通用，返回给所有接口）
        const filteredRows = rawRows.filter(r => {
            if (!r) return false;
            const rowConfigKey = (r.configKey || '').trim();
            // 如果请求带了 configKey，只返回匹配的或无 configKey 的旧数据
            if (configKey) {
                return rowConfigKey === '' || rowConfigKey === configKey;
            }
            return true; // 没传 configKey 时返回全部
        });

        console.log(`[远端同步] configKey 过滤后: ${filteredRows.length} 条`);

        // 转换为文档 13.4.4 规定的字段名
        const items = filteredRows.map(r => {
            let siteKey = '';
            let vodId = '';
            const itemKey = String(r.key || '');

            if (itemKey.includes('_')) {
                const parts = itemKey.split('_');
                siteKey = parts[0];
                vodId = parts.slice(1).join('_');
            }

            const finalDuration = Number(r.duration) || 3600000;
            const finalPosition = Number(r.position) || 1000;

            const item = {
                // === 文档规定字段 ===
                configKey: r.configKey || '',
                configName: r.configName || '',
                siteKey: siteKey,
                siteName: r.siteName || '',
                vodId: vodId,
                vodName: r.vodName || '未知视频',
                vodPic: r.vodPic || '',
                flag: r.vodFlag || siteKey || '默认线路',
                episodeName: r.vodRemarks || '已观看',
                episodeUrl: r.episodeUrl || '',
                positionMs: finalPosition,
                durationMs: finalDuration,
                speed: Number(r.speed) || 1.0,
                completed: (finalPosition > 0 && finalDuration > 0 && finalPosition >= finalDuration * 0.95),
                updatedAt: Number(r.createTime) || Date.now(),

                // === 附加字段（兼容旧客户端） ===
                key: itemKey || `${siteKey}_${vodId}`,
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

            // 打印每条返回的关键字段
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
// Webhook 接收端点 (POST / 和 POST /api/webhook/playback)
// 文档 13.4.5：App POST 单条播放记录，字段如 schema/event/eventId/siteKey/vodId/positionMs 等
// 服务端按 token + configKey 分组，用 key = siteKey_vodId 做主键去重
// 部分 App 版本可能 POST 到根路径 /，因此同时注册两个路由
// =========================================================================
async function handleWebhookPlayback(req, res) {
    const configKey = (req.headers['x-webhtv-config-key'] || '').trim();
    const configName = (req.headers['x-webhtv-config-name'] || '').trim();
    const body = req.body || {};

    console.log(`\n[Webhook 接收] configKey="${configKey}" configName="${configName}"`);
    console.log(`[Webhook 接收] body keys: ${Object.keys(body).join(', ')}`);
    console.log(`[Webhook 接收] body type: ${Array.isArray(body) ? 'array' : typeof body}`);

    // Webhook 可能是单条对象，也可能是数组（兼容旧版或批量场景）
    let items = [];
    if (Array.isArray(body)) {
        items = body;
    } else if (Array.isArray(body.items)) {
        items = body.items;
    } else if (body.siteKey || body.key) {
        // 单条 Webhook 记录
        items = [body];
    } else {
        console.log(`[Webhook 接收] 无法解析 body，无 siteKey/key 字段`);
        return res.status(400).json({ code: 400, message: "Bad Request: No valid playback data" });
    }

    // 过滤有效条目：必须有 siteKey+vodId 或 key
    const validItems = items.filter(item => item && (item.key || (item.siteKey && item.vodId)));

    console.log(`[Webhook 接收] 收到 ${items.length} 条, 有效 ${validItems.length} 条`);

    if (validItems.length === 0) {
        return res.status(400).json({ code: 400, message: "Bad Request: No valid data" });
    }

    try {
        await ensureDB();
        const statements = validItems.map(item => {
            // 生成或使用 key
            if (!item.key) item.key = `${item.siteKey}_${item.vodId}`;

            // 字段映射：优先使用文档字段名，fallback 到旧字段名
            const finalPosition = item.positionMs !== undefined ? item.positionMs : (item.position || 0);
            const finalDuration = item.durationMs !== undefined ? item.durationMs : (item.duration || 0);
            const finalFlag = item.flag || item.vodFlag || '';
            const finalRemarks = item.episodeName || item.vodRemarks || '';
            const finalConfigKey = configKey || item.configKey || '';
            const finalConfigName = configName || item.configName || '';
            const finalSiteName = item.siteName || '';

            console.log(`[Webhook 写入] key="${item.key}" vodName="${item.vodName}" episodeName="${finalRemarks}" position=${finalPosition} duration=${finalDuration} configKey="${finalConfigKey}"`);

            return {
                sql: `INSERT INTO playback_history (
                        [key], configKey, configName, siteName, vodPic, vodName, vodFlag, vodRemarks, episodeUrl, 
                        revSort, revPlay, createTime, opening, ending, position, duration, speed, scale, cid
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT([key]) DO UPDATE SET
                        configKey=excluded.configKey, configName=excluded.configName, siteName=excluded.siteName,
                        vodPic=excluded.vodPic, vodName=excluded.vodName, 
                        vodFlag=excluded.vodFlag, vodRemarks=excluded.vodRemarks, episodeUrl=excluded.episodeUrl, 
                        revSort=excluded.revSort, revPlay=excluded.revPlay, createTime=excluded.createTime, 
                        opening=excluded.opening, ending=excluded.ending, position=excluded.position, 
                        duration=excluded.duration, speed=excluded.speed, scale=excluded.scale, cid=excluded.cid`,
                args: [
                    item.key,
                    finalConfigKey,
                    finalConfigName,
                    finalSiteName,
                    item.vodPic || '',
                    item.vodName || '未知视频',
                    finalFlag,
                    finalRemarks,
                    item.episodeUrl || '',
                    item.revSort ? 1 : 0,
                    item.revPlay ? 1 : 0,
                    item.createTime || item.timestamp || Date.now(),
                    item.opening || 0,
                    item.ending || 0,
                    Number(finalPosition),
                    Number(finalDuration),
                    item.speed || 1.0,
                    item.scale || 0,
                    item.cid || 0
                ]
            };
        });

        const client = getDB();
        await client.batch(statements, "write");
        console.log(`[Webhook 写入] 成功写入 ${statements.length} 条`);
        res.status(200).json({ code: 0, message: `Synced ${statements.length} rows` });
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

        // 1. 建表（含新字段）
        await client.execute(`CREATE TABLE IF NOT EXISTS playback_history (
            [key] TEXT PRIMARY KEY,
            configKey TEXT DEFAULT '',
            configName TEXT DEFAULT '',
            siteName TEXT DEFAULT '',
            vodPic TEXT,
            vodName TEXT,
            vodFlag TEXT,
            vodRemarks TEXT,
            episodeUrl TEXT,
            revSort INTEGER DEFAULT 0,
            revPlay INTEGER DEFAULT 0,
            createTime INTEGER DEFAULT 0,
            opening INTEGER DEFAULT 0,
            ending INTEGER DEFAULT 0,
            position INTEGER DEFAULT 0,
            duration INTEGER DEFAULT 0,
            speed REAL DEFAULT 1.0,
            scale INTEGER DEFAULT 0,
            cid INTEGER DEFAULT 0
        )`);

        // 2. 兼容旧表：逐列尝试添加新字段
        const migrations = [
            "ALTER TABLE playback_history ADD COLUMN configKey TEXT DEFAULT ''",
            "ALTER TABLE playback_history ADD COLUMN configName TEXT DEFAULT ''",
            "ALTER TABLE playback_history ADD COLUMN siteName TEXT DEFAULT ''",
        ];
        for (const sql of migrations) {
            try { await client.execute(sql); } catch (e) { /* 字段已存在则忽略 */ }
        }

        dbInitDone = true;
        console.log('数据库初始化成功');
    } catch (e) {
        console.error('数据库初始化失败:', e.message);
        throw e; // 向上抛出让调用方知道
    }
}

// =========================================================================
// 启动（本地开发时监听端口；Vercel serverless 自动导出 app）
// =========================================================================
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
    // 本地开发：预初始化数据库再监听端口
    ensureDB().then(() => {
        app.listen(PORT, () => { console.log(`同步服务已启动。端口: ${PORT}`); });
    }).catch(err => {
        console.error('启动失败，请检查 Turso 连接配置:', err.message);
        // 即使初始化失败也启动，每个请求会重试
        app.listen(PORT, () => { console.log(`同步服务已启动（数据库待连接）。端口: ${PORT}`); });
    });
}

module.exports = app;
