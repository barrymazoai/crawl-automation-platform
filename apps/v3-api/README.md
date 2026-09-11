# V3 Brand / 来源 API

独立的新 API 工程。只读写 V3 新数据库，不依赖旧后端、旧任务队列或旧数据结构。已实现[任务提交持久入口](./SUBMISSIONS.md)和[Temporal 投递核心、终态核验](./DELIVERY.md)，并通过云端合成任务验证；[独立投递运行器](./RUNNER.md)已完成本地进程验收但未常驻部署。正常入口仍只开放配置与查询，提交保持关闭，真实采集/OCR/导入和生产同步尚未接通。

## 已实现接口

新增[被动 Review 只读接口与统一复核](../../packages/v3-review/README.md)：列表、分类汇总、详情摘要和 inspection；无写入/重试路由。需要显式迁移 007 后启用新 API，现有持久库尚未升级。

所有 `/api/v3/*` 请求需要 `Authorization: Bearer <V3_API_TOKEN>`。没有匿名业务数据读取、cookie 登录或宽松 CORS。

| 方法  | 路径                                           | 用途                                         |
| ----- | ---------------------------------------------- | -------------------------------------------- |
| GET   | `/healthz`                                     | 不含业务数据的进程存活信息，不代表数据库就绪 |
| GET   | `/api/v3/summary`                              | 数据库中 Brand、来源、启用来源的准确数量     |
| GET   | `/api/v3/brands`                               | Brand 列表、名称搜索与分页                   |
| GET   | `/api/v3/brands/:id`                           | 单个 Brand                                   |
| POST  | `/api/v3/brands`                               | 创建 Brand，不需要公司关联                   |
| PUT   | `/api/v3/brands/:id`                           | 编辑名称、备注，必须提供 revision            |
| GET   | `/api/v3/brands/:id/sources`                   | 该 Brand 的来源列表、URL 搜索与分页          |
| POST  | `/api/v3/brands/:id/sources`                   | 添加来源，默认禁用                           |
| PUT   | `/api/v3/brands/:id/sources/:sourceId`         | 编辑渠道、地区、URL，不改变启用状态          |
| PATCH | `/api/v3/brands/:id/sources/:sourceId/enabled` | 启停来源配置，不启动或取消任何任务           |

列表参数：`q`、`limit`（默认 25，最大 100）、`offset`。返回 `{ items, limit, offset, hasMore }`。这是 offset 分页，并发插入期间不承诺多页快照一致性。

所有写请求要求 JSON 和 UUID 格式的 `Idempotency-Key`；请求体上限 16 KiB。所有输入严格校验，未知的 `legacyId`、`companyId` 等字段会被拒绝。

```json
// POST /api/v3/brands
{ "name": "Sample Brand", "note": "仅用于新系统测试" }
```

```json
// POST /api/v3/brands/:id/sources
{ "channel": "dtc", "region": "US", "url": "https://brand.example/products" }
```

```json
// PATCH /api/v3/brands/:id/sources/:sourceId/enabled
{ "enabled": true, "revision": 1 }
```

编辑 Brand 需 `{name,note,revision}`；编辑来源需 `{channel,region,url,revision}`。URL 会规范化主机大小写、默认端口并去除 fragment；保留查询参数意义。当前只存 URL，不访问网站；这不是 SSRF 防护，后续抓取模块仍需单独验证网络访问权限。

## 幂等与并发

`api_request_receipt` 是窄范围写入回执，不是任务队列。数据变更与回执在同一个 PostgreSQL 事务提交。

- 同 key + 同操作 + 同规范化输入：返回原结果，`Idempotency-Replayed: true`，不重复写入。
- 同 key 用于不同操作或输入：409 `REQUEST_ID_CONFLICT`。
- 请求超时 / 响应丢失：保留并重用原 key，不能自动换新 key。
- 新的用户修改使用新 key；更新必须携带读取到的 revision。版本过期返回 409 `REVISION_CONFLICT`。
- 回放旧请求返回的是当时的写入结果，不是后来的最新数据；需要最新状态时再 GET。
- SQL 失败时事务和回执一起回滚。当前无回执清理策略，不静默到期后重复执行。

其他主要错误：400 无效输入、401 缺少有效令牌、404 不存在、409 名称/来源重复、413 过大、415 非 JSON、503 数据库忙或不可用。错误不会回传 SQL、数据库连接串或堆栈。

## 构建和运行

```sh
pnpm --filter @crawl-automation/v3-api build
pnpm --filter @crawl-automation/v3-api dev
```

启动必须显式配置：

- `V3_DATABASE_URL`：当前仅接受回环地址上的 `crawler_v3_dev` / `crawler_v3_test` 数据库，不读取旧 `DATABASE_URL`，不接受 URL 查询参数覆盖连接目标。
- `V3_API_TOKEN`：至少 32 字符的随机私密令牌。不要提交仓库、打印日志或打入浏览器 bundle。
- `V3_API_PORT`：默认 4180；监听地址固定 `127.0.0.1`。

先在**明确创建的新 V3 数据库**使用[版本化迁移工具](../../database/v3/OPERATIONS.md)登记并应用 001–008。普通启动只读检查版本/hash、能力和恢复隔离标记，不自动建库、迁移或读取旧库。独立投递进程的配置与验证见 [RUNNER.md](RUNNER.md)，与 HTTP API 分开启动，默认不启用。008 新增独立采集结果快照，并不代表本 API 已提供采集结果页面/查询接口。

另有显式的 `dev:local` 开发启动器，只在自己刚创建的全新库初始化结构；已有库只检查，需要显式维护模式才升级，并在升级前备份。它生成仅服务端持有的 API 令牌，不读取旧库变量。启动说明见 [真实页面联调说明](../web/V3_LIVE.md)；备份/空库隔离恢复、独立 SCRAM 角色及 socket trust 开发模式的区别见[数据库运行手册](../../database/v3/OPERATIONS.md)。本轮没有升级或重启现有持久库；跨机/生产仍需另行验收。

## 验证

```sh
pnpm --filter @crawl-automation/v3-api test
pnpm --filter @crawl-automation/v3-api test:integration
pnpm --filter @crawl-automation/v3-api check-types
```

集成测试需要本机 `initdb` / `pg_ctl`。每次创建全新临时 PostgreSQL 集群、仅开私有 Unix socket，不接受外部数据库 URL。另启动随机回环端口验证真实 HTTP。结束后停止服务并保留临时测试证据目录。

当前累计通过 20 项 API 单测、49 项真实数据库 / HTTP 集成、18 项本地 Temporal 场景，类型检查与构建通过。数据库集成包含新增的 10 项迁移/备份恢复/权限与 CLI 场景，见[运行手册](../../database/v3/OPERATIONS.md)。先前投递核心的 3 项也曾在 Railway 通过，本轮新增场景仅在本地执行。共享契约另有 14 项测试。真实中断、跨 Run 隔离及只读复核 CLI 见 [RECOVERY.md](./RECOVERY.md)。

HeroUI 真实页面已接入此 API，使用 4181 独立入口；4179 原 Demo 仍为模拟。两端共享 `packages/v3-contracts`，数据库 Date 转换、repository port 和事务回执留在服务端。没有旧库导入、旧 ID 兼容、硬删除、任务调度或正式公司匹配功能。
