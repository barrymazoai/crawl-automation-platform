# 产品图片路径编排与汇合

2026-09-10：新增 opt-in `label-image-first/4`：完整图仍优先；图片候选 evidence 中明示比例却未填 amount、孤立括号项不再取得完整图片资格。若有完整且核验的文字可回退，并保留原图候选/警告。双方完整且同份量、单列 per-serving、同名独立 nutrient/blend_total 的明确数字差异为 `LABEL_PRODUCT.SOURCE_NUMERIC_CONFLICT` 被动 Review；不做单位换算、不按分类猜组件对应，不将所有文字分组差异升级为阻塞。旧 `/1`–`/3` 不改判。

同 observation 保存采用 `retain-first/1`：原采集产品不变，新质量候选保留在原子汇合/R2与 Review 中，并在 `rawError.details.existingCollection` 关联已有 operationId/observationId/recordHash。数据库保存前检查、写后竞争回读都返回 `LABEL_COLLECTION.OBSERVATION_ALREADY_COLLECTED`；真正无法核实保存仍是 `REGISTRATION_UNKNOWN`。没有删除 observation 唯一约束，没有自动覆盖/晋升新版；49 的页面展示需后续接入该关联。

2026-09-09：新 Label 汇合支持显式 `evidencePolicy: "label-image-first/1"`。完整、已验证图片优先于网页文字，文字差异保留警告，多图片核心冲突/身份或证据故障仍 Review；不带策略的历史输入不变。Mini 新任务策略已启用，真实留存样本通过内存 collector 校验，未新增数据库产品。[规则与验收](../../../docs/quality/2026-09-09-image-first.md)。

2026-09-07：新增独立 `PreparedTextWorkflow`（同 workflow 导出）：已发布页面文本 → Codex 文本 → 独立回执核验。它只返回文本登记证据，不与图片混合、不保存产品、不改变既有图片筛选规则。[入口说明](../../../apps/v3-workers/TEXT_RECEIPT_WORKER.md)。

2026-09-07：新增 `ProductPdfWorkflow`，核验 PDF 检查结果并生成完整页清单，各页独立渲染 → OCR 输入准备 → 已有图片链路，最终汇合/保存。Workflow 路由现为 `product-images-v5`，产品 Activity 仍为 v3。单源 PDF 最多 100 页，超限 Review、不截页；不是 PDF 直接文本解释或混合文件路径。[验收](../../../docs/quality/2026-09-07-pdf-product-chain.md)与[启动说明](../../../apps/v3-workers/PRODUCT_WORKERS.md)。下文 v4 为此前文件模式的引入版本。

本包只处理一个 observation/SKU 的**图片路径**，不把整个 Brand 的产品收齐后才开始处理。当前包含实际 Workflow、汇合与新系统采集结果保存，独立启动入口见 [PRODUCT_WORKERS.md](../../../apps/v3-workers/PRODUCT_WORKERS.md)。代码接线不代表已部署常驻服务或同步旧产品库。

## 职责

- `ProductImageWorkflow`（从 `@crawl-automation/v3-product/workflow` 导入）：已封闭的单产品图片清单，最多 100 张；逐个接收已登记 OCR 回执。每张图独立筛选，命中后立即派发视觉任务；未命中跳过。不轮询数据库、不占用等待型 Activity。
- `mergeProductImages`：纯函数，校验产品、变体、配置和来源身份，确定性汇合 Formula/Ingredients；不访问模型、网络或数据库。
- `ProductImageAssembly`：汇合 Activity 的业务实现。只在全部图片终态之后调用；从共享存储复核筛选结果，并通过已登记 OCR/视觉证据适配器读取候选。保存不可覆盖的 `assembly.json`，异常持久化被动 Review。
- `CollectProduct`：独立保存 Activity。重新核验汇合与来源证据，在本机保存快照后追加 `collected_product`，回读比对 hash；没有模型、OCR、公司查询或正式产品服务调用。
- `ResolveOcrReceipt`：独立 `ocr.receipt` Activity。核验单文件 OCR 的登记、原图、结果与完成证据，或核验原始 Review 身份。只读取上游，不调用 OCR，不补传或重新登记；无法确认时保留分类 Review。

Workflow 输入：`{ manifest: { operationId, observation, imageIds, configFingerprint }, queues: { keywords, vision, assembly, collection }, initialOcr?, ocrWaitMs? }`。

自动模式增加 `ocrTasks: OcrInput[]` 和 `queues.ocr` / `queues.receipts`。每张图必须恰好对应一个任务，operation 不重复、observation/变体一致、OCR 结果版本为 2。校验通过后每个文件独立执行 `ocrFile → resolveOcrReceipt → screenImageKeywords → interpretImage（仅命中）`，最后汇合/保存。不等待全部 OCR 完成才筛第一张。

自动模式不需要调用 Signal：Activity 完成由 Temporal 交回调度它的 Workflow/Run，回执核验作为下一条独立 Activity。OCR Worker 不等待下游、不知道产品 Workflow ID、不额外连接 Temporal Client 发消息，也没有数据库轮询队列。Workflow 重放已完成事件不重新调用 OCR；若 OCR Activity 已失败/超时，后续仅核验证据一次，已登记且耐久才推进，证据未知进入 Review。显式 OCR Review 不被自动提升为成功。

`ocrTasks` 与非空 `initialOcr` 不可混用；自动模式忽略外部成功/失败 Signal，避免外部消息抢先完成其自有操作。未提供 `ocrTasks` 或 `fileTasks` 时保留原外部回执模式。输入 schema 现位于共享 contracts，Workflow 的原导出保留。

