# V3 文本解释原子模块（Task 21，本地核心切片）

2026-09-07：新增 `ResolveTextReceipt`，仅核验已登记结果与耐久来源/产物，没有模型执行、上传或补登记能力。独立启动角色与 `PreparedTextWorkflow` 已通过本机隔离验收；135 项文本测试、40 项 Worker 集成通过。[入口配置](../../apps/v3-workers/TEXT_RECEIPT_WORKER.md)、[验收边界](../../docs/quality/2026-09-07-prepared-text-receipt.md)。这不是文本/图片产品汇合或 HTML 整理实现。

2026-09-06 图片业务路径已调整为[严格关键词 → 视觉](../v3-vision/README.md)，未命中不兜底。文本模块继续服务网页／PDF 直接文本，历史 OCR 文本证据和测试保留。共享 Codex 通信层已迁到 `v3-codex`，本包保留兼容导出；127 项文本回归与既有 Worker 集成通过。下方三图全 Review 是旧文本路径结果，不是新视觉实测状态。

## 文本质量策略 V2（2026-09-06）

当前真实质量基线固定为 `openai / gpt-5.6-luna / medium`，由当前助手直接核对，不调用额外评判模型。下方 Astra/high 的合成样本结果仅是历史链路证据，不代表 Luna 的产品质量。

本轮[同样本复验报告](../../docs/quality/2026-09-06-luna-medium-v2.md)：主配方完整性改善，但三份仍全部 Review，尚未达到真实产品质量验收标准。127 项文本单测、37 项契约及独立 Worker 14 项集成通过。

- `extraction.ts` 是纯函数层：生成范围内行号、解码模型引用、定位唯一原文、检查覆盖与成分角色；不访问数据库、存储、网络或模型。
- 模型只提供 `{fromLine,toLine,text}`。代码只容许空白差异，不修正拼写/单位，最终仍保存准确的原文 `{text,start,end}`，包括跨行换行符。重复匹配、宽泛行号或不存在的原文拒绝。
- `TextCandidateV2` 显式保存 `blend_component / other` 和零基 `parentNutrientIndex`。Other 必须有标题上下文；Blend 必须有有效父项。Contains/共线设备提示不能当作成分；换行不能作为拆成分的依据。
- 字符覆盖检查要求选择范围内每个字母/数字被字段引用或受限的非配方排除引用覆盖。自由标注 marketing/noise 不能绕过检查；不确定内容进入 Review。**这是保守完整性防线，不是语义正确性证明。** 当前不能可靠重建损坏的 OCR 读序、多剂量列或缺失段落。
- 原始模型响应保持不变。`capture` 和 `inspect` 都重新进行同一确定性解码后比较候选，换节点读回时不依赖模型再调用，也不能绕过角色/覆盖检查。
- 新 Provider 使用 `codex-text/2`、`anchored/2`、`resultSchemaVersion:2`，与旧结果版本隔离。V1 解析保留用于历史证据验证，不让新 Worker 领取 V1 任务，也不改写旧证据。
- 新分类：`TEXT.ROLE_INVALID`、`TEXT.INGREDIENT_BOUNDARY`、`TEXT.EXTRACTION_INCOMPLETE`、`TEXT.COVERAGE_UNCERTAIN`、`TEXT.INPUT_INCOMPLETE`。原始响应仍保存在私有 Review，不自动修复或重新调用。

最新[真实Codex+R2联调](../../docs/plane/evidence/CRAWLV3-21/REAL_CHAIN.md)已通过：一条合成配方、真实 `gpt-6-astra/high`、编译业务Worker、本机Temporal和临时PG；结果与Formula/Ingredients引用正确，空缓存换进程恢复不重算。5个R2对象保留，未生产/跨机部署。以下各阶段“真实模型未验”仅指当时切片。

## 最新业务边界（2026-09-06 用户确认）

一次业务 operation 只启动一次 Codex 执行；Codex 内部模型请求次数和内部续调由 Codex 自己管理，不作为业务失败依据，也不要求底层请求只能一次。业务层负责并发、总超时/取消、结果校验、证据保存和交接，失败或状态未知不另起执行盲目重跑。工具权限与模型配置独立按模块职责约束，不沿用旧代码的宽权限开关。

2026-09-23 更新：`executionRetries: 0` 和 `internalModelRequests: "no-retries"` 同时禁止外层及 Codex 请求/流重试。第一个 error（包括 `willRetry=true`）即失败并关闭本次拥有的子进程；普通非错误通知仍可等待最终结果。超时、模型匹配和权限约束保持。

