# 独立文本／图片汇合、保存与父流程

2026-09-07 追加 [SavedProductWorkflow](SAVED_PRODUCT_WORKFLOW.md)：支持已保存 HTML／原图／明确 PDF 文本页的准备接线。混合汇合和保存角色升级为 mixed-product-v4；下文 prepared 文本／已筛选图像仍是 MixedProductWorkflow 的输入。通用 ProductEvidenceManifest 另可包含 page/ocr-image/pdf-text，混合角色通过只读准备核验适配器解析它们，不能交给旧版本消费者。

`product-evidence-assembly` 是一个独立原子角色，只复验并汇合已经处理完毕的证据，不调用 Codex/OCR，不调度上游，也不保存产品到业务表。

## 输入与输出

共享契约在 `packages/v3-contracts/src/product-evidence.ts`：`ProductEvidenceJoin` 包含封闭的 `manifest.sources` 和每个来源的终态 `states`。来源显式声明 `required`，类型为 prepared 文本 V2 或已命中关键词的视觉任务；所有来源必须属于同一 observation、产品和变体。每个来源的 operationId 唯一，不能与汇合 operationId 相同。

状态为 registered、review、unresolved（执行回执未知，只读核验）或 rejected（明确协议错误，禁止恢复成成功）。Worker 重新读取结果登记、共享存储和原始证据；不信任仅有的“处理成功”回执。Review 必须核对持久化记录、身份、阶段和输入指纹。缺失终态不等于没有内容；即使 optional 也必须到达终态。上游并发调度与等待属于独立 MixedProductWorkflow，不占用这个 Worker 等待。

输出写入 `v3/product-evidence/<operationId>/assembly.json`，包含规范排序后的输入和 `product-evidence/1` 结果。ready 表示本模块校验通过且汇合证据已可靠发布，**不是 collected**。独立 product-evidence-collect 再次核验后写入 `collected-product/2` 快照；现有 image-only 保存器不消费此格式。

## 合并边界

- Formula 和 Ingredients 可来自不同证据；缺少任一核心字段进入 Review，不要求公司已匹配。
- Formula 逐列、逐项比较，保留 servingSize、剂量、dailyValue 和列结构。只整理空白，不换算单位或猜测近义成分；不同剂量／单位大小写／每份用量／列结构进入 Review。
- 文本 V2 没有列标题字段，只能与其他字段一致的单列图片配方对齐，不能猜成多列配方。容器份数是可选元数据，冲突记录 warning，不覆盖已有值。
- Ingredients 按角色与所属 Blend 分组。同组必须是同一集合才能去重并累积引用；不同集合不盲目并集。Blend 必须能关联最终配方中的父项。
- 文本保留真实原文 start/end（JavaScript 字符串索引）及引文；图片保留图像证据描述。字段 citation.sourceId 指 manifest 来源项 id，不是 observation.sourceId；可通过 provenance 找到登记记录和原始文件。
- 当前只接受完整 prepared 文本范围：start=0，end=全文长度。不支持将几个文本分块猜成完整配方；OCR 文本不作为产品字段的混合来源。
- 必需来源失败阻断；可选来源失败保留 warning。有效可选证据与其他证据冲突仍进入 Review。不可读／不完整视觉候选整份排除，保留其 provenance 用于审计；provenance 不代表所有来源都贡献了字段。

## 运行与职责

入口 `pnpm --filter @crawl-automation/v3-workers worker:product`。运行配置指定：

| 字段 | 值 |
| --- | --- |
| role | product-evidence-assembly |
| capability | product.evidence.assembly |
| contractVersion | 1 |
| compatibility | mixed-product-v4 |
| Activity | assembleProductEvidence |
| taskQueue | v3.product.evidence.assembly.v1.mixed-product-v4 |

按 [产品 Worker 配置](PRODUCT_WORKERS.md) 设置 `V3_WORKER_ENABLED`、`V3_WORKER_CONFIG`、`V3_PRODUCT_LIVE_ENABLED`、`V3_PRODUCT_CONFIG`。先构建，再从入口 `--list` 获取实际 expectedBuildId；每进程只启动选中角色，可部署到其他能连接 Temporal／结果库／Review 库／R2 的机器。远程连接使用现有 mTLS 传输配置。

