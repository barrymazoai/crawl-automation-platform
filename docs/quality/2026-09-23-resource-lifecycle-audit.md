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
4. `packages/v3-codex/src/connection.ts`：为当前 provider 强制 `request_max_retries=0`、`stream_max_retries=0`。`codex-turn.ts` 对第一个 error（包括 `willRetry=true`）立即失败，finally 关闭本次拥有的进程。
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

独立分支 `fix/no-retry-resource-cleanup-20260923`，美国 Mini/Windows 均通过 Git 获取候选代码，在目标机构建。**候选版本尚未上线。**

- Mini 类型检查及构建通过；持久化清理的失败、崩溃、并发三项测试通过。
- 验收集首次执行：356 项通过；56 项依赖旧公开样本，因新机器缺少 fixture 目录未能执行。缺少 initdb 的数据库测试改用已安装 Docker PostgreSQL 18.6 独立实例，旧 Codex 断言修正后，定向 28 项全部通过。最终队列修正后另跑 10 项全部通过；原失败商品及标签的实际历史回放均通过。
- 真实 Codex CLI + 本地假接口：HTTP 500、流中断、正常成功均通过；旧私有配置即使为 4/5 次重试，新的调用参数仍令故障请求只发一次。真实模型请求数为 0。
- Windows 独立候选构建完成，buildId `f8f721fb00a60443234f79ed70bef80c1651ae4fa2d7bef01856f566054999d0`。
- 01:43 UTC 左右，一次性核对首次停止记录：原 5 个 Python PID 全部不存在，OCR 执行器为 0，原工作流 COMPLETED，唯一 held permit 身份相符。停止证明成功保存至 R2 `v3/manual-batch-cleanup/ocr-reconciliation-20260923/proof.json` 后，释放唯一许可并手动启动一次 OCR 服务。
- 01:44:55 UTC，Mini 经 LAN 验证 Windows OCR 健康 4/4；所有 held permit 为 0。
- 01:50:58 UTC：队列 paused；queued 4,442、Review 672、completed 181、running 0；90/90 旧 Worker 就绪。新增的第 672 个 Review 是原悬挂任务完成收尾，没有重跑业务。

自动审批拒绝了停止 29 个现有 Amazon Worker 并替换线上部署配置，理由是此前授权只覆盖有限 Worker 维护/测试，没有明确覆盖本次较大范围切换。未执行该命令，目标激活目录尚未创建，旧构建仍在使用。队列保持暂停，健康恢复监控保持停止，避免旧重试逻辑继续运行。

待批准的完整操作：手动切换 Mini 29 个 Amazon Worker，以及 Windows 2 个 Text/Vision Worker；保持所有资源容量和并发不变；核对健康后手动启动新版队列/健康监控并继续既有 4,442 个未执行条目；不重排 Review，不增加开机/登录自启。

执行脚本：[Mini 激活](../../apps/v3-workers/scripts/activate-no-retry-20260923.mjs)、[Windows 激活](../../apps/v3-workers/scripts/activate-no-retry-windows-20260923.ps1)。二者保留旧配置，部分执行失败后须按留下的阶段记录核对，不能盲目重跑。
