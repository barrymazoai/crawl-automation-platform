# 分布式商品抓取与语义清洗流水线设计

- 日期：2026-08-20
- 状态：已确认，待实现
- 范围：Railway 通信服务、Windows 浏览器抓取 Worker、Mac mini 语义清洗 Worker、Mac mini 管理页面与产品入库

## 1. 背景与目标

现有人工 Prompt 驱动的抓取流程存在三个主要问题：网站或产品数量较大时容易中途停止；单纯依靠 Prompt 难以稳定控制并发、重试和恢复；Windows 浏览器环境与 Mac mini 清洗、入库环境之间缺少可持久的任务交接。

本设计将流程改造为由程序编排、Codex 负责网站理解与语义转换的分布式流水线，目标是：

1. 同时处理多个网站，且并发数由程序硬限制。
2. 任意阶段崩溃、断网或重启后可从最后确认的批次续跑。
3. Windows 只负责有浏览器依赖的抓取，Mac mini 负责 Codex 语义转换、图片识别、验证和入库。
4. 同一网站第一次运行后沉淀前置清洗规则，后续降低噪音与 Token 开销，但不用固定规则替代语义理解。
5. 输出与 Link Monitor 现有入库结构保持一致，每个变体作为一个独立产品。
6. 自动验收通过才入库；无法可信判断的任务保留证据并等待人工审核。

## 2. 非目标

- 不修改 Link Monitor 的代码、队列或数据库流程。
- 不让 Link Monitor 和新系统共用一个全局并发门闩。
- 不在 Railway 容器中运行 Chrome 或 Codex；Railway 仅负责通信、调度、全局状态和文件存储。
- 不使用单一固定的 Amazon 式页面解析器处理任意网站。
- 第一版不接入飞书、邮件或其他主动告警渠道。

## 3. 总体架构

```text
Mac mini 管理页
  │ 提交网站 / 查看进度 / 人工审核
  ▼
Railway API + PostgreSQL + Storage Bucket
  ├── capture 任务 ──► Windows Supervisor
  │                       ├── Capture Worker 1: Luna Medium + Chrome
  │                       └── Capture Worker 2: Luna Medium + Chrome
  │
  └── clean 批次 ───► Mac mini Supervisor
                          ├── Clean Worker 1: Codex 语义/视觉
                          └── Clean Worker 2: Codex 语义/视觉
                                   │
                                   ▼
                         验证器 + 幂等入库器
                                   │
                                   ▼
                         Supply Smart 产品数据库

Link Monitor: 保留自己的 2 个并发，与上述队列独立
```

### 3.1 并发口径

- Windows 抓取阶段：最多 2 个活跃 Codex/Luna Medium 任务，每个任务一次只负责一个网站。
- Mac mini 新系统清洗阶段：最多 2 个活跃 Codex 任务。
- Link Monitor：继续保持 2 个并发。
- 三者不设置跨机器全局上限；全部繁忙时可同时有 6 个 Codex 调用。
- Railway 可同时发放 2 个 Mac 清洗任务，但实际 Codex 进程和认证位于 Mac mini，不在 Railway 中。

Windows 抓取任务明确使用 `gpt-5.6-luna` 与 `medium` reasoning effort，不使用 High。Mac 语义/图片阶段也必须在每次调用时显式指定模型与 effort，首版默认同样使用 Luna Medium，不继承机器上交互式 Codex 的默认配置。

## 4. 核心组件

### 4.1 Railway 通信服务

责责范围：

- 管理一次性网站与周期性网站。
- 创建每一次实际运行记录。
- 原子分配任务、发放租约、处理心跳和租约过期。
- 为 Bucket 生成短期上传/下载签名 URL。
- 验证批次文件大小和 SHA256。
- 校验任务状态转移、租约所有权和幂等键。
- 为 Mac mini 管理页提供任务、进度、异常和审核 API。

### 4.2 Windows Supervisor

