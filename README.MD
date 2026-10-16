# WebHTV 播放进度云同步服务

这是一个专门为 [WebHTV](https://github.com/fish2018/webhtv/) 定制的**播放进度多端同步后端服务**。项目采用 Node.js（原生 http）架构，底层依托 **Turso (LibSQL) 云数据库**（本地未配置时自动退化为 `file:./playback.db` 文件库）。协议与 `serverless/webhtv-remote-vercel` 保持一致，支持基于配置地址哈希的**跨设备身份归并**。

## 🛠️ 环境变量配置 (.env)

在项目根目录下创建 `.env` 文件（生产环境请在 Vercel 后台配置对应的环境变量）：

```text
PORT=9980
TURSO_DATABASE_URL=libsql://你的库名-你的用户名.turso.io   # 留空则使用本地文件 ./playback.db
TURSO_AUTH_TOKEN=你的 Turso 数据库访问令牌
```

> 注意：本项目**不再使用 `APP_AUTH_TOKEN`**。服务端以 `X-WebHTV-Token`（客户端填写的“token”）作为命名空间隔离键，而不是做网关鉴权。

## 📦 本地快速启动

1. 克隆项目并进入根目录
2. 执行 `npm install`
3. 执行 `npm start`（即 `node index.js`）启动服务，默认监听 `9980`

## 🌍 Vercel 部署指南

1. 在 Vercel 仪表盘创建项目并连接 GitHub 仓库。
2. 在项目设置的 Environment Variables 中添加：
   - `TURSO_DATABASE_URL`：Turso 数据库连接 URL
   - `TURSO_AUTH_TOKEN`：Turso 数据库访问令牌
3. 部署。`vercel.json` 通过 `@vercel/node` 把 `index.js` 作为 serverless 函数导出（`export default handler`），所有路径由该函数处理。

## 📡 接口说明

服务遵循 WebHTV 远端同步协议，端点统一为 `/api/playback/sync`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/playback/sync` | 远端同步源：增量拉取观影记录，返回 `{ changes, nextSince, hasMore }`；支持 `X-WebHTV-Since` / `X-WebHTV-Limit` 分页 |
| `POST` | `/api/playback/sync` | Webhook 接收：接收 `playback.progress` / `playback.ended` / `playback.deleted` 事件；删除事件持久化为 90 天墓碑 |
| `GET` | `/api/playback/sync/status` | 同步状态（条目数、游标、能力） |
| `POST` | `/api/playback/identity/resolve` | 身份解析：按配置地址哈希把多台设备归并到同一 `canonicalInterfaceKey`，并返回 `resetSince` 让客户端重拉全量 |
| `DELETE` | `/reset-db` | 清空所有同步数据（含身份注册表） |
| `GET` | `/health` | 健康检查 |

App 中“远端同步”和“Webhook 上报”填写**同一个地址**即可（注意是 `/api/playback/sync`，不是根路径 `/`）：

```text
https://<你的服务域名>/api/playback/sync
```

## 🔑 跨设备同步原理

每台设备本地有一个随机 `interfaceKey`。App 在同步前会先请求 `/api/playback/identity/resolve` 并带上配置地址哈希；服务端把命中同一份接口的多台设备归并到同一个 `canonicalInterfaceKey`，之后上传与拉取都按该共享 key 落到同一命名空间，因此**不同设备能看到彼此的观影记录**。
