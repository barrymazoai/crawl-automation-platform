# Temporal 可靠交接与终态核验

2026-09-05：投递核心、PostgreSQL 交接登记、只读查询和真实 Temporal 验收完成。**已跑通合成任务的 HTTP API → 新临时业务库 → Railway Temporal → 本地 Mac Worker → 终态登记/来源释放。不是生产业务流程上线。**

## 职责拆分

| 部分 | 负责 | 不负责 |
| --- | --- | --- |
| 共享 contracts | 版本化 Workflow 输入、投递回执、错误分类 | SDK、数据库、凭证 |
| `DeliveryCoordinator` | 对一个已接受请求做一次有界投递/核验 | Activity 调度、常驻扫描、业务重跑 |
| `WorkflowGateway` / `TemporalGateway` | Temporal Start、Describe、历史证据读取 | 数据库事务、来源释放、OCR |
| `DeliveryJournal` / `PostgresDelivery` | 原子发送授权、交接事实、终态与来源释放事务 | 网络调用、工作流引擎 |
| `DeliveryRunner` / `PostgresDeliveryScan` | 固定上界、有界并发的交接扫描，逐项错误隔离 | Activity 队列、执行租约、业务重试 |
| composition root | 注入 Client、TLS、端点和仓储；管理生命周期 | 隐式选择旧库或全局切换网络 |

SDK 固定 1.23.0，复用工作区已缓存依赖，未增加框架。目标 namespace 与传入 Client 必须一致；请求第一次登记后，目标、指纹和首次投递时间不可改。

## 发送与响应未知

1. 入口先保存不可变请求及来源防重叠记录。
2. Coordinator 创建 `workflow_delivery` 意图记录。**只有成功创建该记录的调用才获得一次 Start 授权**，并发的其他调用只读历史。
3. 事务提交后，向 Temporal Start 相同稳定 Workflow ID；`REJECT_DUPLICATE` + `FAIL`，不使用默认允许重复、TerminateExisting 或新 ID 兜底。
4. 不凭 Start 返回值宣布成功。读取当前 Run、首个历史事件，核对 Workflow 类型、队列、完整输入指纹与请求身份后登记。
5. Start 响应丢失、AlreadyStarted、进程重启：查同一 Workflow，不再发 Start。网络失败 / NotFound 保留凭证、来源占用和分类，不假定失败。

这里承诺的是应用层只授权一次 Start，不是“TCP 只发送一个包”。SDK 在一个有界 RPC 内的传输层重试与业务层再次启动不同。Start 和核验各有 15 秒 deadline；目前 Adapter 给合成流程设 30 分钟执行上限，没有 Workflow 重试或 cron。

这是 **安全优先而非自动恢复所有请求**：若在意图提交后、真正发送前崩溃，后续查不到 Workflow 会保持 `START_UNKNOWN / NOT_FOUND`，需要复核，不会自动补发。历史保留期过后 NotFound 也不能授权重跑。登记无 TTL，不从 Worker 离线推断结束。

## 终态和来源释放

核验先固定 Run ID，再读该 Run 首事件与结束事件，并再次检查当前 Run 未被替换。登记时还核对已记录的 Run 与指纹。只有具有匹配结束事件的 Completed / Failed / Cancelled / Terminated / TimedOut 才允许释放；**登记终态和删除该 request 的 guard 在同一事务**。

释放失败则终态也回滚，重试只是核验/登记，不执行业务。已经 CLOSED 的回执不可修改；迟到的 Running/网络失败响应不能回退状态，也不能误删下一轮请求的 guard。旧 Idempotency-Key 仍重放原入口回执，不重新抓取。

Continue-As-New / retry descendant / reset 导致 Run 变化会保留 guard，分类为 `CHAIN_CONTINUED` 或 `RUN_CHANGED`。**目前未实现跨 Run 链完整追踪，因此这类流程不会自动释放，不能把此保守拦截描述成已支持自动续链收口。**

后续 CRAWLV3-10 增加持久隔离规则：身份冲突或链变化一旦观察到，后来的匹配终态/瞬态网络错误不能清除分类。新增只读人工复核 CLI，无写入、清 guard 或重跑能力；真实信号窗口与跨 Run 验证见 [RECOVERY.md](RECOVERY.md)。

运维边界：不要从 Temporal UI 绕过入口手动重置/重新启动旧请求；管理员在核验后再强制复活旧流程无法由这张业务 guard 跨系统原子阻止。正式开放前需定义受控 Reset 流程与权限。产品子流程的生命周期/收口仍由将来的业务 Workflow 保证，此测试没有真实子产品任务。

## 查询与错误

新增鉴权只读接口：`GET /api/v3/submissions/:requestId/delivery` → `{ item: DeliveryReceipt | null }`。GET 不发任务、不取消、不释放来源。

