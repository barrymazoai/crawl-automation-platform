# V3 关键词筛选与视觉提取

2026-09-10：新增显式 `extractionProtocol: "label-extraction/2"`。模型输出 `label-visual-wire/2`（`label` + 完整 `otherIngredientsBlock`），解码器只按原始视觉转录的顶层逗号/分号分项，括号内分隔符和换行不拆项；原始响应仍保留。组件 evidence 明示的百分比不得从 amount 丢失。输出仍投影成共享 `label-extraction/1` 候选结构，登记仍为 `vision-result/2`，**输入协议及配置指纹不同**。旧 `/1` 解码/指纹保持不变，不从输出猜协议。这个一致性检查不是像素正确率证明，模糊原图仍可能误读。新增协议未替换常驻配置。

实现用户确认的[严格筛选设计](../../docs/spark/2026-09-06-ocr-keyword-vision-design.md)：命中任一关键词才读原图；未命中不兜底；产品图片集合封闭且全部未命中，返回被动 Review 决策。

首次 [Luna / medium 三图实测](../../docs/quality/2026-09-06-keyword-vision.md)完成，未生产部署。

2026-09-07：新分组协议已接视觉执行、保存登记、冷核验及 Review。显式启用方式见下节；Mini 213 项选定隔离回归通过，[本轮报告](../../docs/quality/2026-09-07-label-vision-worker.md)。未调用真实模型或部署，新产品汇合尚待接线；不能将这里的测试当作新协议真实识别质量验收。

## 新标签协议（显式启用）

Worker 私有配置中的 `codex` 可增加 `"extractionProtocol": "label-extraction/1"`，由 `CodexVisionConfigSchema` 解析。未设置时保持旧协议及旧指纹，不从模型输出猜版本。

调度新任务时，协议放在 **input 内**，指纹放在任务外层：

```ts
const supported = CodexVisionProvider.describe(config.codex);
const task = VisionTaskSchema.parse({
  input: { operationId: newOperationId, selection,
    ...(supported.extractionProtocol ? { extractionProtocol: supported.extractionProtocol } : {}) },
  configFingerprint: supported.configFingerprint,
});
```

不能直接把整个 `describe()` 返回值展开到任务顶层，也不能给旧 operation 改协议后重投。Worker 的 `vision-<配置指纹前32位>` 兼容标识仍独立校验。

- 新配置指纹包含 `codex-vision/2`、模型/provider/effort、执行 profile/超时、原图模式、标签契约/校验/视觉策略版本、提示词和输出 Schema；不包含私有路径。
- `VisionModule` 与 `VisionHandoff` 都从已固定的 input 选择同一解码器；新结果登记为 `vision-result/2`，完成凭证 `vision-completion/2`，产物 producer `vision/2`。
- `VisionHandoff.readLabelCandidate()` 提供已经复验来源/原图/响应/登记/完成凭证的新候选。旧 `readCandidate()` 明确拒绝新协议，不能有损压平分组和组件剂量。
- 新质量错误使用 `VISION.LABEL_*`，Review 候选 schema 为 `label-extraction/1`。旧 Review 和默认解码规则不变。结构校验通过仍不等于图片文字已被外部独立确认，也不等于产品已入库。
- 本轮未改实际私有配置。现有 GNC 准备计划、旧产品汇合与旧真实联调脚本尚未切换到这套协议。

## 模块接口

- `screenKeywords`：成功 OCR 的原文、身份、图片引用 → 可复验的关键词决策。大小写／空白归一化，不修补拼写。异常不能转换为空文本。
- `RegisteredOcrEvidence`：核验现有 OCR 的登记、完成状态、来源及内容；为筛选和视觉调用前检查提供原文。没有 OCR 重算入口。
- `KeywordPublication`：筛选结果先本机留存、再发布共享存储并回读；已发布重投只读，交接未完成不自动补传。独立[关键词 Worker 入口](../../apps/v3-workers/KEYWORD_WORKER.md)已实现，未命中和异常不会混淆。
- `imageProductDecision`：仅判定图片集合是否结束以及是否选到图片，不负责全产品入库。Workflow 应使用 `@crawl-automation/v3-vision/workflow`，避免把 Node/Provider 依赖打进 Workflow。
- `CodexVisionProvider`：独立私有进程和原图文件，继承既有代理，不切网络；显式 model/effort，能力预检必须支持 text + image。无工具、命令、浏览器、MCP 和业务密钥继承。
- `VisionModule`：只接受经复验的命中决策，图片验 hash；共享 store 原子执行意图，模型完成后先保留 localEvidence，再发布 store；重投只核验已有证据，未知不重算、交接待完成不自动补传。
- `VisionHandoff` / `PostgresVisionRegistry`：旧协议 `vision-result/1`，显式新协议 `vision-result/2`，均登记到既有 `processing_result` 表。原图、已登记 OCR、执行意图、原始响应、完成凭证一致且可从共享存储复验，才返回 `registered`。不新建业务数据库，也不写产品表。
- `createKeywordRole` / `createVisionRole`：不同 Temporal Activity 角色，只给 Workflow 小型证据回执，不传完整模型输出。视觉 Activity 必须注入 handoff 和 Review 适配器，不能仅凭本地提取完成返回成功。

