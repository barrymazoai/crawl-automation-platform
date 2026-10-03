# DTC 变体资料分流 — 用户确认，2026-10-03

关联 CRAWLV3-178 / 155 / 180。本文收敛此前 OCR 前置方案：只给仍然混在一起的规格资料增加处理，不让所有 DTC 产品都额外经过一次 OCR。本文记录已确认的设计；代码接入与实际验收状态见文末，不把设计等同于已验收。

## 两条处理路径

| 采集后观察到的情况 | 处理路径 |
| --- | --- |
| 切换规格后，页面身份、选中状态及交给下游的资料明确对应当前规格 | 走原流程：取得该规格真实地址或选中状态 → 留存并核验自身 HTML / 图片 → 原单品 Facts / 标准化流程。无需额外 OCR 前置。 |
| 切换规格后，图库 / Facts 仍混着多个规格，页面无法给出可靠的资料归属 | DTC 先保留完整原件 → 单独复用旧 OCR 能力取得 Facts 证据 → Codex 结合网站规格与原图判断归属 → 将对应资料交回原单品流程。 |

分流依据是 **实际资料是否已经对应当前规格**，不能仅比较 URL 字符串。URL 改了但图库仍混合（Solaray 当前案例），仍走第二条；URL 没改但页面资料确实切换并能验证归属，可以走第一条。完全不变的图片也可能有明确共用依据，不能仅因图片相同就判断混用。

## 保留的约束

- 产品、规格、SKU、价格和库存来自网站。OCR 只帮助识别 Facts 与其适用范围，不从图片创造规格。
- 分流由 Codex 基于观察证据判断，不按文件名、关键词、轮播顺序或 URL 是否含 variant 参数机械分类。
- 有独立规格地址时，按旧流程明确获取该地址的页面，再核对页面自身身份。Whole Foods 实测中，客户端切换后的旧初始化 JSON 不能当作新规格原件；但保存 HTML 的工具本身仍不隐式导航。
- 如果缺的是页面身份、规格选中状态或采集原件，应补充相应观察或明确 Review；OCR 前置不能弥补缺失的采集步骤。
- 两条路径最终都复用原单品 Facts 流程。这次前置仅接 DTC；其他渠道的变体发现 / 派发漏项留在 180，共用配方复用漏检留在 179。
- 混合图库完成归属后按原始图片引用交接，保留完整来源与判断依据；不能把尚未实现的 OCR 复用 / 回执传递宣称为已完成。

## 接入时必须验证

1. 页面和资料随规格切换：直接进入旧流程，没有新增前置 OCR。
2. URL 变化、图库仍混合：进入 DTC 前置归属，不能误走默认资料。
3. URL 不变、资料正确切换：留存各自选中状态，验证后走旧流程。
4. URL 和资料均不切换、多个规格 Facts 混在一起：先做归属，再分别处理。
5. 明确共用 Facts、微小配方差异、无法归属分别处理，不能用相同图片或相似文本推定配方等价。

证据与边界见 [两渠道调研](2026-10-03-channel-variant-research.md)；Solaray 的既有取消记录和 R2 原件保持原样。

## 实现进度（2026-10-03）

- 新增 DTC 专属 `mixed` 交接。保留每个规格实际状态/原件/完整图库，浏览器阶段不必先完成混合 Facts 的语义归属；缺少状态仍逐规格 Review。
- 同 URL 选中状态可通过 `selectedState` 从留存原件重读，不再强制构造 variant URL；原 `observed` 分支保持原单品流程。
- 浏览器 Activity 结束后，独立 `DtcGalleryWorkflow` 使用现有 OCR Activity、回执校验、模型队列和资源门控。独立子运行避免与采集阶段许可序号冲突，取消等待子任务处理。OCR 和模型均不自动重试。
- Codex 逐张读取原图、原 OCR 文本和完整网站规格清单，返回 Facts 归属与理由。全量结果齐备后保留不可变 scoped projection；不改原始图片、不覆写旧记录、不从图片生成 SKU/规格/价格。
- 混合分支不接受未归属 Facts，不按首图兜底；同规格仍有多张 Facts 需要联合确认时保留 Review。明确共用单张 Facts 可分发到多个已验证规格。
- 归属后 `family:null`，避免共用兄弟配方检查 bug 179 影响本轮；配方识别继续由原单品流程完成。前置 OCR/判断原件均留存引用，但**尚未实现跨 owner 的 OCR 回执复用**，子任务目前仍按原流程 OCR。此前提案中“子任务不再次 OCR”并非本次已实现能力。
- 本地采集/交接/旧浏览器路径 44 项纯回归、原件状态/图库 16 项纯回归通过。完整 pnpm check 一轮通过；新增工作流重放用例将在 Mini 执行。此时尚未部署新代码、未产生新 OCR 实测结果。

