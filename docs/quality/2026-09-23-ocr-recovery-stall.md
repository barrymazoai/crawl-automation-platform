# OCR 回收中断导致隔夜队列停滞

本次为只读故障分析。没有重启服务、释放许可、重排 Review 或修复部署；不能把以下诊断当作恢复完成。

## 已确认的事件链

- 2026-09-22 23:22:03 北京时间，`ocrFile` 被调度，心跳期限为 60 秒。Temporal 历史中的第二次 Activity 启动带有 `activity Heartbeat timeout`；该第二次执行随即以 `CHANNEL.RETRY_DENIED` 拒绝，未再次执行 OCR。最初心跳丢失的底层原因仍未确定。
- 23:23:05，`verifyResourceReviewStopped` 返回 `unknown`，没有 `releaseResources` 调用。保留的是许可 `permit-01a0c9b5-954b-7282-a374-a8760e9cf2ab-0`，资源为 `windows-ocr`；该商品/标签流程终止不等于已经核实远端执行停止。
- 23:32:58，自动回收创建第一次执行记录 `7ae7d8b7-41df-40f2-99aa-846882288a3f`，确认停止对象为 Mini 的 `amazon-channel-label-ocr` 和 Windows OCR 服务。Windows 已记录 `ocrStopRequested=true` 及旧进程 ID：13660、19288、16360、24360、8196。
- 紧接着停止检查报 `OCR stop failed`，未写入 `ocrStopped=true`。`finally` 分支再次报 `Partial OCR stop requires reconciliation`，没有重启 Windows OCR；Mini Worker 则被重新启动。
- 后续每轮生成新的回收 ID，没有续接第一次部分停止的记录。它们再查 OCR 父进程时找不到，报 `OCR owner ambiguous`，反复停止/启动 Mini Worker，既没有恢复 Windows OCR，也没有释放许可。
- 2026-09-23 09:18 核查时，Windows 没有 `python.exe`/`pythonw.exe` 进程；8081 监听者只有 Windows 的 `svchost.exe`（原 LAN 端口转发），不是 OCR Python 服务。Windows Text/Vision 在线不能证明 OCR 服务在线。五个旧 OCR PID 均不在。

停止命令的退出状态和紧随其后的进程查询被合并成同一个错误。保留证据不足以进一步断言首次检查失败到底来自非零退出码，还是进程尚未完全退出；不能把“现在已经退出”改写成“当时已确认退出”。

## 为什么之前的修复没有覆盖

既有停止核验保护在无法证明远端执行结束时保留许可，后续回收本应完成核验、恢复服务及释放。此次遗漏在后续回收本身：

1. 停止和恢复缺少跨轮次的持久进度续接；一次部分成功会使下一次流程假定的初始状态不再成立。
2. 父进程数量为零与数量大于一使用同一个 `OCR owner ambiguous` 错误；没有结合原停止记录检查“旧执行已经退出”的情况。
3. Windows 预检在 Mini Worker 已经停止后才执行，故每轮无效恢复都扰动 Mini Worker。
4. 恢复异常被健康文件简化为 `HEALTH_OR_RECOVERY_UNAVAILABLE` / `Error`，循环仍每约 14 秒重试，没有转入有明确原因的待恢复状态。

[前次超时回收记录](2026-09-22-timeout-resource-cleanup.md)明确记录：实操清理的四个异常来自抓取/模型执行；Windows 控制片段做过语法检查，强制退出分支没有实际故障验收。因此不能把此前结果扩大为 Windows OCR 全路径恢复已验证。

## 影响与修复验收要求

08:54 队列快照：completed 181、review 671、queued 4,422、ready 20、running 1；23:33 后无新增收尾。最后一个 running 是资源收尾未完成，不是 OCR 仍持续计算。Mini 90 个 Worker 进程就绪，健康守卫禁止新任务。

修复应先核对并续接首次停止记录，确认旧 OCR 执行消失，留存证据，再恢复原配置 OCR 服务并核实健康、释放确切许可；不能只改数据库许可或重新执行业务。用户随后明确要求任何报错均不再自动尝试，故清理报错也进入明确的人工核对状态，不再循环重启。应在 Mini/Windows 对故障分支逐项验收，不能扩大已验证范围。

## 本轮处置结果

2026-09-23 01:43 UTC 左右已按首次 intent/progress 精确核对：原 5 个 Python PID 全部不存在，OCR 执行器为 0，唯一许可对应的工作流已 COMPLETED。保存 R2 停止证明后只释放该许可，并手动启动 OCR 服务一次；没有重跑原商品。01:44:55 UTC 的 Mini LAN 检查确认 OCR 健康 4/4、held permit 为 0。

禁止重试及清理失败暂停的候选代码已完成主要验收，尚未切换上线：自动审批拒绝本次 29 个 Worker 的停止/替换，要求明确授权。队列 paused，旧健康恢复监控停止。详见 [资源生命周期审计](2026-09-23-resource-lifecycle-audit.md)。

远端证据：Mini `/Users/server/apps/crawler-v3/manual-releases/promises-20260922/failure-cleanup/`；Windows `D:\crawlv3-cloud\logs\failure-cleanup-7ae7d8b7-41df-40f2-99aa-846882288a3f\progress.json`。这里只记录必要标量，不导出完整私密配置或 provider 日志。
