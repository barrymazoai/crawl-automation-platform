# Processing contracts v1

2026-09-06 CRAWLV3-20 补充：外层 schemaVersion 仍为1，resultSchemaVersion 支持1/2。v2 强制 rawResponse（text、lines、score/可选4点 polygon、额外 JSON 元数据），顶层 text 必须与 rawResponse.text 完全一致。新 multipart-ocr/2 Worker 只接结果v2；v1仅用于既有隔离 P0 验证，不得冒充新版完整证据。结果版本纳入指纹、消费者匹配、完成凭证和显式复用校验；无数据迁移或旧任务重投。

CRAWLV3-14，2026-09-06。唯一真源是本包 artifacts.ts / processing.ts；P0 contracts/index.ts 仅重导出共享定义并声明 mock 部署策略。共享包只依赖 Zod，没有文件系统、环境变量、时钟、随机 ID、网络或 Temporal SDK。

## 身份与职责

| 字段/契约 | 含义 |
| --- | --- |
| requestId | 一次业务提交；响应丢失复用原 ID |
| observationId | 某来源挂牌/变体的一次新观察，不要求已入正式产品库 |
| operationId | 观察内某模块的一次操作；投递/执行尝试不更换它 |
| ObservationSchema | request + observation + brand/source/listing/variant 关系 |
| OperationIdentitySchema | request/observation/operation/module + 输入/配置指纹及 schema/实现/策略/结果版本 |
| ArtifactRefSchema | 一个文件的稳定引用与归属、字节摘要、产生者；不是本机路径 |
| OcrInputSchema | 一次一个 source-image 或 pdf-page，输入与文件的观察/来源/挂牌/变体必须完全相同 |
| CompletionSchema | 完整结果的 key/hash/长度与操作身份及版本；只声明凭证，不证明已经上传/登记 |
| ReviewSchema | 阶段、分类、稳定错误码、执行事实、证据 key、blockedBy；automaticRetry 固定 false |

ExecutionId 是大小写敏感的不透明安全标识，最多 120 字符，不是 URL 或外部产品名。正式入口继续使用已有 UUID；P0 的 req-/obs- 标识仅为隔离 fixture。ID 在入口/登记边界产生并持久保存，契约函数本身不分配 ID，也不负责并发唯一性。variantId=null 表示挂牌级证据，不等于任意变体通配。

## 文件关系

ArtifactRef 包含 schemaVersion、artifactId、observationId、sourceId、listingId、variantId、kind、mediaType、sha256、byteSize、objectKey、producer(operationId/module/implementationVersion)。支持原图、PDF 原件、PDF 页图、文本和 JSON 结果。PDF 页必须带 parentArtifactId 和从 0 开始的 pageIndex，不能引用自身；原图不能偷偷带页字段。

objectKey 是配置确定的证据存储空间内的稳定键；拒绝绝对路径、Windows 路径、URL/签名 query、反斜线、空段、点跳转和编码转义。bucket/凭证由部署注入，不放进任务。跨观察使用同样字节时仍显式建立本次关系，不修改旧观察的文件归属；可共享底层对象字节，但不能混用观察引用。

这些校验不能证明文件存在或真的为 PNG/PDF，也不能证明 PDF 页号在实际页数内；真实类型、hash、长度、父文件和读取权限由后续 Resolver 核验。OCR 不接受 PDF 原件，由独立 PDF 模块先产页图。没有已入库 productId 的前置要求。

## 指纹与版本

ocrFingerprintMaterial 返回带 v3:ocr-input:1 域分隔的固定顺序 JSON 数组。内容包含全部操作关联、文件内容 hash/长度/类型/血缘、配置摘要、策略/实现/结果/schema 版本；不包含 objectKey、主机、缓存目录或临时授权地址。因此移动存储不改变处理含义，改内容、关联或版本必定改变规范材料。

fingerprintOcrInput / parseOcrInput 注入 SHA-256 函数。Worker 的 Node crypto 实现在 P0 runtime wrapper，不能导入 Workflow；不同语言的实现须对同样的 UTF-8 JSON 材料计算小写 SHA-256。configFingerprint 只哈希公开的语义配置（模型、提示词版本、处理选项），凭证不是配置语义，也不应作为散列原料进入链路。配置规范化由具体模块定义，未来更换指纹字段/算法必须升级域版本，不能悄悄重算在途操作。

P0 固定向量 makeFixture("vector") → 70367005d384a860c31c159424f9aaba1f22c459e1460fba255709e82bfc9a23。同 operation ID、不同指纹在登记/核验边界冲突，不覆盖原凭证。新 request/observation/operation 即使文件字节相同，也不是旧任务重复投递。

共享 schema 接受版本标签，具体 Worker 用 assertOcrCompatibility 精确比较自己支持的实现/策略/配置/结果版本。P0 Workflow 在任何 Activity 前拒绝不兼容输入，返回 RUNTIME.INCOMPATIBLE_CONSUMER，不创建业务 Review。真正的业务错误则保留执行事实；blockedBy 只能指向另一操作，且当前操作必须 not_executed。

## 结果与复用

OcrOutput 带完整处理身份/版本与文本（最多 200 万字符）。它是模块到本地持久化外壳的数据，不应把大文本直接作为 Temporal Activity 结果。Activity 返回 Completion 引用；assertProcessingResultMatches 核对输入与输出/清单全部身份和版本。读取字节并验证结果 hash/长度是适配器职责。complete=true 不代表 R2 持久化、业务登记或正式入库已完成。

OcrReuseRecordSchema 是显式文件处理复用的关系声明：target 保留本次新 request/observation/operation/artifact，reusedFrom 保存原输入和匹配完成凭证；要求内容类型/hash/长度及处理版本相同。它不是缓存查询或自动跳过授权，不允许用于复用抓取/产品写入。采用之前仍要验证双方输入指纹、本次来源证据、原结果字节和登记事实；这些属于后续存储/登记任务，P0 当前仍不自动复用跨观察结果。

## 消费与部署边界

P0 使用 workspace:* 消费，构建通过 noExternal 内联本包供普通 Node 运行，Workflow bundle 单独构建。测试断言 P0 与共享包的 schema 为同一实例，避免重新复制 DTO。

这是新契约，不迁移或继续消费旧 P0 本地清单/历史。模拟队列改为 v3.p0.shared-v1.*，不和原 v3.p0.* Worker 混跑；旧输入缺字段会拒绝。真实 V3 业务角色仍未注册，不宣称 A30 的所有未来模块/部署均已验收。

本项没有数据库迁移、R2 读写、凭证设置、缓存 Resolver 或真实 OCR。CRAWLV3-15 接本地优先/R2 Resolver；并发操作登记和可靠完成交接随后单独实现。P0 LocalEvidence 仍仅为本机不可变文件测试适配器，不等于跨主机事务保证。