最新主流程增量：`CodexTextProvider` 与[独立业务 Worker](../../apps/v3-workers/TEXT_WORKER.md)已实现，本地隔离链路已通过；不是生产部署或真实模型验收。历史[预检报告](../../docs/plane/evidence/CRAWLV3-21/PREFLIGHT.md)中的严格单请求准入结论已被用户撤销。

## 模型与推理强度（2026-09-06 新增）

共享 `CodexModelSettingsSchema` 提供三个必填字段：`provider`、`model`、`reasoningEffort`。
模型由部署配置指定，不在代码里选默认值；配置文件对象可直接用该 schema 校验，环境变量入口使用显式传入环境的 `readCodexModelSettings(env)`：

| 环境变量 | 配置字段 |
| --- | --- |
| `V3_CODEX_MODEL_PROVIDER` | `provider` |
| `V3_CODEX_MODEL` | `model` |
| `V3_CODEX_REASONING_EFFORT` | `reasoningEffort` |

例如 `{ "provider": "openai", "model": "your-selected-model-id", "reasoningEffort": "high" }`。
其中模型名是占位示例，不是已选定/可用模型；`high` 也不是所有模型均支持的保证。
解析器检查格式和缺项，不自行猜测或归一化模型名。本机0.153.0协议把 effort 定义为字符串。协议驱动现已接入 `assertCodexTextModel`：初始化后先核对有效提供商，再有界读取完整 `model/list`，精确匹配模型、text输入能力和指定 `supportedReasoningEfforts`；缺失/歧义/目录读取失败均在创建线程前拒绝。目录不是账号授权或余额证明。网页选择器仍延期。

协议驱动把强度写入 `thread/start.config.model_reasoning_effort` 和 `turn/start.effort`，同时传递明确 model。
创建线程后比对返回的 model/provider/reasoningEffort；不一致就拒绝发起 turn，不允许静默降级或换模型。
`codexTextCompatibility(settings, runtimeProfileVersion)` 将这三项及运行配置版本纳入 configFingerprint，供后续业务装配使用；现有模块按配置指纹拒绝不匹配任务。
更改设置应生成新配置版本/任务，不改写已提交任务或复用旧结果。

`CodexTextProvider.open(config, env)` 使用显式私有 Codex 配置目录、工作根目录、可执行文件与总时限。每次解释新建独占工作目录/进程，不重启/续接另一业务执行；工作目录保留，不自动删除。运行配置版本和超时一并进入指纹，改 Codex 提供商配置或 CLI 版本也应更新 runtimeProfileVersion。

真实CLI+无凭证回环服务已经验证：一次 Provider 调用可内部请求4轮后成功取得最终结果。内部请求数只是测试观测，不是生产限制。真实账号/模型请求仍为0，未修改旧执行链或启动生产 Worker。

## 职责与输入

一次处理一个 observation 的一个明确文本范围，而非整批 Brand。输入契约放在
`@crawl-automation/v3-contracts`，不在 apps 里复制类型。

- OCR 路径：携带 `OcrRegistration`。必须核对原图、OCR 输出、完成清单、数据库登记和身份；仅本地识别完成不能启动文本解释。
- 页面/PDF 路径：携带 `TextDocument` JSON 的 ArtifactRef，保留原始 HTML/PDF 引用和页码。页面文字不访问 OCR 核验接口。
- `TextDocument` 是本轮定义的新交接封套。现有 acquisition/PDF 纯模块尚未自动产出/登记这个封套；业务外壳装配留待后续，不能直接把旧输出当成新输入。
- 范围使用原文的半开区间 `[start,end)`，单位为 JavaScript UTF-16 code unit，不是 UTF-8 字节。最多 200,000 code units；拒绝截断代理对的边界。
- 指纹绑定 operation、request、observation、品牌、listing/variant、来源证据、范围及策略/实现/配置版本。包括固定 objectKey，存储定位变化不是同一输入；节点 ID 和本地路径不进入输入指纹。

## 输出不是产品入库判定

候选包含 Formula（serving size / nutrients 的名称、量、DV）和 Ingredients。
每个值都是原文引用 `{text,start,end}`，严格 schema 后逐条核对引用内容和范围。
缺失可以为 `null`；不推断单位，不跨 variant 拼接，不用第二次模型调用修复。

