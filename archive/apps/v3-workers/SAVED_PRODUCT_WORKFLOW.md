# 从已保存 HTML／图片／PDF 页开始的产品流程

2026-09-07 更新：新增 `file-image` 来源，在各自分支先独立 file.acquire / image.ocr-input，再复用 OCR/关键词/视觉链路。最新兼容队列为 **saved-product-v3 / mixed-product-v5**，具体契约、授权边界和验收见 [GNC 产品接线](GNC_PRODUCT.md)。下方只接已保存图片及 PDF 的描述为历史切片；PDF 当前暂停，不作为新主线前置。

这是网站 Adapter 之前的文件接线阶段。不访问 Brand URL，不运行浏览器或重新下载网站文件。输入是已经保存在共享对象存储、带归属和 hash 的 HTML／图片／明确页码的 PDF，以及明确的模块版本和配置指纹。

## 角色和队列

通过 `worker:product-workflow` 入口独立启动 role=`product-saved-workflow`，capability=`product.saved.workflow`，contractVersion=1，compatibility=`saved-product-v3`；队列为 `v3.product.saved.workflow.v1.saved-product-v3`，Workflow 类型为 `SavedProductWorkflow`。与其他角色一样，先构建，再由 `--list` 获取实际 expectedBuildId；通用 Temporal 配置与 mTLS 规则不变。

新增 PDF 来源类型由 mixed-product-v4 的汇合／保存 Activity 处理。不要将新计划指向旧 v3 消费者。既有纯图片/PDF图片流程和单页 PdfTextWorkflow 的队列不变；本轮不部署常驻进程。不能把本次构建直接覆盖仍有未结束任务的旧兼容队列。

共享输入 `SavedProductWorkflowInput`：

```ts
{
  manifest: {
    operationId, observation,
    sources: [
      { id, required, kind: "page", plan: { page: signedPagePrepareInput, textOperationId, text: textCompatibilityV2 } },
      { id, required, kind: "pdf-text", plan: { extraction: signedPdfTextInput, textOperationId, text: textCompatibilityV2 } },
      { id, required, kind: "ocr-image", task: signedOcrInput, visionOperationId, configFingerprint }
    ]
  },
  queues: { page, pageText, text, textReceipts, ocr, ocrReceipts, keywords, vision, assembly, collection,
    pdfText, pdfTextPrepare }
}
```

这只是类型结构示意，不是可直接提交的 JSON。各来源属于同一 observation/产品/变体；来源 id 与所有处理阶段 operationId 唯一，不能与产品 operationId 相同。清单必须明确封闭，1–100项，可以只有页面、只有图片或只有 PDF 文本页。PDF 两个队列仅在有 pdf-text 来源时必填，分别指向 pdf-text / pdf-text-input 角色，见 [PDF Worker](PDF_WORKERS.md)。输入不包含本地文件路径或远端私有下载 URL。

一个 pdf-text 来源明确对应一个提取操作和页码；同一 PDF 可列多个页，各自独立。**此入口不保证调用方已列出整份 PDF 的全部页**，没有声称提供自动全页发现；上游仍需负责来源清单完整性。不得把任意一页成功称为整份 PDF 全页验证完成。

来源 plan 仍需调用方给出签名的页面/OCR输入和配置。此阶段自动生成的是页面完成后的 TextInput 与关键词命中后的 VisionTask，不是从任意目录自动发现文件或猜测归属。

## 每个来源独立推进

HTML：`prepareHtmlPage → preparePageText → interpretText → resolveTextReceipt`。

图片：`ocrFile → resolveOcrReceipt → screenImageKeywords → 命中才 interpretImage`。

PDF 文本页：`extractPdfPageText → preparePdfText → interpretText → resolveTextReceipt`，复用 PdfTextWorkflow 编排函数；不是在 Activity 内串接其他模块，也不额外启动一个必须等终态的子 Workflow。

每个来源自己的前置准备完成就继续，不等其他来源准备完。已完成 Worker 可释放槽位；等待由 Temporal 处理。全部来源到达终态后统一 `assembleProductEvidence → ready 才 collectMixedProduct`。

HTML 整理不执行 JS、不加载 img/link 等资源；图片必须已经独立保存在清单中。页面保持已有 UTF-8、2 MiB、20万文本字符限制，不截断后冒充完整结果。PDF 空文字或超限明确 Review，不隐式渲染/OCR回退；图片路线仍需上层明确选择。HTML关联图片自动发现、整份PDF自动选页/路由、网页浏览器获取均不在本入口中。

## 来源核验与失败

新增只读 `SavedSourceEvidence`，由汇合和保存角色注入。它没有解析、OCR、Codex或补传能力：

- 页面重新核验原 HTML、完成清单、正文、表格证据，以及持久化的完整 TextInput 清单和配置绑定。
- PDF 通过只读 PdfTextEvidence 复验原 PDF、页码、完整引擎输出/完成凭证，重建预期原文/输入，再精确核对已发布 TextDocument 和清单。无 Python、模型、补传端口。准备 Review 额外绑定完整下游 plan，不能借用同一页另一种模型配置的失败。
- 图片重新核验准确的 OCR 登记与原文件，从已登记 OCR 重算关键词判断，并对照已经发布的关键词记录；命中后导出指定 operation/config 的 VisionTask。
- 明确 Review 必须对应原来源、处理阶段、operationId 和输入指纹，不允许外来 Review 冒充可选失败。
- 回执未知只读复验；明确协议错误进入 Review，不转成成功。重复投递已完成任务不会新增模型业务执行。未知阶段仍遵守各原子模块已有的防重边界，不宣称任意网络故障下自动恢复。

未命中不是 OCR 故障，不调用视觉、不兜底；汇合 warnings 保留 `SCREEN.NO_KEYWORDS`，完整原始来源和状态仍在 assembly.input 中。若其他有效页面/图片已经满足 Formula+Ingredients，可以保存；如果全部未命中且没有合格文本证据，就因缺少核心字段进入被动 Review。

必需来源失败阻断产品保存；可选来源失败保留 warning，不能让来源从清单里消失。协议伪造不受 optional 豁免。成功字段的 provenance 保留实际文本/视觉登记记录；被跳过的文件不是字段贡献者，但其原件、OCR/关键词和准备失败仍可从原始清单、Review和共享证据追溯。

沿用 collected-product/2，不新增数据库迁移，不改变入库门槛。输入清单及终态参与不可变结果身份，不能用同一 operation 更换来源或 Review ID 后要求覆盖旧结果。

验收使用已保存的合成 HTML/PNG、真实本机 Temporal/临时 PostgreSQL和编译后的多进程 Worker；外部模型、OCR、S3使用替身，不代表真实历史产品的提取质量验收。报告：[已保存文件整链](../../docs/quality/2026-09-07-saved-product-chain.md)。

PDF 扩展另见 [本轮报告](../../docs/quality/2026-09-07-pdf-mixed-product.md)。真实 PDFium 提取合成 PDF；混合场景文本使用真实 TextModule/Handoff 核心加测试 Activity adapter，模型输出为替身，编译文本进程由独立文本链路回归覆盖。
