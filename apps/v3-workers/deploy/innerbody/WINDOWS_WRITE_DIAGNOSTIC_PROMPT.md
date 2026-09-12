# Windows Codex：只核查 Testosterone 的写入问题，暂不部署或发单

本阶段只检查上一轮采集的文件写入问题。代码可从现有仓库 main 拉取，保留全部 tracked 修改、untracked 文件和历史证据。不要替换 release、生成新 private、重启 Worker、重启 Chrome、提交采集任务或重跑历史任务。等待主会话根据诊断结果完成最终修复后，再统一部署并测试。

目标信息：

- 节点目录：`D:\crawlv3-dtc-v2`
- Request：`294846ca-3c4d-4e56-9926-6bd2032c3d0e`
- 商品：`https://shop.innerbody.com/products/testosterone-support`
- Capture operation：`dtc-capture-e67c951945ece6d4ab46478d4762a456905450ff137fb7dff88fa5d5eb4a6334`
- 当时代理返回：`filesystem_write_permission_required`，自述无法写入脚本、records.json、HTML 和图片。这段自述尚未被确认为实际操作系统拒绝。

连续完成以下检查，结果只输出非敏感摘要：

1. 读取现有 settings 和当前 release 对应的运行配置，在本机定位 codex.workRoot，以及该 operation 对应的 `legacy/<SHA-256(operationId)>` 目录。不要输出 settings 全文、环境变量全集、凭据或私钥。记录当前 release/build、Worker 精确 PID 和会话编号，方便判断检查的是哪个运行环境。

2. 在该任务的 events.jsonl、result.json 和关联日志中查找实际工具调用与执行结果。回答：代理有没有尝试写文件？尝试写哪个任务内路径？执行结果是成功、EACCES/EPERM、审批拒绝、沙箱拒绝，还是没有发生任何写入尝试？若只看到模型说“只读”，必须标成“代理判断，尚无实际拒绝证据”。只提供错误码、工具调用编号/时间和本地证据路径，不复制整段原始日志。

3. 核对任务子会话的真实启动方式。对照**当前部署的 release** 与对应 Git 源码中的 DtcLegacyCapture、CodexProcessRunner：cwd、addDirectories、用户身份、approve-for-me/实际沙箱模式如何传给子进程，有没有在会话启动时被覆盖。不得用这一个外层 Codex 会话的权限，推断 Worker 启动的内层会话权限。检查任务目录及其父目录的 NTFS ACL，记录与当前运行用户相关的结论，不修改 ACL 或全局配置。

4. 若历史日志不足以判断，在 `codex.workRoot` 内新建唯一的诊断目录，通过**与当前 Worker 相同的 CodexProcessRunner、同一 executable、codexHome、模型设置和现有审批机制**启动一次无浏览器诊断子会话。只替换 cwd/输出路径为这个新目录；保持原有权限设置，不额外扩大 addDirectories。该子会话只做：在 cwd 新建 `write-probe.txt`，写入固定字符串，读回比对，然后删除它。不得传入 CDP URL、浏览器任务文件或业务凭据，不使用任何浏览器/MCP。控制在 120 秒内；保留诊断结果与日志，只删除测试文本文件。停止该诊断时只处理它自己的子进程，不能停止现有 Worker。

5. 不得增加 bypass 参数、关闭 sandbox、修改全局安全策略，或先提升权限再把结果报告为原环境正常。遇到审批边界，使用已有正常审批方式；未获得批准就记录“检查未完成”。普通 Node/PowerShell 写入成功只能说明操作系统目录可写，不能替代上述采集子会话检查。

最终按下面格式回报：

```text
当前 Git / 实际运行 release：
原任务是否发生写入尝试：是 / 否 / 日志不足
原任务写入结果与错误码：
子会话实际权限模式（非敏感摘要）：
同环境最小写入测试：成功 / 实际拒绝 / 未完成
最可能的问题所在：目录 ACL / 子会话启动配置 / 代理提前停止 / 尚不能确定
支持判断的本地证据路径及调用编号：
现有 Worker 是否保持原状：
是否提交真实采集：否
```

不要擅自修权限或部署新 Worker。先回报上述结果，由主会话据此完成修复，再进行统一部署和下一轮采集。
