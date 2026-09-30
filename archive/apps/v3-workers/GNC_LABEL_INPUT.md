# GNC 已准备证据 → 新配方 Workflow

更新：已有准备入口仍保持下述语义；新增 [逐来源实时准备与推进入口](GNC_STREAMING_LABEL.md)，用于不等待全部来源准备完的单产品流程。下文实时接线待做的描述为本入口交付时的历史边界。

2026-09-07：这是明确的“已保存并准备完成的 GNC 来源”入口，不是实时抓取或 Brand 总编排。它不调用浏览器、下载、OCR、关键词执行或模型，读取已有准备/关键词证据并生成新的处理任务。旧源计划仅作为已采集文件清单的证据，不转换旧模型结果。

## 独立角色

| role | capability | compatibility | 入口 / 调用 |
| --- | --- | --- | --- |
| gnc-label-input | gnc.label-input | gnc-label-v1 | dist/label/product-worker.js / prepareGncLabel |
| gnc-prepared-label-workflow | gnc.prepared-label.workflow | gnc-label-v1 | dist/label/product-workflow-worker.js / GncPreparedLabelWorkflow |

contractVersion 均为 1，队列分别为 `v3.gnc.label-input.v1.gnc-label-v1` 和 `v3.gnc.prepared-label.workflow.v1.gnc-label-v1`。两者分别启动，可不同机器部署。构建仍用 `pnpm --filter @crawl-automation/v3-workers build:label`，部署整个 dist/label；不安装 Python/PDF 资产。

通用 Worker 配置以及 Activity 的 `V3_PRODUCT_CONFIG` 沿用 [标签 Worker 手册](LABEL_PRODUCT_WORKER.md)。准备角色只需结果库读取、Review 追加/回读、受限 R2 GET/PUT 和当前节点缓存；不需 collectionDatabase、模型凭据、代理或浏览器控制端口。Workflow 只需 Temporal 配置。不自动迁移数据库或启动其他角色。

## 输入与处理规则

共享 `GncLabelInputSchema`：新 operationId、sourcePlan（已发布的 GncProductInput）、新文本兼容配置（resultSchemaVersion=3）和视觉配置指纹。新 operationId 不能等于源计划或抓取操作。完整身份、来源范围和原始证据由模块重新核验；调用者不直接挑选某几张图冒充完整来源清单。

准备模块逐项遍历 GNC 已发布来源清单：

- 页面：核验已保存页面准备结果及输入凭证，保留完整文本范围和源文档，仅生成新协议/新操作的文本任务；不调用旧文本模型。
- 图片：核验下载、OCR 输入、OCR 登记和关键词产物。未命中记录在 skipped；命中生成携带 `label-extraction/1` 的新视觉任务，引用原图，不把 OCR 内容作为视觉替代。
- 缺失或损坏证据不等于未命中，准备进入被动 Review，不能静默缩小清单。PDF 来源明确拒绝。
- 已选页面和命中图片在此入口均为 required，避免已知页面冲突被视觉成功覆盖；它不是价格、评分或公司匹配门槛。

新操作由产品 operationId + 来源 id 确定性派生，不因领取 Worker 或完成顺序改变。新清单保存在 `v3/gnc-label-inputs/<operationId>/manifest.json`，保留输入、完整选中 manifest 和 skipped 来源 ID；复验重新读取全部来源证据。共享发布意向及回读沿用 GNC 不可变发布模块，未知上传不重复 PUT；失败 Review 稳定 ID 追加并确认，不自动重试/清除旧失败。

`GncPreparedLabelWorkflowInputSchema` 包含 input、queues.prepare 及既有 text/textReceipts/vision/assembly/collection 队列。入口核验准备回执的输入/产品归属/证据键，再调用 LabelProductWorkflow，文本和视觉并发，最终独立汇合与保存；准备 Review 不启动模型。

## 当前边界

[本轮验收](../../docs/quality/2026-09-07-gnc-label-input.md)。真实 GNC 五来源已核验，生成二任务、三未命中；新清单没有启动真实模型或入库。实际 Temporal 已验证新入口到标签保存的接线，但准备回执/模型/对象存储使用明确替身；不冒充真实完整链。

实时采集入口仍需新版逐来源准备/派发，不能把该已准备入口用作“抓完一个 Brand 再处理”的架构。网页/Brand 自动触发、短期私有授权自动分发、常驻多进程部署仍待后续；旧 GncProductWorkflow/SavedProductWorkflow 未切换、不重解释历史，PDF 继续暂停。