- 使用原生 Windows Chrome/Playwright，不依赖 Windows 虚拟机内的 GUI 自动化。
- 长驻轮询 capture 队列，同时管理最多两个 Codex 抓取 Worker。
- 每个网站使用一个 Luna Medium，不再为单站启动 5 个子 Agent。
- 运行前确保使用最新的抓取 Skill。给 Agent 的 Prompt 只要求“拉取最新 Skill”，不写死具体拉取命令。
- 生成网站 Manifest，按批次抓取页面、接口响应、截图、图片和变体证据。
- 每完成一批立即上传，不等整站结束。

### 4.3 Mac mini Supervisor

- 轮询 clean 队列，边下载边清洗，与 Windows 抓取构成流水线。
- 管理最多两个 Codex 清洗 Worker。
- 先应用该站的 Site Cleaning Profile 缩小证据包，再调用 Codex 进行语义与视觉转换。
- 保存 Codex 原始输出，再执行解析、Schema 校验、变体展开、映射和入库。
- 将审核任务的本地证据一直保留到人工处理完成。

### 4.4 Mac mini 管理页

在已有网页上增加：

- 网站输入、一次性任务和周期配置。
- Windows/Mac Worker 在线状态、心跳、当前站点和当前阶段。
- 任务列表与状态计数。
- `needs_review` 任务的数量对账、异常产品、截图、原始输出和清洗结果。
- 重新抓取、重新清洗、确认入库和放弃任务。

页面通过 Mac mini 本地后端代理 Railway API，不把服务凭据写进静态 HTML。第一版只在网页显示状态，不发送飞书或邮件。

## 5. 任务数据模型

Railway PostgreSQL 中的逻辑实体：

| 实体 | 作用 |
| --- | --- |
| `crawl_source` | 站点 URL、是否启用、一次性/周期配置、下次运行时间 |
| `crawl_run` | 某站的一次实际运行、总体状态、数量对账和审核结果 |
| `crawl_batch` | Manifest 的一个批次、抓取/上传/清洗/入库状态 |
| `artifact` | Bucket key、文件大小、SHA256、类型和清理状态 |
| `worker_lease` | 阶段、Worker、lease token、心跳与过期时间 |
| `site_cleaning_profile` | 站点前置清洗规则、版本、页面指纹、生成来源与有效状态 |
| `review_event` | 触发原因、人工动作、时间和结果 |
| `job_event` | 不可变的状态事件与调试线索 |

Railway 是全局真源。SQLite 不存全局队列顺序、最终任务结果或产品数据。

## 6. 本地 SQLite 设计

Windows 和 Mac mini 每台机器一个 SQLite，不是每个 Codex 进程一个。Supervisor 是唯一逻辑写入者，Agent 不直接操作 SQLite。

本地记录包括：

- `job_id`、`batch_id`、`attempt`、`worker_id` 和 `lease_token`。
- 当前阶段与最后完成的检查点。
- Codex thread/turn 识别符与进程信息。
- 本地文件路径、SHA256、上传/下载/删除状态。
- 已生成但尚未被 Railway 确认的 Outbox 事件。
- 重试次数、最后错误与最后心跳。

SQLite 开启 WAL、`busy_timeout`、事务和 schema version。Outbox 按幂等键重试，直到 Railway 返回已接受或已处理。

## 7. 端到端数据流

### 7.1 创建任务

- 一次性任务直接创建 `crawl_run`。
- 周期任务由 Scheduler 根据 `crawl_source.next_run_at` 创建新的 `crawl_run`。
- 每一轮运行独立留档，不覆盖上一轮运行状态。

### 7.2 Windows 发现与抓取

1. Worker 每 10 秒轮询可领取任务。
2. Railway 在事务内分配任务并返回 `job_id + lease_token`。
3. Worker 每 30 秒心跳续租。
4. Luna Medium 使用浏览器与最新抓取 Skill 生成完整的产品 URL Manifest。
5. 默认每 50 个产品 URL 形成一个 capture 批次；页面过重时可缩小。
6. 每个批次保存原始页面、必要网络响应、截图、候选图片、来源 URL、变体证据和 Manifest 片段。
7. 压缩后上传 Bucket，Railway 校验大小和 SHA256。
8. 上传确认后 Windows 可删除该批次本地临时文件。

### 7.3 Site Cleaning Profile

Site Cleaning Profile 只负责“前置去噪”，不负责输出产品语义字段。它可包含：