文件模式提供 `fileTasks: FileOcrPlan[]` 和 `queues.acquire/prepare/ocr/receipts`。每张图恰好一份计划，包含来源 resourceId、完整 observation、下载 operation、OCR operation 与 OCR 配置，不含私有下载 URL。禁止与其他输入模式混用。独立下载完成后，独立图片输入准备核验共享存储原件与完成证据，再进入上述自动 OCR 路径；不等待其他文件下载。下载 Activity 失败/丢回执仅核验已有证据，不重新下载。文件和 OCR 输入准备的明确失败沿用分类 Review，不启动 OCR。Workflow 路由升级为 product-images-v4，其他产品 Activity 仍用 v3；详情见 Worker 手册。当前只接静态公开 HTTPS 图片，不含 HTML/PDF 编排或完整 Brand 抓取。

`productOcrReady` Signal 只传 `OcrRegistration`，没有 OCR 全文。相同回执幂等，冲突/串产品不会覆盖。`productOcrFailed` Signal 传 `{ imageId, code, reviewId }`，上游失败立即变终态，不必等超时。两种信号应由受信交接方投递，当前尚未建立面向网页的投递 API。

`productImageProgress` Query 返回 expected/received/finished；received 计已接收的成功 OCR 回执，自动模式只有经独立核验后才增加，失败回执不算成功。外部模式等待默认最多 1 小时，可显式配置 1 秒至 1 小时；超时进入 `SCREEN.OCR_NOT_READY`。自动模式由原 OCR Activity 的 2 分钟执行/10 分钟排队含执行上限与回执 Activity 的 5/15 分钟上限约束，`ocrWaitMs` 不用于自动模式。不转视觉兜底。所有 Activity 最大尝试次数 1，仍受各 Worker 并发及已有资源配额约束。

图片清单在 Workflow 启动时已封闭，OCR 结果则可逐张到达。当前不支持运行中无限追加图片、重新打开清单或把迟到的新一轮采集混入旧 observation。更大清单需由上游分片规划；不是等待整品牌结束。

## 汇合规则

Formula 与 Ingredients 可分图；只要在同一产品/变体且来源通过验证，就可以互补。完整性门槛仍为 Formula + Ingredients，不要求 companyId、价格、评分等字段。

同一 Formula、同一 Blend 组或 Other ingredients 段落的重复证据，只有内容一致才去重；不同组允许组合，同组差异进入 Review。忽略比较对象里的 evidence 引用措辞和文本连续空白，不换算单位、不合并剂量列、不用最后到达覆盖、不猜测裁剪图是否只是另一张的子集。剂量值的大小写保留，避免 mIU/MIU 等误合并。Ingredients-only 候选的 parentBlend 在此对最终 Formula 核验。

保留所有贡献图片和视觉结果引用；冲突原始候选仍在各自结果证据中，不删除。未完成/有歧义的核心证据保守进入 Review。独立网页/PDF 直接文本路径与可选证据规则尚未接入本包，**不能用图片路径的 Review 否定另一路已有的合格核心数据**。

## 结果与可靠性

- `ready`：汇合证据已发布并回读核验，不代表已经写入采集结果表或正式产品服务。
- `collected`：Workflow 最终成功状态；新 `collected_product` 已有经回读核验的快照，包含 observation、Formula、Ingredients、汇合 hash、所有贡献图与结果引用。不是正式产品服务同步凭证。
- `review`：输出错误 codes、Review ID、证据 key，`automaticRetry=false`。全部未命中包含 `SCREEN.NO_LABEL_EVIDENCE`；不表示商品不存在/下架。
- R2 风格存储 key 为 `v3/products/<operationId>/assembly.json`；同 key 内容冲突不覆盖。输出上限 8 MiB。
- 已发布结果可只读复验；本地完成但远端未确认时重投不自动补传。Review 自身无法可靠登记时异常上抛，不能声称 Review 已入库。
- 新表为独立 `collected-product/1`，没有扩展 `processing_result` codec，也没有外键依赖旧公司表。operation/observation 均唯一；同一 observation 换 operation 不能覆盖已有结果。主动新采集应建立新 observation。
- 数据库提交回执丢失后只读核验；本机已有保存意图但 DB 未确认时，重投进入 `COLLECTION.HANDOFF_PENDING`，不自动第二次 INSERT。空缓存节点面对未提交操作仍可能尝试一次相同 INSERT，由数据库唯一约束防止重复记录；不承诺物理 INSERT 恰好一次。
- 已保存但后续证据损坏时复验进入 Review，旧快照不删除、不伪造回滚。错误 Review 保存失败会抛出非重试错误，不能伪报已留存 Review。

## 验证

`pnpm --filter @crawl-automation/v3-product test` / `build`。

真实本机 Temporal 流式实验在 `apps/v3-workers/integration/vision-business.test.ts`，使用实际生产构建的 Workflow bundle；不是另写一套测试用编排。Workflow、OCR、回执核验、关键词、视觉、汇合和保存由各自编译后的独立业务入口运行。OCR HTTP/Codex/R2 为测试替身，数据库为临时 PostgreSQL，没有真实模型调用。

下一步：上游文件获取/准备与本 Workflow 输入组装。自动图片路径已接通，不再以单独 Signal 投递器作为前置条件；外部回执模式仍没有常驻投递器/API，不能把此轮称为外部 Signal 投递验收。正式产品服务同步、网页/PDF 直接文本支线和常驻部署仍未完成。