## 部署与验收记录（2026-10-03 11:28 北京）

- `852546a29b751ebf757bc68c022e929f77f2d484` 已提交并推送 main，两台 Mini 均从 Git fresh clone、锁定依赖安装、构建后部署。Server 二 03:24:21Z 完成；Server 一首次切换因缺少 `PM2_HOME` 停止，使用既有 PM2_HOME 完成切换，03:25:08Z 七个服务与远端浏览器 poller 全部 ready，held permits 为空。
- Mini：87 passed / 6 skipped，涵盖新混合图库成功、OCR Review、模型失败、许可释放与工作流重放，以及旧变体重放。另取两份真实留存原件验证：2 passed / 4 unrelated fixtures skipped；旧 Zinc Copper 继续原路径，旧 Magnesium 未归属记录仍为 Review。Worker bundle 构建通过，完整 `pnpm check` 再次通过。
- 临时暂停的五条其他渠道队列在确认前后均无 queued/ready/running 商品后，恢复维护前的 running 状态。DTC 批量队列保持 paused（6 queued）。
- 新单品验收 `d7ad53b4-a202-4c32-a82d-f61ba99d2f90` 于 03:28:20Z 接收，目标 `https://solaray.com/products/magnesium-glycinate`，使用 native Ego。此处只记录已启动；真实 OCR、归属、单品处理和清理结果待后续证据。
- 部署日志：Server 二 `manual-releases/dtc-mixed-852546a/`；Server 一 `manual-releases/dtc-native-20261002/mixed-852546a-*.log`。提交回执：Server 一同目录 `mixed178-solaray-{request,receipt}.json`。

## 首轮真实验收：交接文件漏字段（11:43 北京）

- `d7ad53b4-a202-4c32-a82d-f61ba99d2f90` 于 03:39:04Z 业务结束为 Review：2 个规格均 `DTC.VARIANT_EVIDENCE`，未进入 OCR。不得将 Temporal COMPLETED 等同业务通过。
- 原始采集已齐：240ct / SKU 076280895049 / 31.99 / InStock，120ct / SKU 076280549010 / 18.39 / InStock；5 张原图。原件预检有完整 mixed context，但 Codex 手写最终 `capture-review.json` 时漏了两项 `reason` 和 240ct 的 `selectedState`。宿主严格校验拦截符合预期。
- 修复生产者交接：增加 `readPreflightVariantContexts` 原样读取已通过的完整上下文；生成用的 `CaptureReviewAuthoringSchema` 展开逐规格类型，入站依然逐规格隔离错误。不能靠手抄字段再漏证据，不能在宿主静默补齐旧坏记录。
- 增加漏字段、未通过预检、重复规格的回归，以及针对本轮真实原件的 Mini 只读回放。旧最终交接和旧 Review 不修改，派生上下文只用于内存回归。验证实际生成环节仍需新的独立验收，不自动重试旧任务。
- R2 全量回读：72 文件 / 14,182,840 字节，大小和 SHA-256 全部相符（03:43:52Z）。浏览器 Codex 进程 66224 于 03:37:28Z 退出且进程组 absent；03:39:44Z 全任务 held permits 为空。证据：Server 一 `manual-releases/dtc-native-20261002/mixed178-solaray-{result,r2-proof}.json`。

## 交接修复部署与第二轮（11:47 北京）

- `20bec74e725d475d0212dd99fea0798df6ca2857` 已推送 main，完整 check 通过。纯回归 30 项、native 原件/图库 20 项通过；Server 二真实首轮原件及相关回归 31 passed / 6 unrelated skipped。内存派生复用完整预检上下文通过两个 mixed 规格的原件校验；原始坏交接及旧 Review 均未修改。
- Server 二于 03:46:34Z 从 Git fresh clone、锁定依赖安装、构建后切换 `browser-worker` 并验证 ready。只改采集生成侧，Server 一仍运行 `852546a` 的 OCR/归属逻辑，无需为此重启。
- 新独立验收 `e3b68ada-7b9d-4889-89c3-b0e7619cd7cc` 于 03:47:18Z 接收，验证修复后的最终交接生成和完整混合 Facts 链路。不是重试或覆写第一轮；DTC 批量保持 paused。
- 日志位于 Server 二 `manual-releases/dtc-mixed-852546a/handoff-20bec74-*`；首次部署预检从 workspace 根查不到 tsx，未执行服务切换，改用 `pnpm --filter @crawl-automation/ops-deploy exec tsx` 正常完成。新请求及回执在 Server 一 `manual-releases/dtc-native-20261002/mixed178-solaray2-{request,receipt}.json`。
- 首轮停止证据补核：确切目标 `185FFDC3D5B15C6C7BA58F1CD159D309` 于 03:37:28.799Z 验证 absent，browser round 结束，许可于 03:38:56.596Z 释放；不只是账本清零。

