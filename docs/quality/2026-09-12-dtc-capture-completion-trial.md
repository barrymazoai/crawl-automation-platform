# Innerbody 全站实测：采集与收尾修复

## 最终业务结果（2026-09-12）

本轮全部结束：官网目录发现 7 项，4 个商品 collected、3 个 Review、0 个 skip；无在途提交、遗留许可或提交锁。Sleep 在 Focus 占用完成证据核验并结算后继续完成标签及入库。没有重发本轮或修改历史 Review。

Windows 在 11:24:28 UTC 完成节点停机。用户返回的本机诊断与 Mini Temporal 历史均表明：Focus 脚本确实已经写入并运行；健康更新在服务端完成前，客户端进入统一停机，随后正在执行的 Codex 被 Worker 停机流程中止。客户端等待超时是有力推测，但原始日志未保存错误码，不能确认 DEADLINE_EXCEEDED 或具体底层异常。

本报告区分本轮旧版本实测结果、Windows 用户转述的现场证据，以及随后修复代码的测试；新的 Windows release 尚待现场部署。

## 本轮身份

- Request：5c5bf085-e9a8-46ee-861a-b0827be3005c。
- 入口：https://shop.innerbody.com/collections/all；source revision 1；selectedUrls=null。
- 部署源码 21e828a，部署说明 40de059。
- Activity：6238cd70d289947f7f29560012ada49b10d9ff190bcc84e5167d9974bd862e30。
- Workflow：3c3e8fd5381d30ef3d55cb1dfe2115afd7b4a4fedfa5af9339a3e94b0f1dcad0。
- Mini 证据目录：dtc-innerbody-v2-20260911/full-catalog-completion-20260912。

用户确认 Windows 已部署后，核对三个 poller 使用上述版本、五项资源健康、无遗留许可和提交锁，通过正常 Brand HTTP 入口提交了一次请求。

## 商品结果

| 商品 | 业务状态 | 已核验采集证据 |
| --- | --- | --- |
| Astaxanthin+ | collected | 3 原图、3 变体、HTML，12 文件 |
| CoQ10 Advanced with Urolithin A | collected | 3 原图、3 变体、HTML，12 文件 |
| Testosterone Support | collected | 6 原图、3 变体、HTML，15 文件 |
| Sleep Support | collected | 5 原图、3 变体、HTML，15 文件 |
| Focus + Sleep Bundle | Review 保留 | 原始明确 bundle_or_pack 排除、records/failed 空；7 文件 |
| Focus Support | Review：停机中断 | 实际根目录脚本和进程诊断已保存，无正常完成 manifest |
| NAD+ Support | Review：Windows 不可用，未开始采集 | 未创建采集任务页面 |

目录原始 HTML、截图、catalog.json 三件证据完整。宿主探针观察到目录 28 个链接，归并后与 7 项发现一致；官网 products.json 第 1 页 HTTP 200 / 7 商品，第 2 页 HTTP 200 / 0 商品。没有以缺少 next 按钮代替目录结束证明。

目录及已完成/明确排除的采集共 64 个原始文件逐件通过长度与 SHA-256 核验；业务链引用的 48 件 R2 artifacts 另行通过核验。两组存在重叠，不能相加为去重文件数。没有正常 manifest 的 Focus 不计为文件验收成功，也不能据此断言 Windows 本地没有生成部分文件。

## 标签调用验收

| 商品 | 选中图库图（从 1 开始） | OCR | 视觉 | 文本 | 选中完整图后的新增识别 |
| --- | --- | ---: | ---: | ---: | ---: |
| Astaxanthin+ | 第 2 张 | 1 | 1 | 0 | 0 |
| CoQ10 | 第 3 张 | 2 | 1 | 0 | 0 |
| Testosterone Support | 第 3 张 | 1 | 1 | 0 | 0 |
| Sleep Support | 第 3 张 | 1 | 1 | 0 | 0 |

四项均在找到完整标签后停止其余识别，保留剩余原图和 HTML；数据库 record hash 与 Workflow 返回一致。CoQ10 在确定完整图前检查了两张候选图，不能描述为所有商品仅调用一次 OCR。

## 套装误判与已完成的安全恢复

原始 harvest 唯一排除当前套装 URL，reason=bundle_or_pack，records 和 failed 均为空。模型返回 scope_conflict_bundle_target，旧适配器固定原因白名单漏掉该名称，转成 capture_review。Mini 核验停止证明时又将 SDK 的 protobuf WorkflowExecution 与普通 JSON 对象深比较；身份字段均正确，但原型不同导致 DTC.CAPTURE_STOP_UNVERIFIED，隔离两项许可。

