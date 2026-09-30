# GNC 单产品逐来源推进

2026-09-07。`GncStreamingLabelWorkflow` 将页面、逐图片的准备和处理串成独立分支；不再等待所有图片准备完才处理页面。原已准备入口仍保留，既有历史不切换。

## 职责与队列

新增三个可分别启动、部署的角色，contractVersion=1、compatibility=`gnc-stream-v1`：

| role | capability | 入口 / 调用 |
| --- | --- | --- |
| gnc-stream-label-workflow | gnc.stream-label.workflow | dist/label/product-workflow-worker.js / GncStreamingLabelWorkflow |
| gnc-label-plan | gnc.label-plan | dist/label/product-worker.js / loadGncLabelPlan |
| gnc-label-source | gnc.label-source | dist/label/product-worker.js / prepareGncLabelSource |

队列由通用运行层按 `v3.<capability>.v1.gnc-stream-v1` 生成。不是把所有功能塞进一个 Worker；通用入口只启动配置选择的单个角色。

构建 `pnpm --filter @crawl-automation/v3-workers build:label`，将整个 dist/label 部署到独立版本目录。通用启停、私有配置、mTLS、构建指纹与权限沿用 [标签 Worker 手册](LABEL_PRODUCT_WORKER.md)。Workflow 只连接 Temporal。两个新 Activity 目前沿用 V3_PRODUCT_CONFIG 的 R2、结果读取、Review 和本机缓存配置，不需要 collectionDatabase、模型账号或浏览器控制地址；plan 业务本身只读取捕获/来源计划证据。没有数据库自动迁移。

## 输入

共享 `GncStreamingLabelWorkflowInputSchema`：

- `input`：原 GncLabelInput，新产品处理 operationId、sourcePlan、新文本协议配置、视觉指纹。主动新采集应创建新的 observation 和各步骤 operation，不改变已执行操作的配置。
- `start="capture"`：从独立 GNC 浏览器采集、捕获回执核验和来源计划发布开始。
- `start="saved-plan"`：从已发布来源计划开始，不重新访问浏览器；其下游准备可以尚未完成。它不是把旧失败任务自动续跑。
- `queues`：填写各角色实际 Task Queue 名称，不能使用本机文件路径或服务 HTTP URL。

| queues 字段 | Activity / 职责 |
| --- | --- |
| capture / captureReceipts / productPlan | captureGncProduct / resolveGncReceipt / prepareGncProduct；仅 capture 模式必需 |
| plan | loadGncLabelPlan：只核验捕获和单产品完整来源集合，不读取各图准备结果 |
| page / pageText | prepareHtmlPage / preparePageText：页面独立准备与文本任务输入 |
| acquire / imagePrepare | acquireSourceFile / prepareImageOcr：一次一个文件；GNC acquire 应选择 gnc-file 角色队列 |
| ocr / ocrReceipts / keywords | ocrFile / resolveOcrReceipt / screenImageKeywords：独立 OCR、可靠回执、关键词 |
| source | prepareGncLabelSource：只核验当前来源，发布新协议文本或视觉任务 |
| text / textReceipts / vision | interpretText / resolveTextReceipt / interpretImage：新协议模型执行与回执核验 |
| manifest / assembly / collection | prepareGncLabel / assembleLabelProduct / collectLabelProduct：最后完整核验、汇合、独立保存 |

text/vision 队列必须对应显式 `label-extraction/1` 的真实配置指纹，不能接旧协议消费者。页面准备仍复用已有无模型的预处理契约；随后生成 resultSchemaVersion=3 的新文本任务，不调用旧文本模型、不转换旧模型输出。

## 并发与完成规则

捕获一次产品页面、发布该产品的完整来源集合后，所有来源分支独立推进：页面准备好就处理文字；每张图下载好就做 OCR，命中关键词便将该张原图交给视觉。未命中仅记录 not_matched，不兜底调用模型。这里不等待其他产品或整个 Brand 抓完；Brand 的发现/派发接线仍是后续任务。

每个 Activity 完成自己的可靠交接即可释放执行槽位，不在 Activity 内等待其他来源或下游 Worker。等待由 Temporal Workflow/队列承接。沿用现有有界时限：普通 Activity 排队及执行合计 15 分钟、执行 5 分钟；OCR 合计 10 分钟、执行 2 分钟；最多一次尝试。Worker 缺席可排队，但不是无限等待，超过时限转入既有证据核验/失败处理。

只在所有来源终态后核验最终完整 manifest，再调用汇合/保存；不会二次派发已经完成的模型。来源 ID、输入归属、文档范围、原图/关键词身份、新配置，以及最终清单与已派发任务必须一致。明确拒绝的回执不能被最终 skipped 静默隐藏。查询 `gncStreamProgress` 返回 expected/finished；finished 包含成功、未命中、Review 等终态，不是入库成功数。

## 故障与证据

- 单来源失败不取消其他来源。正常分支可完成并保留产物；最终不完整或内容冲突保留被动 Review，不入库。
- 每来源输入证据保存在 `v3/gnc-label-inputs/<operationId>/sources/<sourceId>.json`；全来源屏障后才发布 manifest.json。均为不可变证据，不是第二套调度数据库。
- 未知上传先依据已有意向和对象回读，不重复 PUT；未知处理结果由已有证据核验，不重做 OCR/Codex。无法证实完成就保留 Review。
- 取消不继续派发最终汇合/保存；已完成证据保留。已开始的独立活动按既有取消/退出策略处理，不宣称取消能撤销已发生的副作用。
- 非法编排输入、伪造身份、最终清单覆盖不完整会明确失败；不能写 Review 或核验 Review 时也不冒充已入队成功。

## 验收边界

[验收报告](../../docs/quality/2026-09-07-gnc-streaming-label.md)。真实临时 Temporal 与实际编译 Workflow 已在 Mini 验证；业务原子类使用合成网页/图片、模型/网络/存储替身。另复验既有真实临时 PostgreSQL 保存链。不是 GNC→真实 OCR→真实 Codex→持久产品库的全链验收，也未启动常驻业务进程。

下一步是受限真实单品端到端联调与业务角色部署验证，之后 Brand 派发/网页入口。私有短期图片授权自动分发仍未实现；当前捕获模式需要对应文件 Worker 已有可用的独立授权配置，不会从 Temporal/R2 广播 Cookie。PDF、旧失败重跑、公司映射/正式产品库同步均不在本入口启用。
> 2026-09-09：新增显式核心准备分支和独立 Worker，见 [GNC_CORE.md](GNC_CORE.md)。旧输入保持下述流程；新任务通过 corePolicy/core 队列接入，尚未发布常驻服务。
