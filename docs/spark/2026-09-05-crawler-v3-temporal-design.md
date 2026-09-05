# 爬虫 V3：Temporal 编排与独立原子模块设计

日期：2026-09-05 · 版本：V3 / Temporal 设计评审稿

本文件记录本轮讨论收敛后的设计，供用户复核；不代表已安装 Temporal、实现模块或切换生产。[分阶段计划](../../CRAWLER_V3_PLAN.md) · [HTML 架构图](../crawler-v3-architecture.html)

## 1. 真源、范围与决策

V3 使用全新执行与业务模块实现。旧代码、Claude Code 历史会话和旧任务只提供故障样本、业务背景与外部接口线索，不作为正确性标准，不接着旧 Job、租约或 Codex 会话执行。

本设计替代 V2 并行化计划中批处理、恢复、清理和调度的约定。产品服务文档仅作外部契约参考，生产准入前须针对实际服务版本验证。

首版范围：Amazon、GNC、Swanson、DTC；单文件处理；产品级推进；独立下线查询；汇总 Dashboard。Target / Walmart 是未来扩展示例，不新增对应适配器。

已比较自研队列加协调层、轻量工作流框架和 Temporal。本轮采用 Temporal 作为执行底座，收益是复用执行看板、调度、恢复、历史与测试工具；代价是 SDK / 确定性约束与服务运维。不在旧队列上再叠一层引擎。

## 2. 不变原则

1. **模块不是机器。** 每个原子角色独立配置、启动、停止、测试、部署；同机多 Worker，同模块多实例。
2. **Temporal 是执行真源。** 管依赖、任务队列、计时、执行历史；不再维护自研 claim / renew / retry_wait 状态机。
3. **编排与执行分开。** Workflow 只做确定性编排；API、Codex、OCR、浏览器、文件与数据库 I/O 放入 Activity。业务核心函数不依赖 Temporal。
4. **OCR 一次一个文件。** 用文件引用、产品 / 变体观察标识关联，不传批次。
5. **可靠交接后释放。** 业务 Worker 完成本步骤即可接下一项，不等下游；正在等待 OCR 服务响应的 Activity 仍属执行中。
6. **产品独立推进。** 好产品独立入库；需要 family 上下文时只限制该 family，不能扩大为全品牌屏障。
7. **失败被动留存。** 不自动重跑业务，Review 保存分类、完整候选和证据，不自动消费。
8. **产物长期保留。** R2 原始、派生、模型输出和完成凭证不随成功任务删除，无 cleanup 阶段。
9. **首版不自动下架。** 下线查询仅记录存在 / 确认缺席 / 未知，不推断全局停产。
10. **复用执行看板。** Temporal UI 看执行详情；自有 Dashboard 看业务汇总、只读 Review 与可选节点健康。

## 3. 职责与所有权

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 入口 API | 校验、业务请求 ID、提交 Workflow、入口回执 | 任务领取和依赖调度 |
| Temporal Service | 执行历史、队列、超时、流程状态 | 运行业务代码、启动机器、保存大文件 |
| 编排 Worker | 目录 / 产品 / 下线查询 Workflow | 直接操作浏览器、Clash、模型或数据库 |
| 原子模块 Worker | 拉取指定队列、完成一个职责、返回结果引用 | 决定下游流程、依赖其他模块的文件目录 |
| V3 业务库 | 身份、产物索引、不可变结果、Review、写入凭证、汇总 | 第二套竞争性的执行状态机 |
| R2 + Artifact Resolver | 保存证据、校验并解析本地 / 远端副本 | 成功后自动删文件 |
| 资源管理层 | Codex 额度、OCR 配额、浏览器与出口许可 | 业务待办队列或产品依赖调度 |
| 主机运行层 | 安装、启动、进程监督、部署、健康与凭证注入 | 产品业务依赖 |
| 产品服务 | 按验证过的契约写观测、身份归并与回读 | 爬虫调度 |

业务库可以记录执行 ID 和只读投影，但不复制引擎状态机。资源许可只表示资源所有权，不是另一套业务 Job 租约。入口提交 / 结果登记使用窄范围幂等交接记录，不扩张为自研工作流引擎。

## 4. 多机部署