没有 Codex/OCR 模型配置，也不需要 collectionDatabase。结果库仅 SELECT；Review 库 SELECT/INSERT；R2 受限前缀 GET/条件 PUT。本地路径是本进程缓存，不是向另一个 Worker 索取文件的位置。现有 product-images-assembly、product-collect、ocr-receipt 的兼容队列不变。

先保留本地候选，再条件创建共享发布意图，只有取得意图的执行可尝试一次汇合对象 PUT。失败只读回核验，不自动重复发布；空缓存换机也不能绕过共享意图。已发布结果必须重新核验来源且字节一致才能复用。Review 本身写入后回读确认，失败不能伪报“已入 Review”。所有对象保留，不自动删除。

本机 Temporal／临时 PostgreSQL／编译后独立进程验收使用模拟 S3、模拟模型；不代表真实产品质量验收或生产部署。

## 独立保存角色

同一 `worker:product` 入口每进程仅启用一个角色。保存配置为 role=`product-evidence-collect`、capability=`product.evidence.collect`、contractVersion=1、compatibility=`mixed-product-v4`；Activity=`collectMixedProduct`，队列=`v3.product.evidence.collect.v1.mixed-product-v4`。

保存角色额外需要 collectionDatabase（SELECT/INSERT），启动时只读检查 009 codec 约束；不会自动迁移。它无模型依赖，也不重新发布汇合对象。R2 需允许 `mixed-collection-intents/` 前缀条件 PUT/GET，来源与汇合对象只读。本地候选先保存，共享意图成功后最多一次 INSERT；数据库响应不明只回读，不重试，空缓存替换也不能绕过意图。已存在且完全一致的记录复验成功后直接复用，无新 PUT/INSERT。

新库仍用 `collected_product`，009 迁移允许 /1 图片与 /2 混合快照共存；operationId 主键与 observationId 唯一约束、不可变触发器均保留。不同 operation 不能覆盖同一 observation。warnings、文本与图像引用及来源记录一并保存。公司匹配不在保存职责内，不创建正式公司、不同步旧库。本轮只在临时库迁移，现有持久库部署须先按 [数据库操作规则](../../database/v3/OPERATIONS.md) 备份并明确升级目标。

## 父 Workflow

`MixedProductWorkflow` 使用专属 Workflow 角色，避免旧图片消费者领取未知类型：

| 字段 | 值 |
| --- | --- |
| 入口 | worker:product-workflow |
| role / capability | product-evidence-workflow / product.evidence.workflow |
| contractVersion / compatibility | 1 / mixed-product-v1 |
| taskQueue | v3.product.evidence.workflow.v1.mixed-product-v1 |

Workflow 仅需通用 runtime 配置，不需模型、R2 或业务库凭证。共享输入 `MixedProductWorkflowInput` 为 `{manifest, queues:{text,textReceipts,vision,assembly,collection}}`；各 Activity 队列从对应构建的元数据取得。混合 Activity 最新为 v3（包含已有 unresolved/rejected 及新增保存文件来源/未命中核验），不能将新来源指向 v1/v2 消费者。仍需使用实际 buildId 和完整构建产物。

来源从已保存的完整 prepared 文本 V2 和已验证关键词选中的 VisionTask 开始（最多100项），**不是原始网站或全部原图入口**。每个来源独立并发：文本 interpretText→resolveTextReceipt；图片 interpretImage。后续等待由 Temporal 承担，上游完成即可释放 Worker。全部来源到终态后 assembleProductEvidence；只有 ready 才 collectMixedProduct；Review 不派发保存。

未知 Activity 结果只读核验证据，不再次执行模型。明确 Review 校验其真实记录；明确错误回执不得用其他证据掩盖。失败分支不取消兄弟分支；用户取消则不继续汇合／保存。普通运行没有自动重试、切节点或跨来源猜测。Query `mixedProductProgress` 返回 expected/finished。

SavedProductWorkflow 已补 HTML 准备、原图 OCR 及未命中收口，参见上述独立入口。仍未接：Brand/网站 Adapter、PDF直接文本适配、真实混合产品质量验收及部署。原图片/PDF流程保持原路由，尚非完整 Brand 一键采集。