- 产品主体区域与需要排除的导航、页脚、广告、脚本区域。
- 站内产品 JSON、JSON-LD、变体接口或网络响应的位置。
- 产品图片画廊和变体原始证据的保留规则。
- 页面结构指纹与最低证据完整性要求。

第一次运行由 Codex 产生并回放验证 Profile，后续运行优先使用。Profile 存为受限 JSON/浏览器动作，不直接执行 Codex 生成的任意脚本。Profile 输出为空、必要证据缺失、产品数量异常或页面指纹变化时，停用当前版本并回退到完整 Codex 模式。

### 7.4 Mac 语义与图片转换

1. Mac 在 capture 批次成为 `artifact_ready` 后即可领取，不需等整站抓取完成。
2. 下载后校验 SHA256，并将完成点写入 Mac SQLite。
3. 应用 Site Cleaning Profile 产生精简证据包，不对标题、价格、SKU、变体或图片含义作固定推断。
4. 按输入体积动态切批：简单产品一批 5–10 条，复杂产品或图片较多时单独处理，不固定使用 Amazon 流程的 50 条语义批次。
5. 候选图片先下载到 Mac 本地，再作为本地图片输入交给 Codex；不只提供 URL。
6. Codex 负责语义字段、变体关系、真实 SKU、图片归属、图片识字与统一中间 JSON。
7. Codex 原始输出先原子落盘，再解析。解析器修复后可直接从 raw 重放，不再消耗模型额度。
8. 文字、变体原始数据与图片哈希全部不变时，允许复用上次 Codex 结果；任一证据变化都必须重新转换。

### 7.5 验证与入库

程序不依赖 Agent 的“已完成”表述，而是执行下列硬验证：

- Manifest 中每个 URL 都有成功、确认下架或待审核的明确结果。
- 所有批次文件和 SHA256 一致。
- 抓取成功页数、中间产品数、变体数、验证后记录数和实际入库数可完整对账。
- 每个产品和变体通过 JSON Schema 与业务不变式。
- 重复 `external_id`、价格异常、验证码页、空正文或数量突然大幅下降会触发审核。

入库使用 Link Monitor 现有目标结构：

- 每个变体展开成一个独立 `product`。
- 以 `channel + product_channel.external_id` 作为幂等身份。
- 真实 SKU 原样保存；源站未提供时不伪造，记录 `sku_missing: true`。
- 同系列变体通过 `product_family` 关联。
- 同一外部身份重跑时更新原记录，不创建重复产品。

## 8. 周期更新与软下架

- 页面明确返回 404、已下架或不可售时，在本次完整运行结束后标记 inactive。
- 产品只是没有出现在新 Manifest 中时，第一次标记 `suspected_missing`；连续两次完整成功的抓取都未出现后才标记 inactive。
- 当前运行不完整或已进入 `needs_review` 时，不改变已有产品的下架状态。
- inactive 产品后续重新出现时恢复原记录，不创建新主键。
- 不物理删除产品历史记录。

## 9. 状态机与错误处理

运行级状态使用总体状态加四个独立阶段状态。`capture_status`、`clean_status`、
`ingest_status` 和 `cleanup_status` 分别推进，因此 Windows 仍在抓取后续批次时，
Mac 可以同时清洗已经就绪的批次。总体 `status` 只表达 queued、active、
retry_wait、needs_review、cleanup_pending 与终态，不把并行阶段错误压成一条线性进度。

单个批次的主流程状态：

```text
capturing
  -> uploading
  -> artifact_ready
  -> cleaning
  -> cleaned
  -> ingested
  -> cleanup_pending
  -> completed
```

辅助状态：

- `retry_wait`：可恢复技术故障的自动退避等待。
- `needs_review`：需要人工判断且必须保留证据。
- `failed`：超过自动重试限制且无可执行恢复路径。
- `abandoned`：人工明确放弃，随后允许清理保留文件。

错误策略：

