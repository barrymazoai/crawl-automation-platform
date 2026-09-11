# V3 任务提交 · 持久入口切片

2026-09-05：共享契约、数据库接收、HTTP 接口和来源级防重叠已实现并通过隔离测试。随后已完成[Temporal 投递核心与终态核验](./DELIVERY.md)，且在 Railway + 本地 Worker 跑通合成任务。[独立运行器](./RUNNER.md)也已完成本地进程验收。**运行器尚未常驻部署，真实业务 Workflow 尚未接通；正常启动入口仍不接受新任务。** 以下保留入口切片的结构说明。

数据库仅保存入口请求和防重叠事实；Activity 领取、重试、依赖、计时器和执行状态仍由 Temporal 管理，不在业务库重建流程引擎。

## HTTP 契约

沿用 V3 Bearer 鉴权、16 KiB 上限、严格 JSON 输入和 UUID `Idempotency-Key`。

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| POST | `/api/v3/brands/:id/sources/:sourceId/submissions` | 接收单个来源的一次采集请求；开放后返回 202 |
| GET | `/api/v3/submissions/:requestId` | 按原请求 ID 读回已接受记录 |
| GET | `/api/v3/brands/:id/sources/:sourceId/submissions/active` | `{item: ...}` 或 `{item: null}`；来源不存在为 404 |

提交体只有 `{ "sourceRevision": 2 }`。Brand 和来源来自路径；渠道、URL、品牌名、来源版本由数据库冻结成快照。客户端不能传任意 Workflow、队列、Worker、网络配置或覆盖 URL。

响应含 `requestId`、`workflowId`、`state: "PENDING_DELIVERY"`、`snapshot`、`createdAt`，并带回读地址 `Location`。`202` 仅表示接收落库，不代表 Temporal 已收到、Worker 正在跑或产品已入库。

- 同 key + 同规范化输入：202，返回第一次的结果，`Idempotency-Replayed: true`。
- 同 key + 不同来源 / 版本 / API 操作：409 `REQUEST_ID_CONFLICT`。
- 同来源 + 不同 key：最多一个接受，其他 409 `SOURCE_BUSY`；查询 active，不自动换 key 重跑。
- 来源禁用、版本过期：409 `SOURCE_DISABLED` / `REVISION_CONFLICT`。
- 来源不属于指定 Brand：404 `SOURCE_NOT_FOUND`。
- 正常入口未开放接收：503 `SUBMISSIONS_DISABLED`，不留下待执行请求。

响应未知时用相同 key 重试，或 GET 原 request ID。一次 GET 404 不能证明尚在途的 POST 最终失败，不能据此生成新 key。

## 原子性与边界

一次 PostgreSQL 事务包含：占用通用 API 请求 ID → 锁定来源/品牌并验证配置 → 插入不可变请求快照 → 占用来源防重叠记录 → 写完整 API 回执并提交。任一步失败，所有记录一起回滚。

Workflow ID 固定为 `v3-collection-<requestId>`。数据库事务里没有 Temporal 或其他网络调用。不同来源可以并发，不加全 Brand / 全局排他锁。来源编辑与接收有行锁串行关系，旧 revision 不会默默采用新 URL。

快照不跟随后续重命名、URL 编辑变化。禁用来源只阻止新请求，不取消已有请求、不释放防重叠；重放已接受 key 仍返回原回执。防重叠记录无 TTL，无人工清除 / 公网释放 API。数据库拒绝修改或删除已接受快照；guard 复合外键保证来源和请求一致。

## 工程组织与部署状态

- `packages/v3-contracts` 共享输入、输出和快照校验，不含数据库或 Temporal SDK。
- `src/submissions/port.ts` 定义接收/查询端口，`PostgresSubmissions` 提供数据库实现。
- `src/storage/request-receipts.ts` 是 Brand 与提交入口共用的事务回执实现。
- `server.ts` / `local.ts` 注入查询仓储，但显式设置 `acceptSubmissions: false`。没有环境变量可误开此半完成链路。
- 隔离测试才启用接收，只验证合成数据，不启动 Workflow。
- 新迁移为 `database/v3/003_collection_submissions.sql`。普通 server 只读检查；`dev:local` 下次显式启动时按 hash 登记应用迁移。本次未重启当前 API、未迁移其持久库、未改 4181 页面或部署云端。

## 验证

14 项新 PostgreSQL / HTTP 测试覆盖：默认关闭、鉴权、原子回执、八路同 key、八路不同 key、独立来源并发、禁用/版本/所属、响应丢失后回读、快照不变、ID 冲突、输入注入、活跃查询、并发编辑等待、失败回滚、数据库约束和真实 HTTP（部分场景合并在一个测试）。旧 Brand API 12 项回归全部通过。

共享契约 11 项（新增 5 项）、API 单测 5 项、Web HTTP 客户端 12 项通过；V3 API 构建和三端类型检查通过。响应丢失测试是丢弃成功响应后重建应用对象，不是机器断电演练。

测试使用全新临时 PostgreSQL 和私有 Unix socket，结束后服务已停止、证据保留；不访问旧库和真实网站。

## 后续开放条件（最新进展见 DELIVERY.md）

1. 已实现独立 Temporal Adapter 和交接登记，已验证响应丢失与终态原子释放。
2. 已完成故障窗口注入和云端合成任务闭环；真实进程突然退出、跨 Run 完整收口仍待补齐。
3. 接常驻投递/核验运行器与业务编排 Worker 后再开放页面手动入口；定时入口复用同一防重叠边界。

上述完成前，不启动常驻扫描器、不接受真实待抓取请求，不手动清 guard 绕开校验。