## 第二轮：方法路径没有对应文件（12:00 北京）

- 第二轮最终 contexts 与预检完全一致，reason 未丢失；但是两项 `methodPath` 都被模型写成 `sources/details-…html + sources/product.json` 的说明文字。预检验证了内联 method，未验证对应文件；宿主读取路径报 ENOENT，两项再次 Review，未调用 OCR，held 为空。
- 增加机械 `saveObservedVariant`：保存模型已经选定的完整方法 JSON，返回真实 `methodPath` 和预检结果。最终 `readPreflightVariantContexts` 再验证该文件与预检内联 method 一致。不会选择字段、推断规格或按关键词匹配图片。21 项 native 回归通过，完整 check 通过。
- 增加手动有界工具 `tools/verify-dtc-retained-mixed.mts`。仅针对首轮 Solaray 原件，先验证本地与 R2 全部文件散列，在新记录下引用完整预检上下文，保留 `retained-analysis.json` 来源说明。`--prepare` 只读远端原件且派生产物仅落本地；`--execute` 明确开启一次现有 DtcGalleryWorkflow，再为 ready 规格分别调用现有 DtcVariantWorkflow。工具不访问网站、不打开浏览器、不改旧 Review，不伪装成原失败任务成功，也不自动重试。
- 该验收拆开验证真实采集与留存原件后续处理；不能将手动下游验收描述为第二轮原任务端到端成功。

## 留存原件真实下游验收：归属参数接线错误（12:12 北京）

- `02335a9` 已推送 main，并于 04:10:48Z 经 Git fresh clone/build 部署到 Server 二，browser-worker ready。第二轮 74 文件 / 15,773,017 字节已全量回读验证；目标 `020066319BAE7C13F2C36CC4A1F8B6E9` absent、Codex 进程组 absent、round ended 的证据完整，许可于 03:59:03Z 释放。
- 新留存验收 `01a38890-e474-4445-bc89-fced78dbf88e`，独立 `dtc-gallery-accept-…`：首轮 72 文件 / 14,182,840 字节均校验通过，两规格 mixed。第一张真实 OCR 及回执核验完成，但 `scopeDtcGalleryImage` 在模型调用前因严格 Observation schema 报错；未生成任何归属决策、未派发单规格，结果仍 Review 2/2。
- 根因：新增 activity 将整个 OcrInput 传给 ArtifactResolver 的 owner 参数。旧 OCR 正确使用 `observationIdentity(input)`；此处改为同一函数，保留严格归属与完整性校验，不能靠放宽 schema 绕过。
- 新 activity 接线回归使用真实 ArtifactResolver，覆盖正确原图、错 observation/source/listing/variant 和损坏字节。先复现原错误，再验证修复。真实验收日志和意图/结果在 Server 二 `manual-releases/retained178-02335a9-live/` 及 `dtc-mixed-852546a/retained-02335a9-live.log`。
- `476c318` 完整 check、6 项接线回归通过，Server 二同 6 项通过。Server 一于 04:14:17Z 经 Git fresh clone/build 部署，7 服务 ready；其余 5 条空队列恢复维护前 running，DTC 仍 paused 6。
- 原下游验收 OCR 有同步结束证明，04:09:56Z 释放许可；模型在 provider 调用前失败，未创建执行进程，04:10:00Z 释放。停止核验记录：Server 一 `manual-releases/dtc-native-20261002/retained178-first-stop-proof.json`。
- 第二次独立留存验收 `5bc5721c-ea94-4a4d-95b4-13ce4bc9d8e2` 已启动，原件再次全量核验；04:16 已真实完成 2 次 OCR、1 次图片归属，第二张正在模型处理，无 Activity 失败。结果目录 Server 二 `manual-releases/retained178-476c318-live/`，此处尚不宣称完整通过。

## 同规格重复 Facts 与非 Facts 输出约束（12:25 北京）