- `START_UNKNOWN`：发送意图已保存，尚无匹配执行证据。
- `CONFIRMED`：有已核验 Run；`observedStatus` 是最近观察，不保证现在仍相同。检查 `lastIssue` 和 `checkedAt`。
- `CLOSED`：已有终态证据并完成来源释放。
- `lastIssue`：`NOT_FOUND`、`UNAVAILABLE`、`IDENTITY_MISMATCH`、`RUN_CHANGED`、`CHAIN_CONTINUED`、`UNCONFIRMED_TERMINAL`。这些保存在交接表供只读复核，不调用 OCR、不自动重跑；尚未接统一 Review 页面/表。

原 `GET /submissions/:id` 和重复 POST 仍返回不可变的**入口回执**（PENDING_DELIVERY 是当时的接收事实），当前交接状态必须读取 `/delivery`，不能从旧回执推断正在运行。

## 验证结果

- 36 项真实 PostgreSQL / HTTP 测试：原 26 项 + 新增 10 项，覆盖并发单次授权、发送前/后中断窗口、确认丢失、断网/NotFound、指纹/Run 冲突、原子释放及失败回滚、迟到响应、目标不可改、鉴权回读。中断窗口为故障注入，不是进程 SIGKILL/断电演练。
- 3 项真实 Temporal 测试，本地隔离服务和 Railway 各跑一轮：真实 Start 成功后注入响应丢失、本地 Activity 与结束历史核验；错误输入占用同一 ID；真实 Continue-As-New 防误释放。
- 共享契约 14 项、原 API 单测 5 项、Web HTTP 客户端 12 项；类型检查与构建通过。
- 云端正向流程只有一次应用 Start 调用、一个本地 Activity。错误身份测试中的 Workflow 是专门创建的合成任务，测试后已终止；Continue-As-New 两个 Run 均结束。没有留下测试 Worker、HTTP 服务或临时 PostgreSQL 进程。

云端证明（2026-09-05 19:54，Asia/Shanghai）：

- Workflow：`v3-collection-67cbf2ea-0439-45c1-a610-d7504d5340aa`
- Run：`01a0716b-9c10-762e-879a-e3c83d75a3ca`
- 本地身份：`v3-delivery-proof@songtianjians-MacBook-Pro.local:30661`；平台 darwin。
- 状态 COMPLETED，匹配终态 Event 15；测试退出后通过云端 UI API 独立核对全部 15 条历史、输入指纹、执行身份和结果。
- [真实 Timeline](https://temporal-ui-production-1288.up.railway.app/namespaces/crawler-v3-test/workflows/v3-collection-67cbf2ea-0439-45c1-a610-d7504d5340aa/01a0716b-9c10-762e-879a-e3c83d75a3ca/timeline)。保留期仍为 7 天。
- 本地证据：`/var/folders/8g/hb1c2xq156b15mbh1ljhkqs00000gn/T/v3-api-ANYtY9/temporal-delivery-proof.json`，属于临时测试产物，不是备份保障。

```sh
pnpm --filter @crawl-automation/v3-api test:integration
pnpm --filter @crawl-automation/v3-api test:temporal
# 显式授权才运行云端合成测试；不需要重新部署：
V3_DELIVERY_CLOUD_PROBE=8ed88b1f-498d-4caa-8877-21ff7b93dbae pnpm --filter @crawl-automation/v3-api test:temporal
# 测试结束后独立只读核验：
node infra/temporal/scripts/verify-delivery.mjs <生成的temporal-delivery-proof.json绝对路径>
```

## 尚未开放的部分

正常 server / dev:local 仍关闭 POST 接收；没有常驻部署投递进程，也没有把生产输入接到合成 Workflow。[独立交接运行器](RUNNER.md)已实现并用独立进程、本地真实 Temporal 验证，需明确配置和 opt-in 才启动，不能把开发验证描述成持续接入真实任务。

Worker 注册/生命周期运行层已在 CRAWLV3-9 实现；入口交接 SIGKILL 关键窗口、跨 Run 保守隔离及只读人工复核已在 CRAWLV3-10 验证。下一步按任务顺序补独立开发库迁移/恢复手册与真实业务模块，再接页面手动按钮和定时入口。完整自动跨 Run 收口、真实 OCR、R2、产品写入仍未完成。

后续运行器切片新增 `005_delivery_scan.sql` 索引；累计 14 单测、38 数据库/API 集成、5 本地 Temporal 场景通过。上文 3 项 Railway 验收是先前投递核心的记录，新增运行器场景本轮仅在本地验收。`003`–`005` 均未应用现有持久业务库；没有读取旧库、重新部署 Railway、改 Clash 或新增收费资源。

CRAWLV3-10 后累计为 **20 单测、39 数据库/API 集成、18 本地 Temporal 场景**，类型及三入口构建通过；本项没有增加或应用 migration。详见恢复记录，不把早期模拟中断与后来真实进程中断混为一谈。

参考：[Temporal Workflow ID 策略官方文档](https://docs.temporal.io/workflow-execution/workflowid-runid)。实现同时核对本地安装的 TypeScript SDK 1.23.0 源码，并以真实 Temporal 测试验收，而不是只依赖文档描述。
