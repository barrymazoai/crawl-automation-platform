# 独立交接运行器

2026-09-05 · Plane `CRAWLV3-8`。代码、独立进程暂停 / 恢复 / SIGTERM / 重启和本地 Temporal 合成链路已验证；**未常驻部署，普通 API 接收仍关闭，不是真实采集上线**。

这个进程扫描的是 **V3 业务库中已接受的交接请求**，不是 Temporal 内部数据库。它通过 SDK 提交 / 核验 Workflow；真正的 Workflow / Activity Worker 仍主动轮询 Temporal 队列。它不执行 OCR、抓取或产品写入，没有另一套任务 claim / lease。

## 启动与配置

入口：`src/delivery-server.ts`；构建后为 `dist/delivery-server.js`，与 API HTTP 进程分开启动。

```sh
pnpm --filter @crawl-automation/v3-api delivery
# 或先 build，再：
node apps/v3-api/dist/delivery-server.js
```

需显式注入以下环境变量，不提供默认生产目标：

- `V3_DELIVERY_ENABLED=true`
- `V3_DELIVERY_CONFIG`：JSON 配置文件的绝对路径。
- `V3_DATABASE_URL`：独立 `crawler_v3_dev` / `crawler_v3_test` 数据库。当前开发切片仅接受回环地址，不回退读取旧 `DATABASE_URL`。

JSON 示例（仅展示结构；Workflow 必须由对应 Worker 实际注册，不能拿测试 Probe 接生产输入）：

```json
{
  "target": {
    "clusterId": "explicit-local-v3-test",
    "namespace": "default",
    "taskQueue": "v3.catalog.test",
    "workflowType": "CatalogWorkflow"
  },
  "address": "127.0.0.1:7233",
  "transport": { "mode": "local" },
  "pauseFile": "/absolute/private/path/v3-delivery.pause",
  "batchSize": 20,
  "concurrency": 4,
  "intervalMs": 1000,
  "shutdownMs": 45000
}
```

远程 Temporal 必须使用 `transport.mode=mtls`，同时显式提供 `serverName`、`caFile`、`certFile`、`keyFile`；文件路径必须为绝对路径。证书内容不进 JSON、任务载荷或日志，私钥应由部署系统限制读取权限。TLS 校验不关闭，明文只允许回环。Railway 可复用已批准联调目标和专用证书，但本项没有把测试运行器常驻连接云端。

启动先验证配置、业务表与 `005_delivery_scan.sql` 索引、Temporal 连接和 namespace，再开始扫描；不自动迁移业务库。`dev:local` 迁移清单已加入 005，用户明确重启该入口时按已有哈希账本应用；本项未重启现有持久库/API。

## 扫描、暂停与退出

- 一轮固定最高 `(created_at, request_id)`，使用 keyset 分页；每页最多 100 项、并发最多 16 且不超过页大小。不使用 OFFSET 或一次载入全表；持续新输入不会无限延长当前轮。
- 保留 PostgreSQL 微秒时间文本，避免 JS Date 毫秒截断造成重复页。已释放来源 / CLOSED 项不进入扫描。
- 每条请求失败都推进本轮读游标，后续项照常核验；下一轮重新检查。游标只是可重建的进程内读取位置；重启从头扫描，**持久意图、目标、指纹和终态不会重置**。长期反复崩溃下的扫描延迟不承诺上界，需进程健康告警；不是用新租约取代业务证据。
- 多个运行器可以读到同一项；只有 `DeliveryJournal.begin` 成功新建意图的事务能授权一次 Start。未知、NotFound、目标冲突都不补发或释放来源，按现有交接规则保留复核。
- 指定的 `pauseFile` 存在即暂停新扫描 / 新分派；移走该文件后恢复。文件内容无业务含义，运行器不删除它。读取发生权限等错误时保守停止该次扫描。暂停不取消已发远端请求。
- `SIGINT` / `SIGTERM` 停接新项并排空已开始的核验；超过 `shutdownMs` 退出 1，保留持久事实。超时 / 取消不能证明远端副作用结束，重启仍只能核验。
- 日志只记录事件、公开目标、主机/PID、请求 ID，不输出原始异常、数据库 URL、TLS 内容或产品文本。`RECONCILED` 只说明本次调用完成，不表示任务业务成功；实际结果读 `/delivery` 的状态、`lastIssue`、`checkedAt`。

修改 target 不会重定向旧意图；配置错配会留在核验错误，必须恢复正确目标或受控复核。没有自动清 guard、重试全部或新建 Workflow ID 的恢复捷径。

## 验收证据

```sh
pnpm --filter @crawl-automation/v3-api test
pnpm --filter @crawl-automation/v3-api test:integration
pnpm --filter @crawl-automation/v3-api test:temporal
pnpm --filter @crawl-automation/v3-api build
```

本项验证：14 单测、38 PostgreSQL/API 集成、5 本地真实 Temporal 场景（其中 2 项新增），类型及双入口构建通过。独立进程场景使用临时、仅回环、一次性密码的 PostgreSQL；暂停时无意图，恢复后处理合成请求，SIGTERM 退出 0，第二个 PID 重启后同一 CLOSED 回执不变。其余测试覆盖异常项公平推进、容量、暂停错误、并发读者单次 Start、只读恢复及来源释放。

最终回归的本地进程证据：请求 `2d521e6b-1721-4e1d-b641-ea97c915791b`，运行器 PID `37717 → 37720`，均退出 0，Run `01a07187-97a4-7b52-8484-e5792fa3e900` CLOSED。测试目录 `/var/folders/8g/hb1c2xq156b15mbh1ljhkqs00000gn/T/v3-api-uxNL2L` 保留排查，测试服务已停止，临时证据不等于备份。

后续 CRAWLV3-10 已补入口交接进程 SIGTERM/SIGKILL 关键窗口、跨 Run 保守隔离和只读复核 CLI，见 [RECOVERY.md](RECOVERY.md)。这是独立新增的中断验收，不是把本项优雅停止测试算成硬杀测试。跨 Run 完整自动收口、真实业务 Worker 内部副作用恢复、持续运维和云端常驻部署仍待后续任务。
