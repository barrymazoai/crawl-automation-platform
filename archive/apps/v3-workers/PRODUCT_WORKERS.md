# 独立产品流程、汇合与保存 Worker

2026-09-07 新增 [分组配方三角色](LABEL_PRODUCT_WORKER.md)，显式 `label-extraction/1` → `collected-product/3`，独立 `label-product-v1` 队列。该保存角色也需要受限 R2 PUT 来记录共享交接意向，与下方旧保存角色的只读权限不同。上游新协议准备仍待接线。

2026-09-07 已增加 [SavedProductWorkflow](SAVED_PRODUCT_WORKFLOW.md)，从已保存 HTML／图片／明确 PDF 页接准备和混合入库；混合 Activity 最新兼容队列为 mixed-product-v4，saved 编排为 saved-product-v2。以下既有图片/PDF图片角色的路由不变。

2026-09-07 另增 [混合汇合、保存与父流程角色](MIXED_PRODUCT_WORKER.md)，Activity 使用独立 `mixed-product-v2` 队列，父 Workflow 使用专属角色与队列。下文四角色和汇合后保存描述对应既有图片流程；新混合链路另行配置，不交给图片 collector。

2026-09-07 追加 `PageTextWorkflow`：从已保存 HTML 经两个独立页面角色进入文本处理/回执链路，仍不做文本与图片混合汇合或产品保存。[页面角色与配置](PAGE_WORKERS.md)。

四个角色各起一个进程、各自领 Temporal 队列；可同机，也可按依赖可达性部署在不同机器。没有互相请求本地 HTTP 或依赖对方文件路径。这里只交付启动代码与本机多进程验收，没有部署常驻服务。

| 角色 | 能力 / Activity | 启动命令 |
| --- | --- | --- |
| product-images-workflow | product.images.workflow / ProductImageWorkflow、ProductPdfWorkflow | `pnpm --filter @crawl-automation/v3-workers worker:product-workflow` |
| product-images-assembly | product.images.assembly / assembleProductImages | `pnpm --filter @crawl-automation/v3-workers worker:product` |
| product-collect | product.collect / collectProduct | `pnpm --filter @crawl-automation/v3-workers worker:product` |
| ocr-receipt | ocr.receipt / resolveOcrReceipt | `pnpm --filter @crawl-automation/v3-workers worker:product` |

这四项 contractVersion=1。Workflow 角色新增 PDF 逐页编排，compatibility=`product-images-v5`，队列 `v3.product.images.workflow.v1.product-images-v5`；同时注册两个 Workflow 类型。汇合/保存/回执三个 Activity 角色仍为 `product-images-v3`，队列 `v3.<capability>.v1.product-images-v3`。不要把在途旧队列直接交给新版 Workflow 消费者；旧运行保留原版本产物/队列。实际部署前先 `pnpm --filter @crawl-automation/v3-workers build`，再用对应入口 `--list` 获取精确 buildId，配置必须匹配本次产物。OCR/关键词/视觉角色仍使用各自原有的配置/策略兼容指纹。

共同启用条件：`V3_WORKER_ENABLED=true`、绝对路径 `V3_WORKER_CONFIG`。通用配置字段：role、capability、contractVersion、compatibility、expectedBuildId、hostId、namespace、address、transport、concurrency、shutdownGraceMs、shutdownForceMs；与其他 Worker 共用同一 runtime 校验。Workflow 并发至少 2。远程连接必须用已有 mTLS 配置，不开放远程明文。

Workflow 入口不需要 R2、业务 DB、Codex、OCR 或私有业务配置。普通构建生成 `dist/product-workflows.cjs`，buildId 覆盖此 bundle；不能只复制入口 JS。Activity 入口只注册被运行配置选中的一个角色，不会一个进程把三项都启动。

2026-09-07 追加注册 `PreparedTextWorkflow`：已发布文本 → Codex → 独立回执核验，输出已核验文本记录，不在此类型中汇合/保存产品。新增类型不改变现有图片/PDF调度，compatibility 保持 v5，构建 ID 随产物变化。配置见 [TEXT_RECEIPT_WORKER.md](TEXT_RECEIPT_WORKER.md)。

三个 Activity 还需 `V3_PRODUCT_LIVE_ENABLED=true`、绝对路径 `V3_PRODUCT_CONFIG`，配置文件为私有普通文件（POSIX 0600），不接受符号链接。字段：

- `storageId`：与上游证据的存储命名空间一致。
- `cacheRoot`、`ocrJournalRoot`、`productLocalRoot`：本进程可使用的绝对路径，不是上游 Worker 路径；允许空缓存启动。保留 journal，不自动删除。
- `r2`：endpoint、bucket、prefix、timeoutMs；`r2Credentials`：accessKeyId、secretAccessKey。不要把密钥放入版本库/浏览器。汇合需受限前缀 GET/PUT，保存和回执核验只需读取远端证据。
- `resultDatabase`、`reviewDatabase`：`{ connectionString, tls }`，结果账号只需 SELECT，Review 账号仅 SELECT/INSERT。
- `collectionDatabase`：仅 product-collect 必需；同样 `{ connectionString, tls }`，仅对新 `collected_product` 使用 SELECT/INSERT。汇合不连接这项数据库。

