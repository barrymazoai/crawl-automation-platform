# PDF 单页直接文字链路

本入口接受已保存 PDF 的一个明确页码。它不是浏览器抓取，不负责整份 PDF 页清单或产品汇合。

```text
PdfTextWorkflow（专属编排 Worker）
  → pdf-text：本机 Python/PDFium 单页提取，发布完成证据
  → pdf-text-input：核验证据、准备全文 TextInput，无 Python
  → codex-text：已有模型解释角色
  → text-receipt：只读核验耐久与登记结果
  → registered 或分类 Review
```

四个 Activity 独立进程/队列；前一步完成即释放槽，下游未上线的等待留在 Temporal。一次单页，不批量塞 PDF 数组。多个页/产品可同时启动，具体并发受各独立 Worker 配置约束。

## 入口配置

构建 `pnpm --filter @crawl-automation/v3-workers build`。

编排使用 `worker:product-workflow`，运行配置：role=`pdf-text-workflow`、capability=`pdf.text.workflow`、contractVersion=1、compatibility=`pdf-text-v1`，队列 `v3.pdf.text.workflow.v1.pdf-text-v1`。buildId 从当前完整构建 `dist/product-workflow-worker.js --list` 获取。Workflow 并发至少 2（现有 sticky cache 门禁），不要把 Activity 并发 1 的配置直接套上去。编排进程不需要 Python、R2、业务库或 Codex 凭据。

`pdf-text`、`pdf-text-input` 通过 `worker:pdf` 分别启动，配置见 [PDF Worker](PDF_WORKERS.md)；后者无需 pythonExecutable/workRoot。共用 PDF 兼容标识 `pdf-v1-<pdfConfigFingerprint 前32位>`，capability 分别 `pdf.text`、`pdf.text-input`，队列 `v3.<capability>.v1.<compatibility>`。完整引擎配置指纹仍在任务中校验。

Codex 与回执角色分别见 [TEXT_WORKER.md](TEXT_WORKER.md)、[TEXT_RECEIPT_WORKER.md](TEXT_RECEIPT_WORKER.md)。模型配置沿用已有设置，本轮未调整真实模型/推理强度，不限制 Codex 内部调用轮次。

所有角色需要独立 runtime 配置与显式启用门禁。原图片/HTML/混合 Workflow 路由不变；新增类型用专属队列，不向旧队列投新类型。完整 dist 和生产依赖随 Worker 部署，不能只复制单个文件。

## 输入与输出

共享契约 `PdfTextWorkflowInputSchema`：

```ts
{
  plan: {
    extraction: signedPdfTextInput, // module: pdf.text，原 PDF ArtifactRef 和 pageIndex
    textOperationId: "独立且稳定的文本执行ID",
    text: textCompatibilityV2      // 模型模块版本、策略与完整配置指纹，不含密钥
  },
  queues: { extraction, prepare, text, receipts }
}
```

提取、文本、原文件生产操作 ID 必须不同。回执不携带全文，Worker 通过共享存储交接；本地路径不是跨模块协议。TextDocument 保留 PDFium 原文，不去空格、不改 CRLF、不截断；引用沿用全文 UTF-16 半开区间。父 PDF / 页码留在文档，原引擎完成清单与 task 留在输入清单。

未知提取回执只调准备模块核验证据；证据缺失进入 Review，不再提取。明确失败不升级成成功；错误操作/不合法准备回执明确终止 Workflow，不无限重试 Workflow Task。用户取消直接取消，不调恢复。空页没有隐式 OCR 回退；图片路线仍由上层显式选择并遵守关键词策略。

输出为 `TextReceiptOutcome` 或 PDF Review，**registered 不等于 Formula + Ingredients 合格，也不等于产品入库**。后续已增加 [SavedProductWorkflow 的 pdf-text 来源](SAVED_PRODUCT_WORKFLOW.md)，可在明确来源清单中汇合并保存；本单页入口自身仍只返回文本登记。整份 PDF 自动全页发现/选路和上游站点接入尚未完成。

## 复验

```sh
pnpm --filter @crawl-automation/v3-pdf test
V3_PDF_PUBLIC_SAMPLE=/private/tmp/crawlv3-19-w3c-dummy.pdf pnpm --filter @crawl-automation/v3-pdf test:integration
pnpm --filter @crawl-automation/v3-workers test:integration
```

隔离测试用真实本机 Temporal/PostgreSQL/PDFium 和编译后的所有角色，Codex/S3 为替身；不触发真实账号，不部署、不迁现有库。详见 [验收报告](../../docs/quality/2026-09-07-pdf-direct-text.md)。
