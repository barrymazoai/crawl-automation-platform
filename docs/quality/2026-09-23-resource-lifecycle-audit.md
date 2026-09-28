# 2026-09-23 资源释放与禁止自动重试审计

## 用户本轮约定

- 超时即结束；任何报错都不再自动重试。
- 核对所有占资源、占槽位的地方，提供可直接阅读的代码。
- **只清理历史残留锁，不改变现行网络、Profile、OCR、Text、Vision 的限制。** 不删除浏览器配置、登录态、R2 证据或 Review。

## 已发现的问题

OCR 在 2026-09-22 15:22 UTC 开始，心跳超时后 Temporal 安排了第二次 Activity，但 Worker 的防重复执行逻辑拒绝第二次尝试。资源门没有停止证明，因此留下 1 个许可。随后清理程序发出 Windows OCR taskkill 后立即检查，把尚未完成的进程退出当成失败；第一次停止其实最终完成了，却没有恢复服务。监控每轮生成新的清理 ID，又反复重启 Mini OCR Worker，Windows 端则因为找不到已停止的 OCR 父进程继续失败。

详细事实见 [OCR 故障记录](2026-09-23-ocr-recovery-stall.md)。此前没有完成真实 Windows 部分停止场景的验收，不能把原有 finally helper 等同于所有异常均能释放。

## 代码修改

1. `packages/v3-product/src/channel-saved-workflow.ts`、`text-workflow.ts`：保留 60 秒心跳容忍，新的执行 `maximumAttempts=1`。
2. `resource-workflow.ts`、`brand-workflow.ts`、`apps/v3-workers/src/amazon-batch-workflow.ts`：新的控制 Activity 也只尝试一次。正常容量等待、只读进度检查不是重复执行业务。旧 Temporal 历史通过 `no-automatic-retries-v1` patch 保持重放兼容。
3. `packages/v3-artifacts/src/r2.ts`：移除适配器重试循环；AWS SDK 本来已为 `maxAttempts=1`。旧私有配置的 `retries` 字段仅为兼容而接受，不再生效。
4. `packages/v3-codex/src/connection.ts`：为当前 provider 强制 `request_max_retries=0`、`stream_max_retries=0`。Codex 0.147 不允许覆盖内置 `openai`：执行层使用独立 ID `crawler_openai_no_retry`，仍使用 OpenAI 原认证和默认端点，业务模型配置及指纹不变；HTTP-only 避免 WebSocket 失败后转 HTTP。启动检查同时拒绝该 ID 遗留的端点、认证或请求头覆盖。`codex-turn.ts` 对第一个 error（包括 `willRetry=true`）立即失败，finally 关闭本次拥有的进程。
5. `apps/v3-workers/src/stopped-evidence.ts`：停止证明写入不再循环重试。写入回复丢失时只读取核对一次，不重发同一写入。
6. `apps/v3-workers/src/recovery-attempt.mjs`：按 permit 持久化“一次清理”记录。进程崩溃、清理失败、下一轮出现新 permit、监控重启都不会触发同一 permit 的第二次自动清理。失败变为 `CLEANUP_FAILED_MANUAL_REQUIRED`，不重复停止/启动服务。
7. `amazon-queue-recovery.mjs`：taskkill 只发一次，最多 15 秒只读检查旧 PID 消失；不把立即采样或 taskkill 非零退出码单独当成存活证明。仍要求精确项目进程树，不杀浏览器或其他程序。
8. `amazon-queue-temporal.ts`：父任务还在检查进度、子任务已结束且许可未归还时，显示 cleanup-pending，不再显示普通 running 而 attention 为 0。

## 释放路径与限制