引用检查只能证明“这段话确实在本次文本里”，**不能证明营养语义、字段关联或产品完整性正确**。
Formula + Ingredients 是否满足采集结果保存条件属于后续 Task 23；本模块 `registered` 只代表候选及证据已登记。

## 依赖注入与交接

`TextModule` 注入 `TextProvider`、`TextHandoff`、Review 端口和 nodeId。
Provider 不自动重开整次执行、不主动换模型或切换网络；内部模型请求由 Codex 管理。文本运行配置使用只读 sandbox，禁用命令/浏览器/插件等能力，拒绝活动 MCP 配置和未支持的客户端授权请求，不将这些权限规则混同为请求次数限制。子进程仅继承必要运行环境和原代理设置，不继承业务DB/R2密钥；Codex认证来自显式私有目录，不能指向未审阅的个人工具配置。
模块没有子进程、模型 SDK、Clash API、环境变量默认加载、会话复用或原任务重试入口。

正常路径：核验来源 → 共享对象存储创建不可覆盖的执行意图并读回 nonce → 调用一次 Provider →
本地保存原始回复 → schema/引用校验 → 本地结果和完成清单 → 远端持久化 → 不可变数据库登记 → 只读回验。

- 同一 scope/op 的意图不自动过期；创建回执未知或已有意图都不赋予再次调用权限。
- 完成状态分别是 `computedLocal`、`artifactDurable`、`resultRegistered`。数据库一行不是远端证据存在的替代品。
- `TextHandoff.inspect` 没有模型调用或写入能力。`uploadMissing` / `register` 是显式恢复方法，不由 Review 消费器自动调用。
- 已经计算但交接未完成时，后续投递进入被动 Review，不重新解释。明确核验后可以仅补传/补登记；本轮未做恢复 CLI/UI。
- Review 写回执丢失会只读验证。无法确认保存时抛出非重试错误，不谎称已进队列。重复投递可能留下多个历史 Review，不会自动删除旧记录。
- 原始模型回复最多 250,000 UTF-8 字节，序列化结果最多 512 KiB；核验上游原件最多 8 MiB。更大的输入暂不支持。
- 对象和本地凭据没有任务结束自动删除。`TextLocalStore` 是私有节点缓存，不可拿来作跨机意图存储；宿主私有目录是信任边界，未验证敌对同用户并发改目录或断电恢复。

`PostgresTextRegistry` 复用新 V3 业务库的 `006 processing_result` 不可变表，以全局唯一 operationId 区分记录。
它使用独立 TextRecord codec，**不是 OCR 结果**。未来混合查询必须按模块分派 codec；既有 OCR 专用 inspection 不能拿来解析文本记录。
Review 当前为 `inspection.kind=none`，通用私有记录/脱敏摘要可读，文本专用只读复核 API 尚未接入。

## Worker 边界

`createTextRole` 提供 `codex-text` / `codex.text` 的 `interpretText` Activity，复用 v3-worker-runtime。
Activity 返回小型产物引用或 Review ID，不把模型回复塞进 Temporal 历史。
`textActivityOptions` 设置 maximumAttempts=1；Activity 自身再拒绝 attempt>1。
不同 operation 可以由 Worker 并发调用，业务外壳负责并发上限和真实共享资源额度。

`apps/v3-workers/src/text-worker.ts` 是独立入口，通过两个显式开关和私有配置启用；普通 worker.ts 注册表仍不自动注册文本角色。启动只读检查数据库与模型能力，注册专属能力队列；`--list` 不启动 Codex 或连接外部依赖。已用真实本机 Temporal、临时 PostgreSQL、编译后的子进程入口及模拟 Codex/S3 验证业务链路，尚未跨机或生产部署。

## 验证与后续

```sh
pnpm --filter @crawl-automation/v3-text test
pnpm --filter @crawl-automation/v3-text test:integration
pnpm --filter @crawl-automation/v3-text build
```

集成测试仅新建系统临时目录下的 PostgreSQL 集群，使用继承的 001–007 迁移，不读取 DATABASE_URL，结束时停止，保留测试证据。
模型和远端对象存储都是明确的测试替身。见 [Task 21 证据](../../docs/plane/evidence/CRAWLV3-21/README.md)。

下一步在明确的真实模型配置/账号授权、样本和业务执行次数范围内验证真实Codex→R2链路，或继续补上游TextDocument装配。额度范围按业务执行讨论，不设底层单请求前置条件。当前 R2 私有配置已经保存，无需再次索取。
真实 R2/模型跨机链路、Windows/Linux、进程硬中断、生产队列及产品写入均未验收。
