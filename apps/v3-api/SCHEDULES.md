# 定时计划与来源防重叠

CRAWLV3-13。计划只存 Temporal，不另建业务计划表或调度器。首版每个来源一条每日计划，支持 IANA 时区、创建、修改、启用和暂停；新建默认暂停，不立即触发。生产组装尚未开放，普通 API 未注入 ScheduleService 时只读返回 enabled=false、写入返回 503。

## 职责与交接

Temporal Schedule → ScheduledCollectionIntake（Workflow 队列）→ acceptScheduleTick（独立 Activity 队列）→ PostgreSQL 持久接收 → 既有 DeliveryRunner → 后续采集 Workflow。

- ScheduleService 是端口，TemporalSchedules 是适配器；时间验证和 SDK 操作不进入 Workflow。
- scheduleActivities 注入接收端口与 cluster/namespace/activityQueue 作用域。编排只执行确定性代码，不直接读数据库。
- 接收 Activity 与手动提交共用 acceptSource：同一事务锁来源、验证版本/启用状态、冻结快照并取得来源 guard。接收完成即可释放 Worker，不等待采集结束。
- 验收 fixture 使用三个 Worker 实例及三个队列（同一个进程）；不冒充跨机器或独立进程验收。业务 Worker 注册表仍为空，真实 Catalog/Product 工作流由后续任务实现，不把验收 Probe 注册为生产业务。

## API 与安全写入

经现有认证的 /api/v3/brands/:brandId/sources/:sourceId/schedule：

- GET：返回 enabled、实际计划或 null。
- POST：Idempotency-Key UUID；rule={hour,minute,timezone}、sourceRevision。创建暂停计划。
- PUT：同上，额外 revision（期望的计划版本）、paused。修改时递增版本。

Schedule ID 固定为 v3-source-<sourceId>，参数保存部署归属、来源/计划版本及 commandId。浏览器先保存不可变请求，错误/刷新保留原 key 和输入；只有人工确认才重发，GET 不触发写入。回读确认实际参数及状态后才清除待确认请求。仅保留最近 commandId，后续命令覆盖后不会把旧命令当作可重放成功。

SDK 1.23.0 的 handle.update 未传 conflictToken，因此使用公开 updateSchedule RPC，携带 Describe 返回的 token，防止两个编辑者静默覆盖。发现外部修改的归属、队列、参数或日历/重叠配置不一致时拒绝接管。没有删除、补跑或 HTTP 手动 trigger 接口。

## Tick、重叠与错误

tick 身份取实际 TemporalScheduledById / TemporalScheduledStartTime。requestId 是 cluster + namespace + scheduleId + scheduledAt 的 SHA-256 派生 UUIDv8；不依赖 Run ID，同一次 tick 重放身份不变，夏令时重复小时的两个 UTC tick 不混淆。

Temporal SKIP 只防同一个短接收 Workflow 重叠。数据库 guard 另防手动/定时入口与长采集重叠。来源忙时持久保存 SKIPPED/SOURCE_BUSY，不生成采集、不排队补跑；即使来源后来空闲，同一 tick 重放仍为 SKIPPED。禁用、版本冲突、来源不存在保存 REVIEW 分类，接收 Workflow 明确失败，由 pauseOnFailure 暂停未来计划。

Workflow 和 Activity 都 maximumAttempts=1；未知错误不自动重跑业务。完成接收但 Activity 响应丢失时，数据库回执仍在，不能只看 Workflow failed 就判定未受理。来源 guard 仅由原交接终态核验路径释放，无 TTL 抢锁。

pauseOnFailure 仅观察短接收 Workflow，**不表示下游采集失败会自动暂停计划**。暂停不取消已接收采集。独立业务 Review 页面及产品错误汇总尚未实现，当前分类证据在接收回执和 Temporal 历史中。

## 时间规则

按当地钟表时间：DST 春季不存在的时间跳过，秋季重复的时间匹配两次；建议 UTC。catchupWindow=10 秒（不是零补偿），不提供历史 backfill。UI 区分实际触发数、Temporal overlap 跳过数与来源 guard 的业务 SKIPPED；这些都不是产品入库数。暂停时显示的匹配时间不会执行。

规则参考 [Temporal Schedules](https://docs.temporal.io/schedule) 与锁定 SDK 的 schedule-types.d.ts。服务器 matching-times 测试验证 2027 年纽约 DST 跳时/重复小时。

## 验证

pnpm --filter @crawl-automation/v3-api test:temporal

覆盖原 key 回读、编辑/暂停、并发版本保护、实际 tick 接收及来源忙跳过、失败暂停、DST、认证与默认关闭。浏览器独立 fixture：先构建 web 的 build:v3:live，再在 apps/v3-api 下运行 V3_UI_ACCEPTANCE=isolated node --import tsx integration/schedule-ui-preview.ts。仅监听 127.0.0.1:4185，Temporal UI 8235，使用全新临时 PG；stdin 的 tick/reject-once/complete/proof/stop 仅供验收，无 HTTP 控制后门。

完整截图、实际时间触发和原请求复核见 docs/plane/evidence/CRAWLV3-13/README.md。未改旧库、现有持久库、Railway 或 Clash。
