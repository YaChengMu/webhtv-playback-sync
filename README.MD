# WebHTV 播放进度云同步服务

这是一个专门为 [WebHTV](https://github.com/fish2018/webhtv/) 定制的**播放进度多端同步后端服务**。项目采用 Node.js + Express 架构，底层依托高性能、零运维的 **Turso (LibSQL) 云数据库**，使用了[官方开发文档](https://github.com/fish2018/webhtv/blob/main/docs/%E5%BA%94%E7%94%A8%E5%AE%8C%E6%95%B4%E5%BC%80%E5%8F%91%E6%96%87%E6%A1%A3.md)中的协议规范。

## 🛠️ 环境环境变量配置 (.env)

在项目根目录下创建 `.env` 文件（生产环境请直接在服务商后台配置对应的环境变量）：

PORT=9980  
APP_AUTH_TOKEN=自定义安全 Token 用于客户端认证  
TURSO_DATABASE_URL=libsql://你的库名-你的用户名.turso.io  
TURSO_AUTH_TOKEN=你的Turso数据库访问令牌  

## 📦 本地快速启动

1. 克隆项目并进入根目录
2. 执行 `npm install` 安装必要的依赖（`express`, `@libsql/client`, `dotenv`）
3. 执行 `node index.js` 启动服务。

## 🌍 Vercel 部署指南
1. 在 Vercel 仪表盘创建一个新项目，连接到你的 GitHub 仓库。
2. 在项目设置中添加以下环境变量：
   - `APP_AUTH_TOKEN`: 自定义安全 Token 用于客户端认证
   - `TURSO_DATABASE_URL`: turso 数据库连接 URL
   - `TURSO_AUTH_TOKEN`: 你的Turso数据库访问令牌
3. 部署项目，Vercel 会自动构建并发布你的服务。

## 📡 接口说明

服务遵循 WebHTV 官方开发文档 13.4 节《远端同步源与 Webhook 上报》协议，端点统一为 `/api/playback/sync`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/playback/sync` | 远端同步源：增量拉取观影记录，返回 `{ items, deleted, nextSince, hasMore }`；支持 `X-WebHTV-Since` / `X-WebHTV-Limit` 分页 |
| `POST` | `/api/playback/sync` | Webhook 接收：接收 `playback.progress` / `playback.ended` / `playback.deleted` 事件，删除事件持久化为 90 天墓碑 |
| `DELETE` | `/reset-db` | 清空所有观影记录与删除墓碑（需携带有效 `X-WebHTV-Token`） |
| `GET` | `/` | 健康检查 |

App 中“远端同步”和“Webhook 上报”填写同一个地址与 token 即可：

```text
https://<你的服务域名>/api/playback/sync
```

服务端强制要求 `X-WebHTV-Token` 与 `X-WebHTV-Config-Key` 请求头：按 `token + configKey` 区分用户空间与点播接口，用 `dedupeKey` 合并同一播放条目，用 `eventId` / `Idempotency-Key` 去重重试。