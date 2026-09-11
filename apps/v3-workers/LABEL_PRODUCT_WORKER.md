# 分组配方：独立汇合、保存和 Workflow

最新更新：[GNC 单产品逐来源入口](GNC_STREAMING_LABEL.md) 已接入独立准备及新协议处理，不再把全部来源准备当模型的前置屏障。Brand/网页派发及真实完整链验收仍待后续，下方旧“实时准备未接通”已被本更新覆盖。

2026-09-07 新增 [GNC 已准备证据入口](GNC_LABEL_INPUT.md)：完整来源核验后生成本协议 manifest，并通过独立 Workflow 进入标签处理。实时逐来源准备、Brand 派发仍未接通，下文“上游未接线”不再涵盖这个已准备入口。

2026-09-07：新增显式 `label-extraction/1` 产品路径。已有准备好的页面文本任务（resultSchemaVersion=3）和已通过关键词筛选的原图视觉任务可作为输入。不会把旧候选强制转换为新候选，也不向旧产品 codec 有损压平。

## 三个独立角色

| role | capability / 调用 | 入口 |
| --- | --- | --- |
| product-label-workflow | product.label.workflow / LabelProductWorkflow | dist/label/product-workflow-worker.js |
| product-label-assembly | product.label.assembly / assembleLabelProduct | dist/label/product-worker.js |
| product-label-collect | product.label.collect / collectLabelProduct | dist/label/product-worker.js |

均为 contractVersion=1、compatibility=`label-product-v1`，队列为 `v3.<capability>.v1.label-product-v1`。每个进程只启动配置选中的一个角色，可分别部署。Workflow 不需要业务数据库、R2、OCR 或模型凭据；汇合和保存不调用模型。

构建：`pnpm --filter @crawl-automation/v3-workers build:label`。部署整个 `dist/label`，不是单个入口；此构建不安装/复制 Python 或 PDF 资产，标签路径不执行 PDF。通用入口仍保留旧角色，不代表本轮启用它们。

共用 [Worker 通用配置](PRODUCT_WORKERS.md)：`V3_WORKER_ENABLED=true`、绝对路径 `V3_WORKER_CONFIG`，对应 role/capability/compatibility 与本次构建的 expectedBuildId 必须匹配。用入口 `--list` 读取 buildId。远程连接使用已实现的 mTLS，不开放公网明文。Workflow 并发至少 2。

Activity 另需 `V3_PRODUCT_LIVE_ENABLED=true`、`V3_PRODUCT_CONFIG` 私有文件（POSIX 0600，不允许符号链接）。沿用 storageId、cacheRoot、ocrJournalRoot、productLocalRoot、r2、r2Credentials、resultDatabase、reviewDatabase；collectionDatabase 仅保存角色必需。本机缓存路径属于当前进程，不引用上游机器路径。

- 结果库仅 SELECT；Review 库 SELECT/INSERT。
- 汇合和保存均需受限 R2 前缀 GET/PUT：保存角色也写不可变交接意向，不能沿用旧 collector 的只读 R2 权限说明。都不需删除权限。
- 保存账号仅对新 `collected_product` SELECT/INSERT。必须显式应用 `010_label_collected_products.sql`；启动检查拒绝缺失 codec /3 的库，不自动迁移。已有库先按数据库手册备份。
- 新版视觉结果还必须应用 `011_label_processing_results.sql`。`vision-result/2` 的登记与最终 `collected-product/3` 是两种不同记录，不能只升级产品表。视觉 Worker 启动时只读检查这项约束，缺失则在模型执行前拒绝启动；不自动修改数据库。

## 输入、并发与确定性

共享 `LabelProductWorkflowInputSchema` 包含 manifest（operationId、完整 observation、1–100 个 sources）与 queues（text、textReceipts、vision、assembly、collection）。每个来源都有稳定 id、required、完整任务；来源、产品、变体和操作身份必须一致，不允许重复操作。

文本和图片来源并发执行。文本使用已有 PreparedTextWorkflow 的独立回执核验；图片使用独立视觉 Activity。每个来源完成立即释放对应 Activity 槽位。产品 Workflow 等全部来源终态才发汇合，但不会占着业务 Worker 等待；下游未上线时任务留在 Temporal。显式上游 Review 保留原 ID，失败不取消兄弟来源；取消则不继续汇合/保存。

汇合按 source id 固定顺序选择内容一致的候选，保存所有候选与来源引用，而非按完成先后覆盖。分组标题、Blend 总量、组件剂量、列内 parentRowIndex、未披露/不清楚状态完整保留。Ingredients 从组件和 Other Ingredients 投影，坐标与名称、剂量均可验证；同名分组不合并。

完整且可核验的 Formula + Ingredients 才 ready。价格、评分和公司映射不是门槛。不同有效来源在份数、剂量、分组、Ingredients 等内容上冲突时必须 Review，包括 optional 来源间的明确冲突。optional 处理失败可作为 warning；身份串产品错误不可降为 warning。部分候选只有 Formula 或只有 Other Ingredients 时可互补，不猜测单位换算、同义词或补齐缺失字段。

## 可靠交接

汇合发布 `v3/label-products/<operationId>/assembly.json`，保存写 `collected-product/3` 不可变快照。每步本地留证、共享存储条件创建意向、发布/INSERT 后回读确认；同 observation 唯一、快照不可更新或删除。保存前后再次验证来源和汇合证据，不只信任 ready 回执。

Activity 最大尝试一次。网络回执未知只读取已存在证据，不重跑 OCR/Codex、不自动补传，也不重复未知 INSERT。已有意向但无法证明完成时保留被动 Review。Review 自身必须追加后同 ID 回读一致才能报告 review；无法确认就明确失败，保留本地证据。旧失败和 Review 不被覆盖。

## 验收边界

[本轮报告](../../docs/quality/2026-09-07-label-product.md)。Mini 上真实临时 PostgreSQL 和 Temporal、实际 Workflow bundle + 进程内真实业务类适配器通过；模型和存储是替身，不能称为业务入口多进程生产部署。另一项真实 GNC/R2 验证只汇合已保存证据，保持 Review，不写产品库。

尚未接入新协议的 GNC/SavedProduct 上游 manifest 准备、Brand 自动派发、网页一键全链和常驻部署。正式公司映射/正式产品服务同步仍独立待做。本轮不迁移任何现有持久库，不启用 PDF，不重解释旧 Workflow 历史。