- 上述留存验收实际完成 4 次 OCR / 3 份有效归属后 Review。前两份 Facts 均明确归到 120ct（4 VegCaps × 30 servings）；第 4 张是 240ct 正面包装图，模型却同时返回 `kind:other` 和 240ct 的 variantId，触发 `DTC.GALLERY_SCOPE_UNPROVEN`。全部原始答案保留，不能静默删字段后宣称通过。
- 新模型输出使用根对象内的分支 schema：非 Facts / unresolved 的 variantIds 强制为空，Facts 必须带归属和依据；消费校验仍保留。营销包装图能看出规格也不作 Facts 归属。
- 同规格多张 Facts 新增 DTC 联合核对：复用已产生的 OCR，Codex 同时查看独立、未改字节的原图，比较 serving、份数、所有剂量/单位/DV、行列、其他配料及脚注。仅明确一致且选中图覆盖完整内容时选择一张代表；冲突、需多图拼接、不可读或超过单次 8 张的边界仍 Review。该语义核对取代“多张一律 Review”的临时限制，不按位置、文件名或 OCR 字符串相等去重。
- 共用 Codex 传输增加可选多原图附件，既有单图调用字节与协议保持；不更改共用 Facts 业务步骤。独立模型许可延续逐图阶段的同一序列，新增 Workflow patch 保留旧历史行为。需 Mini 多图传输测试及新旧 Workflow 重放后才能部署。
- 本地 14 项图库/联合核对回归及 6 项活动接线回归通过，完整 `pnpm check` 通过。上一轮 8 次 provider 执行均有停止证据、许可全部释放（4 次 OCR synchronous response、4 次 process exit），记录于 Server 一 `retained178-476-stop-proof.json`。Mini 回归与真实验收尚待执行。
- `7e5820e` 已推送 main，Mini 10 项新旧 DTC 工作流重放、35 项既有 Codex 传输、14 项图库回归通过。新增多图客户端用例首次因测试夹具将已去掉前缀的场景名仍与 `vision-multiple` 比较而失败；`aa46a0e` 仅修正该夹具，Git 拉取后 9 项客户端测试全部通过，含两份原字节 SHA-256 与目录清理。合计 68 项 Mini 检查通过；完整 check 再次通过。Server 一部署正在执行，尚未声明新真实模型验收成功。
- Server 一于 04:32:57Z 经 Git fresh clone/install/build 部署 `aa46a0e`，7 服务 ready；维护中的 5 条空队列恢复原 running，DTC 保持 paused 6。新留存验收日志在 Server 二 `manual-releases/dtc-mixed-852546a/retained-aa46a0e-live.log`，新派生记录在 `manual-releases/retained178-aa46a0e-live/`，未重新访问网站。
- 新验收 `90189353-cce9-4ffd-82e7-c58ce3ce71d8` 第一张 OCR 完成后，模型服务拒绝输出 schema：`decision.oneOf is not permitted`（Worker 脱敏日志 04:34:42Z）。这是 Zod discriminatedUnion 的生成格式与服务端不兼容，尚无模型答案，两个规格仍 Review。改为普通 union 生成 `anyOf`，三种分支约束保持，增加实际 JSON Schema 输出回归；不放宽非 Facts 归属规则，不修改旧失败记录。
- 修复提交 `d8d9b03` 已推送 main，完整 check、Mini 15 项图库回归通过。schema 拒绝这一轮的 2 次执行都有停止证明（OCR synchronous response、模型 process exit），许可均释放，记录 `retained178-aa46-stop-proof.json`。修复部署中。
- Server 一于 04:39:27Z 经 Git fresh clone/build 完成 `d8d9b03` 部署并 ready；五条空队列恢复原状态。新的留存实测使用 `manual-releases/retained178-d8d9b03-live/`，完整原件校验后再调用 provider；此处待补真实结果。
- 留存验收 `966530bf-a10d-474e-865f-b0bc39f6cf47` 已真实完成 5 次 OCR、5 次逐图模型判断及 1 次联合核对，两个规格均 ready。240ct 对应 4 VegCaps / 60 servings；120ct 两张 Facts 对应 4 VegCaps / 30 servings，经联合核对所有剂量/DV/其他配料一致后选完整代表图。非 Facts 两张均未分配规格；全部决策、OCR 和原图引用保留。
- 后续两项 DtcVariantWorkflow 均被旧规划器以 `DTC.IDENTITY_CONFLICT` 拦下，尚未做 Facts。已证实是**手动验收工具的品牌来源丢失**：原 native projection 的 `brandEvidence` 为 matched，source 指向 Solaray 的真实 catalog；工具硬编码 single-brand 策略生成 source:null / site-brand，与线上 source-bound adapter 不一致。规格和图的身份相符，不是图片归属失败。
- 工具修正为从原 native Activity 的 sourcePlan 引用回读并验证 projection 散列，保留原品牌来源，生成后先经过同一 source-bound adapter reader 再允许 OCR。线上消费校验不放宽，原 Review 不修改。这一修改只涉及手动验收工具；下一步从 native Ego 开始完整闭环验收。