角色 prepare 负责依赖可用性探测，不自动迁移数据库。需要明确升级新 V3 业务库到 `008_collected_products.sql`，已有库须先备份；操作见 [数据库手册](../../database/v3/OPERATIONS.md)。新集群凭证初始化可生成独立 `v3_collection` 角色，不能在已有角色上通过再次运行 credentials 偷偷增权或轮换密码。

汇合返回 ready 后才派发保存；Review 不派发保存。保存重新从远端来源与结果登记复验，DB 回读成功才返回 collected。两者均无昂贵模型执行、自动补传或自动重试。Activity 最大尝试 1，心跳 2 秒；失败 Review 自身若无法可靠落库，Activity 非重试失败并保留本地证据。

## 自动 OCR 回执路径

启动产品 Workflow 时提供 `ocrTasks`（逐文件任务）和额外 `queues.ocr` / `queues.receipts`，原图必须已保存在受信共享存储中。其他队列字段不变。上游输入组装使用 `@crawl-automation/v3-contracts` 中的 `ProductImageWorkflowInputSchema`，不能手工漏掉某张图或混入另一产品。

每张图由 Workflow 调度已有独立 OCR Worker，再调度独立 ocr-receipt Worker。完成结果由 Temporal 原生 Activity 完成事件归属到该 Workflow/Run，无另一个 Signal 发送器或 DB 扫描队列。核验 Worker 从配置好的主库和共享存储读取证据，不请求 OCR；原始 OCR Review 会校验 operation/inputFingerprint/observation/inspection/code/evidenceKey 后沿用原 Review ID。

在 OCR 执行结果未知时，Workflow 仅安排一次回执核验；无法证明已登记且耐久就留 Review，不重新识别。回执核验进程尚未上线时，任务留在 Temporal 自己的队列里，已经完成的 OCR Worker 可释放或退出。核验失败/超时不会自动补传、登记或重跑。取消 Workflow 时不转入补偿识别。

自动模式禁止非空 `initialOcr`，忽略外部 Signal；外部模式则不允许传 OCR/receipt 队列。不同模式不能混在同一运行里。当前仍没有从网页一键跑完整 Brand 的上游接线，也没有独立外部 Signal 投递器。collector 与正式产品库同步仍是两个职责，公司暂未匹配不阻塞采集结果保存。

## 从来源文件启动

新增第三种输入模式：`fileTasks: FileOcrPlan[]`，不再要求调用方预先上传原图。提供 acquire/prepare/ocr/receipts 四项额外队列；不能同时提供 ocrTasks 或非空 initialOcr。逐图执行 `acquireSourceFile → prepareImageOcr → ocrFile → resolveOcrReceipt → 关键词/视觉`，下载一张完成就推进一张，最终汇合才等所有图片终态。

下载与 OCR 输入准备均为独立进程，说明见 [ACQUISITION_WORKERS.md](ACQUISITION_WORKERS.md)。私有 URL 不进入 Workflow 输入或 Activity 历史；来源适配仅在下载角色配置中。下载丢回执只核验完成证据，不重新下载。PDF 不走该图片直通路径。

## 从已发布 PDF 启动

使用共享 `ProductPdfWorkflowInputSchema` 启动 `ProductPdfWorkflow`。`plan` 包含产品 operationId、签名 inspection 输入、渲染 scale、OCR compatibility（结果版本 2）及视觉完整 configFingerprint。源 PDF 必须已经发布到共享存储，输入没有本地路径或下载 URL。

`queues` 包含 inspection、pages、pdfRender、pdfPrepare、ocr、receipts、keywords、vision、assembly、collection。PDF 检查与两个准备角色见 [PDF_WORKERS.md](PDF_WORKERS.md)。检查回执核验后生成完整封闭页清单，再在同一 Workflow run 内复用图片编排，不创建逐页子 Workflow。

每页独立执行 `renderPdfPage → preparePdfOcr → ocrFile → resolveOcrReceipt → 关键词 → 命中才视觉`。某页渲染交接慢不阻塞其他页推进；所有页到终态后才汇合/保存。渲染失败或丢回执仅核验证据，没有证据则 Review，不重新渲染。每页保留父 PDF、零起始页码和 observation。

当前最多 100 页，超过上限在渲染前进入 `PDF.PRODUCT_PAGE_LIMIT`，不截断。PDF 模式不能混用原图、fileTasks 或外部 OCR Signal；单次运行只处理一个源 PDF。PDF 直接文本路径、多个 PDF/图片混合清单、下载后的媒体类型路由、Brand/网页完整入口仍待接入。准备 Activity 本身若无法可靠保存 Review，会失败而非伪报 Review 已入库。

本机隔离验收见 [PDF 产品链路](../../docs/quality/2026-09-07-pdf-product-chain.md)，不代表已部署或真实 OCR/Codex/R2 联调。