- 浏览器崩溃、断网和进程退出：从检查点自动恢复，最多重试 3 次。
- 页面抓取不完整、产品数量校验不通过：Luna 补抓 1 次，仍失败则 `needs_review`。
- 登录失效、验证码和明显反爬：直接 `needs_review`。
- Codex 输出或结构校验失败：优先从已保存 raw 重新解析；需要模型重做时只重做失败批次。
- Codex 额度耗尽：该 Supervisor 停止领取新任务，保留所有检查点，额度恢复后续跑。
- 租约失效或任务已重新分配：旧 Worker 立即停止提交，本地结果转为隔离证据。

## 10. `needs_review` 与人工操作

触发原因包括但不限于：

- 网站验证码、登录阻断或反爬。
- Manifest 不完整、产品或变体数量无法对账。
- 价格、币种、变体或图片关联存在多种合理解释。
- 必填结构字段缺失，或 Codex 输出无法可信解析。
- 产品数量较上次成功运行突然大幅变化。

`needs_review` 任务的 Bucket 原始包、Codex raw、Mac 本地工作文件和对账报告一直保留，不按时间自动删除。只有两种情况触发清理：

1. 人工审核后任务成功入库并通过回读验证。
2. 人工明确放弃任务。

人工“确认入库”可越过数量波动等软警告，不可越过 JSON Schema 错误、缺少稳定 `external_id` 等硬错误。

## 11. 文件生命周期

### 11.1 成功任务

1. Windows 上传批次后，Railway 验证 SHA256。
2. 验证成功后 Windows 删除本地该批临时文件。
3. Mac 下载、转换、入库，等待数据库事务提交。
4. 程序回读产品、变体与入库数量。
5. 对账成功后进入 `cleanup_pending`。
6. 删除 Bucket 文件、Mac 原始文件、解压文件、图片和中间文件。
7. 删除都确认成功后才标记 `completed`。

清理失败不回滚已入库数据，而是保持 `cleanup_pending` 并持续重试。Railway 和 SQLite 保留哈希、数量、完成时间和清理结果等轻量审计信息。

### 11.2 审核任务

未审核完成前不删除任何可用于复现和人工判断的证据。

## 12. 通信与安全边界

- Windows 和 Mac mini 都只主动访问 Railway HTTPS，不向公网暴露入站端口。
- Windows、Mac 清洗服务和 Mac 管理页使用不同的服务凭据和权限。
- Windows 只能领取 capture 任务、发心跳和上传文件，不拥有产品数据库凭据。
- Mac 只能领取 clean 任务、下载对应文件、提交验证/入库结果和执行审核动作。
- 产品数据库凭据只保存在 Mac mini 清洗服务，不交给 Windows 或 Railway。
- Bucket 上传/下载使用短期签名 URL，原始大文件不经过 API 服务内存。
- 任务更新必须同时提交 `job_id`、`lease_token` 与幂等键；过期 Worker 不能覆盖新 Worker 结果。

Railway API 的最小能力集：

- 创建/查看 `crawl_source` 与 `crawl_run`。
- 按阶段领取任务。
- 心跳、续租与释放租约。
- 获取上传/下载签名 URL。
- 提交批次成功、失败、审核与清理结果。
- 查询任务详情、事件、对账数据与 Worker 状态。
- 提交重试、确认入库或放弃审核任务。

## 13. 与 Link Monitor 的关系

新系统参考 Link Monitor 的成熟实践：

- 重活在宿主机执行，Web/状态服务不持有本地 Codex 认证。
- 批与批之间持久化，不把整轮结果支撑到最后一次保存。
- Codex 原始输出先落盘，解析失败可从 raw 回放。
- 模型与 effort 在每次自动调用中显式指定。
- 使用稳定外部身份实现断点续跑与幂等入库。

但不复制 Amazon 固定 HTML 解析器、固定 50 条语义批次或任何 Amazon 特有规则。新系统的网站前置清洗规则由首轮 Codex 针对站点生成，最终语义与图片识别仍交给 Codex。

## 14. 可观测性

Mac mini 页面必须展示：

- Windows/Mac Worker 最后心跳、当前任务、批次和运行时长。
- 站点 Manifest 数、已抓取数、已上传数、已清洗数、已验证变体数和已入库数。
- 已完成/失败批次、重试次数、最后错误和预估剩余时间。
- `needs_review` 数量、保留时间和磁盘/Bucket 占用。
- Codex 额度耗尽、Worker 超过 5 分钟无心跳、重复失败和清理失败等状态。

