# 独立文本回执 Worker

2026-09-07：上游新增 [PageTextWorkflow 与页面角色](PAGE_WORKERS.md)，可从已保存 HTML 自动生成可靠 TextDocument 和 V2 输入，再进入本链路。本文 PreparedTextWorkflow 仍是只接已发布文档的低层入口；产品文本/图片汇合未接。

`text-receipt` 是核验角色，不是 Codex 执行角色。入口 `src/text-receipt-worker.ts`，命令 `pnpm --filter @crawl-automation/v3-workers worker:text-receipt`。只注册 `resolveTextReceipt`，不注册 interpretText，不启动模型、OCR、浏览器或 Python。

## 配置和部署

先运行 `pnpm --filter @crawl-automation/v3-workers build`。需同时显式设置：

- `V3_WORKER_ENABLED=true` 和绝对路径 `V3_WORKER_CONFIG`。
- `V3_TEXT_RECEIPT_LIVE_ENABLED=true` 和绝对路径 `V3_TEXT_RECEIPT_CONFIG`。

业务配置沿用 [文本 Worker](TEXT_WORKER.md) 的 storageId、cacheRoot、ocrJournalRoot、textLocalRoot、r2、r2Credentials、resultDatabase、reviewDatabase 字段，**删除 codex 字段**。这些目录是本进程的私有缓存/核验日志，不是上游 Worker 文件路径。允许空缓存节点启动；不要求共享本机目录。

配置必须是最大 64 KiB 的普通文件，拒绝符号链接，POSIX 权限 0600。结果数据库只需 processing_result 的 SELECT，Review 数据库需 review_record 的 SELECT/INSERT。共享对象存储只需受限前缀 GET；回执角色不发远端 PUT，不补登记，不执行自动迁移。Review 的本地证据会保留。

通过入口 `--list` 读取构建元数据。role=`text-receipt`，capability=`text.receipt`，contractVersion=1，compatibility=`text-receipt-v1`，队列为 `v3.text.receipt.v1.text-receipt-v1`。buildId 必须与本次构建一致。`--list` 不连接数据库/Temporal/存储，不打开 Codex 配置或账号。

通用 runtime 的 hostId、并发、关停时间与 mTLS 配置不变。远端 Temporal 不接受明文配置。每个 Activity 最大尝试 1，每 2 秒心跳；下游等待由 Workflow 承担。

## 核验规则

输入 `TextReceiptInputSchema`：原 TextInput 与上游 outcome（允许 null）。

1. 验证原输入指纹和回执 operation。
2. 明确上游 Review：核实持久 Review ID、operation、inputFingerprint、完整 observation、stage、code 后沿用；不尝试把它提升成成功。
3. 已登记/回执未知：只读 processing_result、结果与完成对象，并复验原始来源、引用、输出版本及配置。必须同时已登记且耐久，才能输出 `{status:"registered",registration}`。
4. 本地完成、远端完成但未登记、结果缺失/损坏、串产品等情况进入分类 Review；不调用模型、不上传、不注册。
5. 新 Review 先本地留存，再追加到库，同 ID 回读确认。无法确认时 Activity 失败，不声称已进入 Review。

## 页面文本 Workflow

`PreparedTextWorkflow` 使用共享 `PreparedTextWorkflowInputSchema`，输入为 `{task,queues:{text,receipts}}`。task 必须是已发布的 page.prepare / pdf.text TextDocument 引用与 V2 TextInput。不会将原始 HTML、PDF 或全文塞入 Workflow 输入，也不替上游创建 TextDocument。

流程：`interpretText → resolveTextReceipt`。文本 Activity 失败/超时后仅派发一次核验，不重调模型；取消直接取消，不转为证据恢复。错误任务或不合法/串产品的核验回执会明确终止 Workflow，不无限重试 Workflow Task。

此类型随现有 product-workflow 入口启动，使用本次完整 `dist/product-workflows.cjs`。这是新增类型，原 ProductImageWorkflow/ProductPdfWorkflow 调度未改变，Workflow 队列 compatibility 保持 product-images-v5；构建 ID 已变化，部署时重新取元数据，不混用旧文件。Workflow 不需要 Codex/R2/业务数据库凭证。

输出只是经过核验的文本处理结果引用，**不是 ready/collected，也不是 Formula + Ingredients 验收**。文本与图片汇合、标准化、产品保存仍是后续独立职责。没有把图片 OCR 文本重新接回 Codex 文本：图片仍走关键词后原图视觉。

本轮只本机隔离验收，未部署常驻或云端；详见 [验收报告](../../docs/quality/2026-09-07-prepared-text-receipt.md)。
