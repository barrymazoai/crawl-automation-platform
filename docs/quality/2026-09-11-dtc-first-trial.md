# Innerbody Windows DTC 首次真实试单

Windows 原生构建已确认通过 `b4e321f` 的跨平台 buildId 校验，三个浏览器 Worker 启动成功。本次从正常 Brand HTTP 提交入口发起试单，没有直接调用 Activity 或插入业务记录。

## 投递与实际结果

- 先核验 Windows 节点会话 `6db4ecd9-1e74-4b0e-a091-6c6d261938c4` 正在运行，Windows 浏览器及 Mini 模型资源心跳健康；无业务 Workflow、无占用许可、无提交 guard，已有 schedule 全部暂停。
- 原 Brand Web 配置没有 DTC channel target。备份私有配置后加入已部署的 DTC 队列，在无业务任务时正常重载原 Mini 服务；90/90 Worker 及依赖恢复。DTC 26 个配套角色和 Windows 会话保持运行。
- `2026-09-11T08:45:17.363Z`，正常 POST `/api/v3/brands/:brandId/sources/:sourceId/submissions` 返回 202。requestId：`45d1252f-a103-4bd0-bfcb-fa30f94386c4`，Innerbody source revision 1，限定 Astaxanthin variant `44807968882774`。
- Brand Workflow 成功投递至 `v3.dtc.control.v1.dtc-live-v2.session.dtc-innerbody-v2-20260911`。Windows `windows-dtc-catalog-source` 实际接到 readCatalogPage，attempt=1；Mini 控制校验返回 allowed=true。
- 目录 Workflow `v3-collection-45d1252f-a103-4bd0-bfcb-fa30f94386c4-catalog`（runId `01a08fa4-8776-70c6-a617-3432b33a725e`）以 incomplete 结束，readCatalogPage 报 `DTC.PAGE_EXECUTION_CONFLICT`。发现商品数 0，未进入商品页、原图、OCR 或标签链。
- 为结束父流程等待隔离许可的轮询，只取消这次失败试单的 Brand 父 Workflow，终态 CANCELLED。保留全部 R2/本地证据及原许可，不重试、不 reset、不清除许可。首次页面清理仍待 Windows 账本及实时 target 清单核验，不能据代码路径宣称现场验收通过。

Mini 现场证据保存在 `dtc-innerbody-v2-20260911/trial-20260911`，包括提交意图、API 回执、父/目录历史及取消报告。

## 根因与修复

Temporal SDK 1.23.0 将 protobuf WorkflowExecution 对象直接放入 Activity context。原页面绑定把该对象写成 JSON，第二次绑定时使用 isDeepStrictEqual 比较 JSON 普通对象与 SDK 对象，原型差异造成误判。目录读流程会先绑定、打开页面，再在 reader 中二次绑定，因而真实首单立即暴露此问题。

新增 dtcExecutionIdentity，仅复制 workflowId 和 runId 为普通对象，再进行持久化和严格归属比较；真实不同 runId 仍被拒绝。没有放宽页面归属或用户接管边界。

验证：

- TypeScript 与 build:dtc 通过，18 个 JS；逐字节比较确认只有 dtc-browser-worker.js 改变，Mini 执行 JS 和 product-workflows.cjs 均未变。
- Mini 运行 dtc-node-control、dtc-stream、cdp-task-pages：20/20 测试通过，包含真实 Activity context 的 JSON 往返比较、不同 runId 拒绝、Continue-As-New、成功/失败/取消、页面清理及 15 份历史重放。
- Mini 使用临时同队列配套 Worker 维持节点心跳，再更新原路径，最后正常退出临时 Worker。没有变更容量、队列、来源或凭据。原路径新 supervisor PID 82404，26/26 ready。
- 新 Activity build：`bf267f4d7a2933b4a0898442c7b9d7d624df66568fc6845c3f1c5f3701a30d9a`。
- 新 Workflow build：`2f4301db775ead58dbbf4222f55343ca15577544376c692d1011fbdb2daef67a`。它是全部 JS 加 Workflow bundle 的组合标识，因此 Windows 入口变化也会改变此值。
- Git routing 与 Mini 实际 routing 完全一致。

Windows 尚未应用本次页面身份修复。后续按 [Windows 修复执行说明](../../apps/v3-workers/deploy/innerbody/WINDOWS_TRIAL_FIX_PROMPT.md) 核对页面、正常停止、从 Git 构建并更新。取得精确清理证明后再恢复隔离许可、发起新的 Brand 请求；目前不能宣布真实采集通过。