Worker 主动长轮询 Temporal、领取任务并上报；不需要 Temporal 远程登录机器，也不需要 Worker 暴露公网接单端口。运行环境必须能访问 Temporal、R2 和所用服务。

| 位置（目标拓扑，非已部署） | 独立角色 |
| --- | --- |
| 常驻服务环境 | Temporal Service（托管 / 自建二选一）、入口 API、编排 Worker、业务库、资源服务、Dashboard |
| Mac mini | Amazon、GNC、Swanson、页面、文件、PDF、OCR、Codex 文本 / 视觉、校验等按需启动 |
| 美国 Windows | DTC 浏览器 Worker、隔离浏览器会话、对应 Codex 驱动 |
| 未来服务器 | 独立承接 PDF、OCR、文本或其他抓取能力，不修改产品业务流程 |

每个实例记录 `hostId / workerInstanceId / moduleId / buildVersion / capabilities`。队列按能力命名，必要时加地区 / 运行时，不默认绑定物理主机。例：`v3.ocr.file`、`v3.pdf.file`、`v3.capture.gnc.browser`、`v3.capture.gnc.scraperapi`、`v3.capture.dtc.browser.us`。同队列消费者须具备一致处理能力。

Temporal 的 Worker Versioning 管执行路由兼容，不替我们安装代码。系统服务 / 容器工具管进程监督；启动检查覆盖 schema、凭证、浏览器 / PDF 引擎、磁盘和网络。不健康实例停止接新任务，保留证据。机器数、Worker 数、账号总并发分别配置。

具体 Temporal / SDK 版本与 Windows 浏览器联动需要实机锁定，不能用“支持分布式”代替兼容性验证。浏览器桌面会话是否可在服务模式运行也是准入检查项。

## 5. 代码组织与设计模式

采用端口与适配器、按功能分包、组合 / 依赖注入、版本化策略、显式状态与幂等交接。不设计大继承树、插件市场或兼容所有引擎的抽象层。

建议目录（只作设计，未创建运行代码）：

```text
contracts/                 # 身份、ArtifactRef、结果、错误、策略版本
modules/
  catalog-discover/        # 与产品处理分开的目录发现
  capture-amazon/          # 各渠道独立部署
  capture-gnc/
  capture-swanson/
  capture-dtc/
  page-extract/
  artifact-fetch/
  pdf-process/
  ocr-file/
  text-interpret/
  image-interpret/
  product-normalize/
  product-validate/
  owner-resolve/
  product-ingest/
  product-verify/
  presence-check/
adapters/
  network/                # static-proxy、clash、scraperapi
  model/                  # OCR / Codex 驱动
  storage/                # R2、本地缓存
  pdf/                    # PDFium
  product-service/        # 写入与回读契约
workflows/                # Temporal 确定性编排
runners/                  # 薄 Activity / 独立 Worker 入口
apps/                     # 入口、业务 Dashboard、资源服务
deploy/                   # 平台启动配置，不进入业务核心
```

`module.run(input, ports)` 可以单测；runner 注入适配器、日志、取消和限额。角色共享运行库，但不把所有模块装进一个大 Worker。DTC 的 Codex 浏览器驱动属于抓取会话内部的适配器，不等于抓取 Worker 同时承担后续 OCR / 标准化。

## 6. 原子模块目录

| 模块 | 一次输入 → 输出 | 边界 |
| --- | --- | --- |
| 目录发现 | 品牌 / 站点范围 → 发现项、CatalogManifest | 不等产品处理；完整性不由入库数推断 |
| 产品抓取 | 一个挂牌 / 变体观察 → 页面、字段、文件来源 | 浏览器导航 / 切规格 / 读取在一个隔离会话内，不拆给不同 Worker |
| 页面整理 | 一份页面 → 原文 / 表格 | 不做最终营养范围排除 |
| 文件获取 | 一个来源文件 → 已校验 ArtifactRef | 校验真实媒体类型、hash，不按扩展名猜 |
| PDF | 一个 PDF + 操作 → 文字或逐页图片引用 | 不内部串接 OCR / Codex；页图保留父文件与页码 |
| OCR | 一张图片 → 原始文字与来源 | 不判断业务、不入库、不处理批次 |
| Codex 文本 | 明确范围文本证据 → 带来源候选 | OCR 文本路径依赖 OCR，页面路径可以并行 |
| Codex 视觉 | 一张图 + 意图 → 视觉候选 | 按证据计划启用，不默认每张图双跑 |
| 标准化 | 单 SKU 候选 + 按需封闭 family 上下文 → 规范候选 | 不全品牌打包，不自造产品服务身份键 |
| 确定性校验 | 候选 + 策略 → 通过 / 问题 | 不暗中调用模型修复 |
| 公司归属 | 来源身份与候选 → 确认归属 / 冲突 | 失败仍完整保留产品与 Facts |
| 写入 | 一个合格 SKU 观测 → 回执 / 未知 | 首版全局串行，不等品牌完成 |
| 回读 | 写入标识与预期 → 核验结果 | 只读，不在失败时再次写入 |
| 下线查询 | 一个 Listing / URL → exists / confirmed_absent / unknown | 不直接下架，不推断全局停产 |