已在 Mini 复现：原始 SDK 对象深比较为 false，只保留 workflowId/runId 后为 true；其他证据核验逐项通过。恢复时重新读取真实 Workflow 历史、正常 CLI 退出、精确关页回执、R2 停止证明和原始文件，并调用同一核验器核对规范化身份。先留存完整恢复证明和历史，再只释放该已结束任务的两个许可。原 Review 未改成 skip，未重发任务。

R2 恢复证明：v3/dtc-trial-recovery/5c5bf085-e9a8-46ee-861a-b0827be3005c/bundle-protobuf-verifier-verified-close.json。

## Windows 后续停机

Focus operationId：dtc-capture-5948db44fa9dc49d4e83d123e37bec5d59677b08b86c33f837a109cdabdec121。

该任务根目录脚本 4994 字节、SHA-256 为 47e6241dcf7aef9d64bdc927f6763298d12d95e058f70ef8874bcd099329be70，证明脚本已写入。Codex PID 19464，11:19:20.261 开始，11:24:06.962 结束，exitCode=1、aborted=true；没有正常 result/manifest。

Windows 节点 Workflow 的 dtcNodeStop 在 11:24:28 完成，runId 01a09524-0819-74af-9a66-5c79985cba37，sessionId 39200a88-e675-4179-a8cf-89e998c1c862。节点服务端历史没有 Activity failed/timed-out 或 Workflow task failed，这不代表 Windows 客户端等待成功。

用户返回的 Windows 诊断记录：健康更新 570 在 11:23:06.345 被接受，571/healthy=false 在 11:23:06.890 被接受；570 在 11:23:07.176 才完成。三个 Worker 在本机时间 11:23:06.797 同时开始 drain。两端时钟不能作毫秒级对齐。代码串行 await 健康调用，异常进入 finally 上报 false 并统一停机；这些证据支持“健康调用等待失败后停机”。旧 stderr 仅 DTC.NODE_COMMAND_FAILED，未保留具体异常。Chrome 仍运行，不支持 Chrome 崩溃或脚本写入失败的解释。

Windows 本地 Focus 已生成 1 HTML、5 原图、1 商品记录、3 变体，收尾脚本检查/执行退出 0；但 Codex 没有 turn.completed 或最终 result.json。这些是用户转述的本地部分产物，不能据此改成业务采集成功。

Mini 重新核验 Focus 精确 run：capture Activity 已 WorkerShutdown 终止、重试耗尽；close Activity 未开始，最终 ScheduleToStart 超时；父 Workflow 已 terminal Review，无 pending Activity、重试或子 Workflow。Windows 节点已 COMPLETED/stopped，浏览器资源 controller=null，无新 poller。R2 保留的脚本与 Codex 进程退出诊断符合上述身份。

### Focus 许可结算

用户提供当前精确 targetId A44FF7F40379FB23220A27BEEE46591D、同 Chrome 实例、三次 targetsAbsent=true；closed.json SHA-256 为 2ec245298a023664c7183b693bc696759f9121cf07c0a3ea1f90dff734d0d893，page-proof.json SHA-256 为 c5596af666a537b6458e8e2f0bbbc2c8b6cefd86195d35ddc8a59142ad4f1a56。

Mini 不具有该 Windows 本地文件和 CDP 的直接访问能力。恢复证明明确记录为 user-relayed attestation，不声称已直接读到这些原始文件。结合真实终态历史、无重试/在途活动、节点已停、R2 任务诊断，先保存完整证明及历史，再只释放 permit-01a09531-2eff-7953-b1ca-3f7e743bb4bf-0/-1。未删除本地账本或改写 Review。

R2 恢复证明：v3/dtc-trial-recovery/5c5bf085-e9a8-46ee-861a-b0827be3005c/focus-stopped-windows-attestation.json；相邻 -history.json 保存完整历史。Mini 本地 full-catalog-completion-20260912/focus-stopped-verified-recovery.json 保存核验结果。

## 修复与验证

源码提交：

- 091a372a253b53c8bae96ca649f1704b9bbb1192：套装根据严格原始排除证据分类；停止证明比较规范化 workflowId/runId，避免 protobuf 原型差异。错误身份、缺少证据和混合失败仍不能通过。
- 9f1ecd993776a37c53e7b2a59df86c3666e40574：健康调用回执不明时，锁定原 Workflow runId，用同一 updateId 读取结果；只有 NOT_FOUND 才原样补发一次。最多两次结果核对，默认总 RPC 预算 75 秒，明确拒绝、取消和无法确认仍走停机。新增 node-events.jsonl 和结构化 stderr，保留脱敏异常链、sequence/updateId/runId、耗时、恢复结果、停机阶段及进程退出信息。