第一版仅在网页上展示，不发主动通知。

## 15. 测试与验收

### 15.1 单元测试

- 状态机与非法状态转移。
- 租约发放、续租、过期与旧 token 拒绝。
- Outbox 重放与幂等键。
- Manifest 切批与输入体积动态语义切批。
- Site Cleaning Profile 版本、指纹校验与失效回退。
- Codex 输出 Schema、变体展开、SKU 缺失和外部身份幂等。
- 软下架的两次缺失确认规则。
- 入库未完成时禁止清理文件。

### 15.2 集成与故障演练

必须覆盖：

- Windows 抓取到一半进程退出。
- Bucket 上传成功但完成回调断网。
- Mac 在 Codex 返回后、raw 解析前退出。
- Mac 在入库中途重启。
- 重复上传、重复回调和租约过期重新分配。
- Codex 超时、额度耗尽与批次失败。
- `needs_review` 长期保留与审核后清理。
- Bucket 或 Mac 本地文件删除失败后续试。

验收要求是：不丢失任务，不产生重复产品，不从头重做已确认批次，不在入库验证前删除证据。

### 15.3 网站覆盖与灰度

首轮选择 3 个结构不同的网站：

1. Shopify 类网站。
2. WooCommerce 或普通服务端渲染网站。
3. JavaScript 动态变体与多图片网站。

首批所有结果强制进入人工审核，确认产品、变体、SKU、价格、图片和数量对账正确后，再开启“硬验证全部通过后自动入库”。灰度通过后再将 Windows 抓取和 Mac 清洗均提高到并发 2。

## 16. 备选方案与取舍

### 16.1 纯 Prompt 编排

放弃。它无法稳定保证并发、租约、重试、幂等和文件生命周期，也是现有流程中途停止的主要风险。

### 16.2 全部使用固定解析器

放弃。新系统面向任意网站，不具备 Amazon 那样稳定的单一页面结构。固定规则仅用于机械处理、验证和最终映射。

### 16.3 第一次生成可执行站点脚本

不作为默认。直接执行 Codex 生成的任意脚本风险较大，首版使用受限 Site Cleaning Profile；无法表达的站点继续走完整 Codex 流程。

### 16.4 Windows 与 Mac 共用两个全局 Codex 槽位

当前不采用。Windows 抓取与 Mac 新系统清洗分别保持 2 个并发，用户已接受最大 6 个 Codex 任务同时运行的初始方案。

## 17. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 任意网站的结构变化 | 页面指纹、Profile 版本化、异常自动回退 Codex |
| Codex 输出遗漏或错位 | 来源 URL/外部 ID 对齐、Schema、数量对账、raw 保留 |
| 长任务中途退出 | 批次持久化、SQLite 检查点、Railway 租约与 Outbox |
| 重复消费或双写 | 租约 token、幂等键、稳定 `external_id` |
| 额度耗尽 | 每端并发硬限制、明确检测 usage-limit 并停止新任务 |
| 失败证据占满磁盘 | 管理页显示占用；成功/放弃后可恢复清理；未审核时不自动删除 |
| 过早删除原始文件 | 入库事务 + 回读对账后才进入 `cleanup_pending` |

## 18. 成功标准

实现只有在以下条件全部满足时才可交付：

1. Windows 和 Mac 任一进程在任意批次中退出后可续跑。
2. 重复上传、重复回调、旧租约回调和重复入库不产生重复产品。
3. 对一个大网站可分批上传和清洗，不因一次运行过长丢失已完成成果。
4. 首轮产生的 Site Cleaning Profile 能在下一轮去噪，又不替代 Codex 语义和图片处理。
5. 每个变体转换为独立产品，SKU、外部身份与家族关系满足已确认规则。
6. `needs_review` 证据持续保留，成功或放弃任务会完整清理原始与中间文件。
7. Mac mini 管理页可查看进度、异常、证据和审核动作。
8. 首批 3 个结构不同的网站通过强制人工验收后，自动入库才能开启。