目录可分页发布已可靠发现的项，但传输分页不是 OCR 执行批次。发现项有稳定 ID 防重复启动；最终目录 manifest 单独封闭。

## 7. 流程与并发规则

### 三类流程

- `CatalogWorkflow`：发现 → 可靠发布产品请求 → 封闭目录 → 完整同范围目录才生成缺席核查。目录后来失败不撤销已发布产品证据。
- `ProductWorkflow`：一次挂牌 / 变体观察；组织抓取、文件、OCR / 文本 / 视觉、标准化、校验、归属、写入与回读。
- `PresenceWorkflow`：独立下线查询，可由目录比较触发或单独提交。

目录关闭不得取消已启动产品：对子流程显式配置关闭策略，或通过可靠启动凭证启动独立产品 Workflow。长目录采用分页、子流程或 Continue-As-New 的边界在压力验证中锁定；不建立保存所有文件正文的无限品牌流程。

### 首版证据规则（本次文档评审范围）

1. 启动时固定 `evidencePlanVersion` 和选择路径，所有证据绑定同一 `observationId`。
2. 页面整理 → Codex 文本路径，可与文件获取 → 按需 PDF → OCR / 文本处理路径并行；各路径内部遵守前后依赖。PDF 文字直接进入文本路径，页图则逐文件 OCR。
3. OCR 文本解析必须等对应 OCR；未返回不能视为空文本。
4. 视觉直读由计划指定。成功但证据不足可走已声明补充路径；OCR 请求失败不自动换 Provider 或改跑视觉。
5. 最终判断等待所选必需证据到明确终态。必需证据缺失 / 冲突进 Review；可选缺失记录原因，不伪造结果。
6. 并行结果追加保存，按版本和来源汇合，禁止最后写覆盖先前结论。
7. 需要 family 比较时只使用本次已封闭的 family manifest；所需上下文无法建立则隔离该产品 / family，不无限挂起全品牌。
8. 每 SKU 独立验收 / 入库；family 共享上下文，不要求全体成功。

证据屏障是 Workflow 等待，不是占槽的 Join Worker；标准化、冲突判断、校验则是独立模块。

### 资源许可与背压

Temporal 的 Worker 容量不等于跨机 Codex 账号额度，也不知道某个 Clash 出口是否可用。

- 昂贵 Activity 调度前通过短操作申请资源；无许可立即返回，Workflow 持久等待通知 / 定时复查。许可查询可重复，不是业务重跑。
- 资源层只存容量、许可、世代和占用者，不存第二份业务待办；按账号、OCR、浏览器会话、出口分别管理。
- 获许可后才调度业务任务；Worker 开始外部操作前校验并确认占用。许可失效且尚未执行则返回“未执行 / 等资源”，不是业务失败。
- 设置有界预取、并发和资源预留窗口，不先领取几十个任务再等本地 semaphore。
- 失去资源所有权的旧实例不得发起新调用。运行中副作用未知时不只凭许可到期自动转交，先核验 / 隔离。
- 磁盘、R2 和积压触发受控背压；持续流水不等于容量无限。普通排队不直接进入 Review。

## 8. 文件、R2 与本地复用

`ArtifactRef` 包含 `artifactId / observationId / 来源产品与变体标识 / kind / mediaType / sha256 / byteSize / R2 key / 产生模块与版本`。PDF 页另带 `parentArtifactId / pageIndex`；文件与多个产品的关系显式记录。