本地 build:dtc 和类型检查通过。Mini 四组 46 项测试通过，包含套装、停止证明、健康恢复、日志及 CLI 实际退出行为；最终日志字段微调后，相关 12 项测试再次通过。实际 Temporal 测试分别模拟“服务端已接受但回执丢失”和“尚未接受就连接失败”，核实同一 sequence 只应用一次，恢复成功后维持 healthy。

14 条真实终态历史全部回放通过：节点、品牌、目录、7 个商品和4个标签 Workflow。新 product-workflows.cjs 与本轮运行版本逐字节相同；构建 ID 因共享可执行产物改变而更新。

最终 release：23 个 JS；Activity=7f0f01ebd46f7b4469ef0f6459701c4723d77d2b1aea9eae1855420cb67da464；Workflow=fc4d8ef57f5e8b322d02a5ce55e1e5bbc149c4563096bb0a7b79fb98686ffa33。公开部署配置以 apps/v3-workers/deploy/innerbody/deployment.json 为准。

此外，真实脚本曾出现计划/API/PowerShell 使用错误，模型在任务内修改后完成部分商品。若干命令记录 exitCode=1 但保留输出没有具体异常，不能写成“全部命令均退出 0”。这些记录不支持把当前问题归因为目录写权限。

## 精确关页回执

以下来自成功的 closeDtcProductPage Activity。该实现只有在任务目标及其子目标已消失后返回 closed；本机未独立直连 Windows CDP。目录由成功的宿主 pages.using 收尾，但未在本轮外部证据中取得其精确 targetId。Focus 使用上述 Windows 转述现场证明，并与 Mini 实际历史结合核验。

| taskId | targetId | 结果 |
| --- | --- | --- |
| dtc-page-f40d5dc7caa6398cb5fbec02bf477a4177ddafc95ecca7c074a41e561b2ac88b | EC5635D0512A77CF9697228E6A244F75 | closed |
| dtc-page-bf9ce3286c1eabec7c404c398d146c25ad574e9dbb8e292942e5adaaa7c64b69 | 20DD0BC8E95D7D1D544D541F86788234 | closed |
| dtc-page-b51248188329becb8f5454b1f9190ac258f2d9450f076579e16ea4e53275e27f | 9DEB27824559A0A595BC6AB64578174C | closed |
| dtc-page-3d817854fde641c2a5500610cbc8ad3d153b8f12959b0b34ffa5a50a0096ddbe | 803E57E3CDC35E66A86052A79BFB274B | closed |
| dtc-page-f8f08082b61c3d60a3282170ec116c5bee50cae89b2a3e1f492af3b2e68c215d | 5F4D8D2023C29C8656BABC83C93D2247 | closed |

## 部署交接与证据索引

本轮 ended-health.json 确认：全部相关 Workflow 完成、旧 Windows 节点停机且没有最近 poller、四项其余资源健康、held=0、sourceGuards=0、activeSubmission=null。先备份 release/private/settings，再更新 Mini 的 DTC 26 个配套进程；基础 90 个进程保持运行。

Mini 新 Supervisor PID 26737，26/26 ready；基础 Supervisor PID 56831 保持原进程。发布后的 ready 和连续健康证明记录在 dtc-innerbody-v2-20260911/node-health-fix-roll.json、node-health-fix-health.json。Windows 仍需按 [完整部署 Prompt](../../apps/v3-workers/deploy/innerbody/WINDOWS_CAPTURE_COMPLETION_PROMPT.md) 获取 main 并重建启动。保留原有 .gitattributes 修改，已有凭据原样复用，不需要新私有附件。Windows 新版确认就绪后，再通过正常 Brand 入口提交下一轮；此次没有提交新轮次。

Mini 根目录 /Users/barry/apps/crawlv3-batch-a.UiA4dx 下的证据：

- dtc-innerbody-v2-20260911/full-catalog-completion-20260912/monitor.json、records.json、各 Workflow.history.json：最终业务状态及原始历史。
- 同目录 capture-audit.json、artifact-audit.json、single-label-policy-audit.json、ended-health.json：原始采集/R2 文件、标签调用和最终占用状态。
- dtc-node-health-fix-tests/test.log：46 项测试；dtc-node-health-fix-tests-final/test.log：最终相关 12 项测试。
- dtc-node-health-fix-replay.json：14 条真实历史回放结果。

这些证据保存在 Mini/R2；本报告不包含私有配置和凭据。
