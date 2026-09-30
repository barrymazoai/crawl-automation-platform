# 交接进程中断与只读复核

CRAWLV3-10，2026-09-05。范围是**入口请求 → Temporal Start → 终态登记**的恢复，不是所有 OCR、R2 或产品写入的事故恢复。沿用 [DELIVERY.md](DELIVERY.md) 的一次 Start 授权与 [RUNNER.md](RUNNER.md) 的独立运行器。

## 已验证的真实中断窗口

每个窗口分别向独立测试交接子进程发送 SIGTERM、SIGKILL，再启动真实 `src/delivery-server.ts`，连接同一隔离 PostgreSQL / 本地 Temporal。

| 中断位置 | 重启行为 | 合成 Activity 总调用次数 | 来源占用 |
| --- | --- | --- | --- |
| 意图事务提交前 | 首次创建意图、发送、核验终态 | 1 | 终态登记后释放 |
| 意图已提交、尚未 Start | 仅查证；NOT_FOUND 不能授权补发 | 0 | 保留 |
| 远端 Start 成功后、尚未确认 | 查同一 Workflow，不再 Start | 1 | 匹配终态后释放 |
| 终态登记前 | 根据远端结束事件补登记 | 1 | 与终态在同一事务释放 |
| 终态已登记 | 保留不可变 CLOSED 回执 | 1 | 不重复释放 |

这里 SIGTERM 使用测试检查点进程的默认信号退出，验证突然中断；不是拿它替代运行器的优雅停止测试。故障检查点只在 `temporal-tests/recovery-process.ts`，不进入业务构建。被中断的是交接进程，合成 Activity 在测试 Worker 中执行；没有对真实昂贵操作执行进程做断电/硬杀验收。

## 跨 Run：保守隔离，不自动追链

核验首事件的 `firstExecutionRunId`、`originalExecutionRunId`、`continuedExecutionRunId` 和 `attempt`。祖先字段缺失则证据不足；即使本地尚未记录过 Run，也不能把 retry/reset/Continue-As-New 后代误当成首个执行。

观察到 `IDENTITY_MISMATCH`、`RUN_CHANGED`、`CHAIN_CONTINUED` 后，仓储保留原隔离分类。之后收到匹配终态、NOT_FOUND 或 UNAVAILABLE，都不能覆盖分类、关闭回执或释放占用。普通核验仍可执行，但不是自动业务重试。

真实本地 Temporal 分别创建 Continue-As-New、Workflow retry 和 Reset；后代完成后仍保持隔离。生产 Gateway 没有启用 Workflow retry；测试的 retry 策略只用于负向场景。

尚未实现完整执行链追踪或隔离解除。管理员在核验后强制 Reset 旧流程不能由业务数据库跨系统原子阻止；必须限制运维权限，不能从 UI 绕过入口复活旧请求。已 CLOSED 回执保持不可变，只读复核能报告后续 Run 变化，但不会自动重新建立占用。

## 操作员只读复核

在仓库根目录，使用已确认目标的投递 profile（格式见 RUNNER.md）与显式 V3 本地库连接；凭据由私有环境注入，不写进命令历史或仓库：

```sh
# 预先设置 V3_DATABASE_URL；不读取旧 DATABASE_URL。
V3_REVIEW_CONFIG=/absolute/private/delivery-profile.json \
  pnpm --filter @crawl-automation/v3-api delivery:review <request-uuid>
```

不需要 `V3_DELIVERY_ENABLED`，不启动运行器或 Worker。远端仍需显式 mTLS；本地明文仅回环。连接开启 PostgreSQL 默认只读事务，复核对象只获 `get` / `inspect` 能力，没有 Start、record、reset 或 release。正式部署还应配 SELECT-only 数据库账号和只读 Temporal 身份；当前会话只读设置不是对抗数据库管理员的权限边界。

输出包括本地回执、远端证据、观察时间和 `mutatesState: false`，不输出原始产品内容或凭据。决策：

- `HOLD`：保留现场。检查 issue、request / workflow / run、输入指纹和目标；缺意图、身份冲突、跨 Run、无法连接或证据不足均不准重发。
- `WAITING_REMOTE`：观察到仍在运行，等待后续核验，不占用某个原子业务 Worker。
- `READY_FOR_RECONCILIATION`：当前观察支持正常运行器重新查证并登记；**本命令没有登记、放行或释放**，输出也不是可直接执行的授权凭证。
- `RECORDED_CLOSED`：本地已登记关闭，且此次远端证据未发现冲突。

没有任何自动消费此输出的恢复通道。需要人工复核时，把输出作为受控记录附到问题上；不要清 guard、改 request ID、删除意图或直接 Reset 来“重试”。即使 NOT_FOUND，也可能是响应丢失、目标错误或历史过期，当前实现会保持占用，直到另行设计并授权证据充分的恢复路径。

## 验证记录

```sh
pnpm --filter @crawl-automation/v3-api test
pnpm --filter @crawl-automation/v3-api test:integration
pnpm --filter @crawl-automation/v3-api test:temporal
pnpm --filter @crawl-automation/v3-api build
```

2026-09-05 21:09 本地累计通过：20 单测、39 PostgreSQL/HTTP 集成、18 Temporal 场景；类型检查与三入口构建通过。Temporal 场景包含原 5 项和新增 13 项（10 个真实信号窗口 + 3 个跨 Run 场景）。单测另覆盖只读复核能力与敏感异常脱敏；数据库测试验证隔离分类不会被后续结果抹掉。

本轮证据：`/var/folders/8g/hb1c2xq156b15mbh1ljhkqs00000gn/T/v3-api-y1mh3w/recovery-proof.json`。SIGKILL / after_start 请求 `2ff22b20-827f-4a36-a57b-698ed5728525`：被中断 PID 46560，重启 PID 46562，Activity 1 次，CLOSED，guard 0。SIGKILL / after_intent 请求 `4c299522-fac3-4a69-a001-048e6c544943`：Activity 0 次，START_UNKNOWN / NOT_FOUND，guard 1。证据目录保留但属于系统临时文件，不是持久备份。

测试服务和子进程均已停止。没有新增 SQL migration、修改现有持久业务库、读取旧库、重部署 Railway、改 Clash 或调用真实提供商。后续仍需原子模块内部副作用/凭证写入窗口、R2 跨机恢复、磁盘故障、Windows 及生产权限验收。本项仅覆盖 A06/A19/A22/A29 的入口交接部分，不宣称完整验收矩阵全部通过。