| 资源 | 正常/失败收尾 | 本轮识别的边界 |
| --- | --- | --- |
| 数据库资源许可 | 预约 ID 绑定 workflow/run；释放事务按相同身份核对；重复释放不会重复扣数 | DB 回复丢失不能凭异常推定未提交；需要只读核对。无停止证明不能伪造释放 |
| OCR HTTP | 返回响应可证明该请求已结束；本地超时会销毁请求 | 销毁客户端 socket 不证明远端 GPU 已停止。现服务没有按请求取消/查询 API；共享服务回收需先排空其他任务 |
| Text/Vision Codex | finally 等待精确子进程关闭；TERM 后有界等待，必要时 KILL，仍未退出则明确 STOP_UNCONFIRMED | 不把“发出 kill”写成“已关闭”；不结束无关进程 |
| 清理进程 | 一次停止 + 有界只读确认 + 证据 + 精确释放；服务恢复只执行本轮对应步骤 | 清理本身报错后人工核对，不自动再次整轮重启。当前回收器覆盖 Amazon/ScraperAPI 这条部署，不是全渠道通用浏览器回收器 |
| 页面/Profile | 精确 task-owned 页面关闭后有界核对；任务与 Profile 数据分开 | 不关整个浏览器。用户控制边界下只能记录 cleanup pending，不能抢占控制或删除原生锁 |
| 下载与文件租约 | finally 销毁响应并释放已获得租约 | 原业务失败时部分租约释放异常可能被抑制，属于后续需加强的可观察性缺口 |
| Worker 本地执行槽 | Activity 完成/抛错后由 SDK 归还；受本机并发配置约束 | Worker 突然退出并不自动停止外部子进程；需要停止事实检查 |
| PDF 子进程 | TERM 后 KILL，等待 close 再返回 | 极端未收到 close/父进程崩溃仍缺独立孤儿回收覆盖，不能宣称所有资源都已实机验收 |
| DB 连接/事务 | finally 归还连接；事务结束释放 advisory/row lock | 网络失联时提交结果不确定，不自动重做业务 |

“任何情况下都释放”的可执行含义应是：结束实际执行并核实，再归还许可。无法证实时，必须明确暂停和报错；单独删除许可只会隐藏还活着的执行并导致超额并发。

## 历史锁检查

- 美国 Mini `/Users/server/apps` 的部署目录检查：没有 `writer.lock` / `owner.json` 遗留文件；未释放许可仅 Windows OCR 的 1 条，不属于网络/Profile 残留锁。
- 本地旧 Mini `/Users/barry/apps/crawlv3-default-clash.0A8kyC/state`：无 writer.lock；33 条旧网络 lease 已 closed；另 1 条对应下述尚存 Chrome。
- `/Users/barry/apps/crawlv3-browser-profiles/gnc/gnc-washington/owner.json`：原 Node PID 21996 已不存在，但原生 SingletonLock 指向 **仍在运行的 Chrome PID 22009**；其命令行的 user-data-dir 精确匹配该 Profile。因此保留 owner/lease/native locks，不能按原控制进程已死就清空。
- 现行锁机制、配置、容量均未修改；未删除锁文件。

## 验证和上线状态

独立分支 `fix/no-retry-resource-cleanup-20260923`，美国 Mini/Windows 均通过 Git 获取候选代码，在目标机构建。**已按用户批准完成 29+2 Worker 切换，并恢复原队列。**

- Mini 类型检查及构建通过；持久化清理的失败、崩溃、并发三项测试通过。
- 验收集首次执行：356 项通过；56 项依赖旧公开样本，因新机器缺少 fixture 目录未能执行。缺少 initdb 的数据库测试改用已安装 Docker PostgreSQL 18.6 独立实例，旧 Codex 断言修正后，定向 28 项全部通过。最终队列修正后另跑 10 项全部通过；原失败商品及标签的实际历史回放均通过。
- 真实 Codex CLI + 本地假接口：HTTP 500、流中断、正常成功均通过；旧私有配置即使为 4/5 次重试，新的调用参数仍令故障请求只发一次。真实模型请求数为 0。
- Windows 第一候选构建通过；其 OpenAI 配置兼容性问题由 Mini 切换发现，因此没有切换该 Windows 候选，改为重新 Git clone 构建修正版。
- 01:43 UTC 左右，一次性核对首次停止记录：原 5 个 Python PID 全部不存在，OCR 执行器为 0，原工作流 COMPLETED，唯一 held permit 身份相符。停止证明成功保存至 R2 `v3/manual-batch-cleanup/ocr-reconciliation-20260923/proof.json` 后，释放唯一许可并手动启动一次 OCR 服务。
- 01:44:55 UTC，Mini 经 LAN 验证 Windows OCR 健康 4/4；所有 held permit 为 0。
- 01:50:58 UTC：队列 paused；queued 4,442、Review 672、completed 181、running 0；90/90 旧 Worker 就绪。新增的第 672 个 Review 是原悬挂任务完成收尾，没有重跑业务。

用户已明确授权“允许按执行单切换并恢复队列”：手动切换 Mini 29 个 Amazon Worker、Windows 2 个 Text/Vision Worker，保持原限制，健康通过后继续既有 4,442 条未执行任务；不重排 Review、不安装开机/登录自启。此前自动审批所需的授权已补齐。