`VisionCandidate` 的 evidence 是图片可见文字，由外层 ArtifactRef 绑定来源，不是可机器证明的 OCR 原文引用。`formulaComplete` / `ingredientsComplete` 是模型声明，只作候选检查输入，不能直接等同真实完整性或入库许可。多张图片汇合与后续验证继续独立。

配方表／Ingredients 分图时，单张命中图可返回 `partial`，保留可用候选供产品汇合；这不是未命中视觉兜底，也不是该产品失败。原图不可读或有歧义仍返回 Review。

2026-09-06：Ingredients-only 图可先保留非空 parentBlend，由产品汇合对最终 Formula 核验。此变化以 `vision-validation/2` 纳入新任务/Worker 配置指纹，旧任务不静默套用新执行配置；已保存原始证据不改写。模型仍为显式配置，不因本次变更升模。

`LocalVisionEvidenceStore` 用作可信私有目录的本机 journal，不保证跨主机持久性，也不声称能抵御同用户修改父目录的攻击。保留文件不自动删除。独立业务入口使用共享 R2 和独立本机 journal；异常先本机保留 Review 再登记数据库。Review 数据库不可用时 Activity 非重试失败，不伪报已进入可查询的 Review 队列。

## 独立业务 Worker

入口：`apps/v3-workers/src/vision-worker.ts`，构建后 `pnpm --filter @crawl-automation/v3-workers worker:vision`。

- 默认关闭；需要 `V3_VISION_LIVE_ENABLED=true`、绝对路径 `V3_VISION_CONFIG`，以及既有 `V3_WORKER_ENABLED=true` / `V3_WORKER_CONFIG`。
- 视觉配置是私有普通 JSON 文件（POSIX `0600`，拒绝符号链接）。字段参照入口 schema：`codex`（显式 provider/model/reasoningEffort、executable/codexHome/workRoot/runtimeProfileVersion/timeoutMs）、`storageId`、`cacheRoot`、`ocrJournalRoot`、`visionLocalRoot`、`r2`、`r2Credentials`、`resultDatabase`、`reviewDatabase`。凭证不能提交到仓库。真实提取配置继续使用用户选定的 Luna/medium，不自动升模。
- `node dist/vision-worker.js --list` 仅计算构建/配置元数据，不启动 Codex、Temporal 或数据库连接。角色 `codex-vision`、能力 `codex.vision`；兼容标识 `vision-<配置指纹前32位>`，任务队列由通用 runtime 生成。
- Activity 输入为 `{ input: { operationId, selection }, configFingerprint }`。调度方通过 `CodexVisionProvider.describe(config)` 获取完整指纹；入口和任务指纹必须一致。不是只依赖队列名。
- 返回 `{ status: "registered", candidateStatus: "candidate" | "partial", operationId, evidenceKey }`，或被动 Review 的小型回执。`partial` 可可靠登记，但产品是否入库由后续跨图片汇合判断。
- 已登记重投只读验证。已执行但交接未登记的重投进入 `VISION.HANDOFF_PENDING`，不自动补 PUT/INSERT，不重新调模型。`VisionHandoff.complete` 是显式交接操作接口，不是自动消费者。损坏/来源未验证不会被当成未命中。

## 验证

`pnpm --filter @crawl-automation/v3-vision test`

`pnpm --filter @crawl-automation/v3-vision build`

`scripts/live-quality.ts` 是需显式确认的最多三图 Luna/medium 质量试验，每次新建独立目录；不要为查看结果重复运行它。`scripts/replay-quality.ts` 只读核对已保留证据，模型调用为零。首次试验保存了真实 OCR 响应，但没有重新调用 OCR，也没有生产登记或 R2 上传。

独立入口真实联调脚本位于 `apps/v3-workers/scripts/live-vision.ts`，不加入普通测试：从该 app 目录用 `node --import tsx scripts/live-vision.ts --authorized-one <全新运行目录> <R2私有env路径> <私有auth.json路径> <Codex可执行文件> <固定Bloat原图路径> <已保存OCR响应路径>` 运行。必须明确授权；固定 Luna/medium、一张图、最多一次业务 turn，不限制 Codex 内部请求。原图和 OCR 原始字节先核对固定 SHA-256，OCR 作为已保存证据导入临时数据库，并保留导入清单与原始响应，不能声称本次调用了 OCR。

脚本新建临时业务库、本机 Temporal、R2 `vision-live/<随机ID>` 前缀。Worker A 完成后，审计器将 Worker B 限定为只读：禁止任何新 turn 和 PUT。R2 对象不清理；测试进程与临时登录副本在结束时清理。私有运行目录含配置凭据，禁止整目录上传或提交；查看证据不要重跑真实执行脚本。

状态：核心、独立视觉/关键词入口和视觉登记 codec 已实现。跨进程与临时 PostgreSQL/Temporal 集成见[验收记录](../../docs/quality/2026-09-06-vision-worker.md)。一张原图的[真实 Codex + R2 联调](../../docs/quality/2026-09-06-vision-real-chain.md)已通过，复用已保存真实 OCR。[产品图片 Workflow 与汇合核心](../v3-product/README.md)已在隔离真实 Temporal 中验证，生产启动注册、上游信号投递、最终入库和跨操作系统部署仍待后续完成。