OCR 输入为 `{ file: ArtifactRef, operationId, inputFingerprint, schemaVersion }`。来源 URL 可记录，临时签名 URL 不是永久 ID。尚未入库时使用来源身份与内部 observation ID，不要求先有正式 productId。

读取顺序：当前运行环境可访问的本地副本 → 校验 hash / 大小 / 完整性 → 直接使用；否则从 R2 稳定 key 获取授权读取地址、下载并校验。同一物理机器但容器路径不可见仍走 R2。没有有效副本就报告 artifact 错误，不猜路径或使用旧文件。

同机复用省重复下载，不省持久备份。R2 至少保有可靠上传的原件、派生结果和完成清单。Temporal 载荷仅放引用和摘要，不放图片 / PDF / 大段日志。

不配置成功后的 cleanup。生产准入检查 R2 lifecycle 是否会过期删除。首版不自动清除唯一的本地完成证据；将来缓存回收必须另定政策，先确认 R2 副本与引用完整。

## 9. 处理完成与可靠交接

以下是结果 / 交接事实，不是复制 Temporal 执行状态机：

| 事实 | 含义 | 能否推进下游 |
| --- | --- | --- |
| `computed_local` | 处理已返回，本地结果与完整清单原子保存 | 否 |
| `artifact_durable` | 结果与清单已在 R2，校验通过 | 还需登记 |
| `result_registered` | 业务库已登记结果、指纹和产物关系 | 等引擎确认 |
| Temporal 已记录 Activity 完成 | 引擎持有可消费引用 | 按依赖推进 |
| `delivery_unknown` | 登记 / 回执状态未知 | 只核验，不重做业务 |

完成清单含 operation ID、输入 hash、代码 / 模型配置 / schema / 策略版本、所有输出 hash、完整标记、外部请求 ID（如提供）。只有原图、文件存在、`.ready` 文件名或部分日志不算完成证明。

正常路径：处理一次 → 完整结果 → R2 → 幂等登记 → Activity 返回引用 → 引擎记录完成。交接阶段可以占用短执行时间，不等于陪下游等待。

异常路径：先核验清单与登记。输入 / 版本一致且输出完整，只补传 / 补登记 / 报完成。不能伪造已超时 Activity 成功；超时后的流程通过独立只读核验 Activity 采用已验证结果。只剩本地结果时由交接恢复功能上传，不再 OCR。机器不可达、半份结果或身份冲突进入 Review。

允许连接恢复、幂等投递重发、只读核验；不允许因此重跑抓取 / OCR / Codex / 数据库写入。交接重试有界、可观察，超限保留事实和 Review，不能无限占槽。

## 10. 错误、Review 与历史任务

业务 Activity 显式 `maximumAttempts: 1`。检查内部 OCR / HTTP / Codex / 产品客户端的自动重试、模型修复循环和 Provider 切换。Workflow Task 重放、连接恢复与业务重跑区分。ScraperAPI 等提供商可能内部重试，我们只能约束不重复提交，不能保证其源站请求次数。

未执行且资源不可用 → 等待；已执行失败 / 未知 → 核验证据，无法确认则 Review。下游用 `blockedBy` 关联根因，不伪装成也执行失败。产品级捕获异常，避免取消兄弟产品。

Review 保存在业务库，含原始错误、分类、阶段、host / worker / Workflow / Activity ID、输入输出引用、完整候选与 Facts、完成凭证、确认根因。Review 登记本身失败时保留引擎历史与告警，不能计为已经可靠落库。

| 分类 | 示例 |
| --- | --- |
| SOURCE | CAPTCHA、目录不完整、页面不可读 |
| RUNTIME | CDP、页签冲突、schema 缺失、启动失败 |
| ARTIFACT | 缺文件、类型错误、hash 不符、R2 传输 |
| PROCESSING | OCR / Codex 调用失败、输出契约错误 |
| VALIDATION | 必需证据缺失、配方 / 规格冲突 |
| IDENTITY | 来源身份或公司 / 品牌归属不确定 |
| INGEST | 写入失败 / 未知、回读不一致 |
| SCHEDULER | 重复实例、取消不生效、生命周期异常 |
| UNCLASSIFIED | 证据不足，原因无法确认 |