## 切换验收记录

- 第一候选启动了 9 个 Worker，Text 启动检查失败，队列始终暂停。定位到新增参数试图覆盖 Codex 保留的 `openai` ID，已停止该失败服务，保留第一候选和阶段记录。此前真实 CLI 假接口测试仅覆盖自定义 provider，漏掉内置 ID 兼容性，这是本轮补上的验证缺口。
- 修正版使用独立 Git clone 路径 `releases/no-retry-20260923b/source`，不覆盖已加载文件。Mini 类型检查、构建和 68 项 Codex/Text/Vision 回归通过；实际 Text、Vision 私有配置的只读启动检查均通过，不创建 thread/turn。生产模型和并发未修改。
- 修正版真实 CLI 故障验证再次通过：HTTP 500、流中断、正常成功各仅 1 次 HTTP 请求，真实模型请求为 0。
- 02:07:10 UTC，Mini 29 个 Amazon Worker 已全部完成切换；全机 90/90 就绪，OCR/R2/交接依赖全健康，队列仍暂停，等待 Windows 切换。
- Windows 修正版 buildId 为 `05cc51d0e0bd5be8a3c71bca4b1ae1c8f2e920c477451e46f6ccb19c65e3584e`。两份实际配置初始预检通过；首次切换 Text 就绪、Vision `blocked_startup`，没有自动重启。随后独立 Vision 图像能力、完整角色初始化、Temporal 连接检查全部通过。首次错误仅有通用 `WORKER_FATAL`，具体原因未证实；保留失败现场，在原授权范围内记录一次人工启动续接，不重跑业务。
- Windows 切换前排空检查补充了精确父进程下的系统 `conhost.exe`，优雅停止后要求旧 Node 和对应 conhost PID 全部消失；不结束其他进程。PS1 仅使用单次进程执行策略，不修改系统持久策略。
- Windows 人工续接后 2/2 就绪：监督 PID 25128、Text PID 20792、Vision PID 12440，当前 generation 均为 1、restartCount 为 0；旧进程已全部退出。首次 Vision 启动具体原因仍未证实，没有把暂时恢复写成已定位根因。
- **02:18:37 UTC（北京时间 10:18:37）恢复队列**：放行前 Mini 90/90、Windows 2/2、OCR 4/4、held=0；原 4,442 个未执行条目继续运行，原 672 条 Review、181 条 completed 保持原状态。ready_limit=20、running_limit=80 及所有 Worker runtime 字段（除构建 ID）与原配置一致。
- 02:19:49 UTC 的首批观测：running 80、ready 20、queued 4,342、Review 672、completed 181、attention 0；健康可继续投递。抽查 8 个新标签工作流，已调度 Activity 的 maximumAttempts 均为 1。此时 held=27 是新执行正在使用的许可，不是恢复前的历史残留。Windows 可用内存约 19.6 GiB。
- 02:20:44 UTC：仍为 80 running / 20 ready / 4,342 queued，attention 0、健康可继续。14 个 held permit 属于 13 个 RUNNING 的 owner，terminal owner 为 0；抽查三个执行历史共 83 个已调度 Activity（含 OCR、Vision、资源申请/释放）全部 maximumAttempts=1。Windows 可用约 19.5 GiB、CPU 45%。
- 手动启动了新版 health/queue 两个项目服务；它们的 RunAtLoad/KeepAlive 均保持 false，没有安装开机/登录项。
- 验收记录：Mini `manual-releases/no-retry-20260923b/resume-preflight.json`、`queue-resumed.json`、`post-resume-observation.json`；Windows `logs/no-retry-20260923/` 保存首次失败现场，`logs/no-retry-20260923-verified-start/` 保存人工续接。
- 上游行为依据：[Codex provider 配置结构](https://github.com/openai/codex/blob/main/codex-rs/config/src/config_toml.rs)、[OpenAI provider 默认认证和端点](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs)。部署还使用本机实际 CLI 验证，不仅依据文档。

执行脚本：[Windows 一次人工续接](../../apps/v3-workers/scripts/resume-no-retry-windows-20260923.ps1)、[Mini 激活](../../apps/v3-workers/scripts/activate-no-retry-20260923.mjs)、[Windows 激活](../../apps/v3-workers/scripts/activate-no-retry-windows-20260923.ps1)。修正版以 `--corrected` 保存独立阶段记录；部分执行失败须核对记录，不能盲目重跑。