Review 不挂等待人工的长期 Workflow，不自动消费，不设“重试全部”。以后明确要求重试，建立关联新请求，复用经验证且输入未变的上游，保留原 Review。Temporal UI Reset / 重新启动不是日常恢复按钮，须限制权限并遵守业务规则。

历史成功任务：证据建立隔离验证副本，运行新实现；旧输出仅参考，以人工确认样例 / 确定性规则验收。历史失败任务：保留原 Review、补分类；复现必须另建显式测试副本，不自动进入生产重跑。

## 11. 入库与下线查询

每个就绪 SKU 独立进入写入队列。首版一个激活写入部署、并发 1，并用共享全局写入许可阻止第二实例；不能把每台并发 1 当全局串行。

写入许可有占用者和世代。产品服务不支持 fencing 时保守交接：旧写者是否停止 / 旧请求是否结束无法确认，不自动转交许可；只读核验仍可执行，其他抓取处理不停止。

写入和回读独立。稳定幂等身份与请求指纹固定；回执丢失记录 `write_unknown`，先回读，不认为“没有写入”。产品库写权限仅由写入适配器持有。

首版外部提交始终使用 `partial` 安全语义，禁止触发缺席下架的 full 收口。独立产品提交 run 或已验证可增量追加的共享 run，由 P0 针对实际服务确认；未验证不得生产写入。内部 observation ID 与外部提交 run ID 分离。

下线查询：完整、同渠道同品牌 / 站点的目录发现集合，与历史 Listing 做差。不是用成功入库集合做差；抓到但 OCR 失败的产品仍算发现。目录不完整不自动推断缺席；单链接请求可独立提交。

只输出 `exists / confirmed_absent / unknown`、时间和证据。验证码 / 网络失败 / 缺货都不是已下架。首版不写 inactive，不推断跨渠道全局停产。

## 12. PDF 与网络

### PDF

推荐 PDFium / pypdfium2 独立 Python 模块，移除 Swift / AppKit / PDFKit 绑定。PDFium 非线程安全，并发用隔离进程；限制页数、尺寸、内存和时间，坏文件、加密文件、超大文件分类报告。跨平台支持以真实样本验证为准。PDF.js 是备选，不首版双引擎并行建设；引擎通过端口替换，不改 OCR 文件契约。

### 网络三层

1. 站点模块描述能力：HTTP、二进制下载、渲染 HTML、交互浏览器、地区与会话要求。
2. 策略 / 资源层选择已允许 Provider，分配出口 / 账号 / 会话许可，记录配置版本与原因。
3. Provider Adapter 支持静态 IP / 代理池、Clash、ScraperAPI，预留未来模式。

渲染 HTML 不等于交互浏览器，模拟 Page 不能被当作能力等价。失败不自动换 Provider。

Clash 的节点 / 订阅 / 组配置由操作者管理；运行时仅使用明确授权的专用组 / 专用核心。现有共享组的选点仍由操作者控制，本次不更改节点、订阅或系统代理。

一个浏览器会话的出口固定。并发用独立核心，或经验证的独立监听器与独立绑定策略组；多个端口共享同一个可变 selector 不算隔离。不得影响其他抓取、Codex、OCR、R2 的路由。控制 API 限本机 / 私网并鉴权；凭证不写任务载荷 / 日志，保持 TLS 校验。

## 13. 界面与可观察性

- Temporal UI：执行列表、历史、Activity、等待 / 超时、消费者与版本。
- Dashboard：发现 / 处理 / 入库 / Review、渠道 / 错误类汇总、交接积压、真实采集的成本和吞吐、执行详情跳转。
- Review：被动持久记录与必要只读查询，无审批 / 自动重跑。
- 可选节点摘要：hostId、健康时间、运行模块、磁盘、浏览器 / 网络健康；不建设完整远程机器控制台。

Workflow Completed 不等于入库成功；另记 `businessOutcome`，入库以写入回执与回读为准。Search Attributes 记录品牌 / 渠道 / observationId 等必要信息，不放秘密。

Visibility 最终一致、计数可能近似并受保留期影响，不能作为长期业务账本，也不靠它轮询推进流程。准确统计来自业务库。Temporal 持久库与业务库即便共用 PostgreSQL 服务也应隔离库 / schema / 凭证，不读写 Temporal 内部表。

## 14. 验收矩阵

| ID | 场景 | 必须满足 |
| --- | --- | --- |
| A01 | OCR 传入两文件 | 契约拒绝；单文件单 operation ID |
| A02 | A 等 OCR，B 就绪 | 页面 Worker 接 B，无下游等待占槽 |
| A03 | 一个 SKU 失败 | 该 SKU Review，其他产品继续入库 |
| A04 | URL 过期 / 同机容器不可见 | 稳定 key 重解析，不靠对方目录 |
| A05 | 同机缓存 / 跨机读取 | 有效缓存不重下；跨机走 R2 校验 |
| A06 | OCR 完成后、上报前退出 | 只补交接，OCR 外部提交次数不增加 |
| A07 | 只有原图 / 半份输出 | 不认完成；保留分类 Review |
| A08 | 版本 / 输入改变 | 不错误复用、不混合观察版本 |
| A09 | 重复回执 / 指纹冲突 | 相同结果幂等；冲突可见不覆盖 |
| A10 | 写入响应丢失 | 只读核验，不自动再写 |
| A11 | 双写者 / 旧写者失联 | 全局最多一个许可；未知请求不自动转交 |
| A12 | 账号额度不足 / 重复实例 | 未执行等待，无 Worker 内囤积任务 |
| A13 | Clash 并发会话 | 出口隔离，不改变其他流量 |
| A14 | 页签 / 规格串图 | 来源与身份校验阻止合并 |
| A15 | 公司归属失败 | 产品与 Facts 完整留存 |
| A16 | 部分目录 / 产品 OCR 失败 | 前者不推断缺席；后者仍在发现集合 |
| A17 | 历史失败导入 | 分类 Review，不产生生产业务执行 |
| A18 | 成功结束 | R2 原件 / 中间结果 / 凭证仍可读，无自动下架 |
| A19 | 异常与取消 | 核验 / 隔离，真实阶段可追踪，不取消兄弟产品 |
| A20 | Mac / Windows / 目标服务器 | SDK、PDF、浏览器与交接实机通过后准入 |
| A21 | Completed + outcome=review | 不算入库成功；Review 落库后才计数 |
| A22 | 新流程历史回放 | 检查编排兼容，不重跑历史 OCR / 生产写入 |

## 15. 生产准入与非目标

以下是后续阶段的具体准入门，不代表本次已经测试或部署：

- P0：隔离开发验证；生产 Temporal Cloud / 自建的成本、凭证和网络选择另行批准，不在本次创建付费资源。
- P0：锁定 SDK / PDF / 浏览器版本、逐产品 partial 提交形式；未通过不得写生产。
- P2：按第 7 节建立版本化证据 / family 规则和确认样例，不让模型临场决定屏障。
- P3：确认实际 Clash 核心 / API，只在授权测试资源验证选择，不修改现有共享组。
- P5：全部安全验收后批准停止旧接单、核验在途副作用、启用 V3；不把旧失败转成 V3 运行任务。

不建设通用流程编辑器、第二套调度、远程节点控制平台、全部渠道、自动下架或自动 Review 修复。生产写入、付费服务、代理配置变更和旧系统切换都不属于本次文档更新。

## 16. 官方参考（2026-09-05 核对）

- [Workers](https://docs.temporal.io/workers) 与 [Task Queues](https://docs.temporal.io/task-queue)：外部进程、主动拉取、队列能力一致性。
- [Workflow Execution](https://docs.temporal.io/workflow-execution)：确定性恢复与等待。
- [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies)：Activity 默认重试，最大尝试次数 1 关闭重试。
- [超时与心跳](https://docs.temporal.io/encyclopedia/detecting-activity-failures)：取消与进度需要模块配合。
- [UI](https://docs.temporal.io/web-ui) 与 [Visibility](https://docs.temporal.io/visibility)：查询、保留期、最终一致性。
- [Worker Versioning](https://docs.temporal.io/worker-versioning) 与 [测试](https://docs.temporal.io/develop/typescript/best-practices/testing-suite)：版本与回放。
- [PDFium 线程限制](https://pypdfium2.readthedocs.io/en/stable/python_api.html#incompatibility-with-threading)：进程隔离。
- [mihomo API](https://wiki.metacubex.one/en/api/)：能力参考，不代表当前核心已兼容或授权修改。
- [R2 Lifecycle](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) 与 [签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)：持久对象与临时读取地址分开。
