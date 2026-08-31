# 并行化改造隐患解决方案

对应 `PARALLEL_CRAWL_PIPELINE_PLAN.md` §17 隐患清单，逐条给出解决方案。
每条按"现在的问题 → 怎么解决 → 为什么能行 → 实现要点"组织。
隐患 1（completeCrawlRun 下架触发器）已由计划 6.4 节的 run 级一次入库方案解决，此处不再重复。

## 方案 2：解除"一颗老鼠屎坏一锅粥"的全局锁

**现在的问题**：队列里每个小任务（job）都属于一个大任务（run，如"抓品牌 A"）。现在的规则是：run 里任何一个 job 进人工审核，整个 run 被打上 `needs_review` 标签，其他所有 job 立刻停发（`repository.ts:206` 的 claim 过滤 + `repository.ts:274` 的 run 状态回写）。品牌 A 拆成几十个并行 job 后，一个产品 OCR 失败就会冻住整个品牌的所有处理线——并行化白做。

**怎么解决**：发任务的判断从"看整个 run 的标签"改成"只看 job 自己的状态 + 依赖"。run 状态降级为纯展示字段，不再有拦截功能。

**为什么能行（出了问题谁来拦？）**：靠任务依赖关系拦，不靠全局标签。`cleanup_run` 依赖 `ingest_staging` 完成，入库依赖前面所有处理完成；出问题的 job 永远不算"完成"，依赖判定（`repository.ts:207`）自动挡住下游——该停的下游自动停（证据文件自然保留），不该停的兄弟 job 照常跑。想手动叫停整个品牌，仍有 abandon 总开关。

**实现要点**：

1. claim SQL 一行改动：

   ```sql
   -- 旧
   and r.status not in ('needs_review','failed','completed','abandoned')
   -- 新
   and r.status <> 'abandoned'
   ```

2. `fail()` / `complete()` 不再把 run 状态写成 `needs_review` / `retry_wait`（`repository.ts:274, 279`）；只维护 `open_review_count`。run 展示状态在 `summary()` 里从 job 聚合派生（全 completed → completed；有 open review → running_with_reviews；否则 running/queued）。
3. `resolveReview` 逻辑不变；abandon 仍是唯一全局停止手段。
4. 无 schema 迁移（status 是 text 列）；更新 `repository.test.ts` 断言。

**验收**：人为让一个 `process_text` job 进 `needs_review`，同 run 其他 Batch 的 job 仍可被领取并完成；`cleanup_run` 保持阻塞直到 review 解决。

## 方案 3：一个产品有问题，别拖累整个品牌

**现在的问题**：管线里有个"黑名单"数组（`blocking`，`gnc/pipeline.ts:233-236`、`amazon/pipeline.ts:727-735`）——处理品牌 A 的 300 个产品时，哪怕只有 1 个产品域名解析失败，黑名单非空，300 个产品全都不入库，整个品牌卡死等人工。

**怎么解决**：黑名单改"隔离区"（`quarantined: {product, reasonCode}[]`）。有问题的产品单独挪进隔离区、记原因、进 Review Queue；其余 299 个照常入库。

**为什么能行 + 关键安全细节**：品牌声明"抓全了"（`scope: "full"`）时，数据库会把本次没观测到的商品判定下架。如果 299 个入库、1 个被隔离，还声明 full，**被隔离的产品会被当成"没看到"而误判下架**。所以铁律：**有产品被隔离 → 该 run 自动降级 `partial`**——partial 永远不触发下架。而且这个降级零新逻辑：`decideSalesChannelScope`（`sales-channel-scope.ts:31-33`）已有"processedCount < discoveredCount → partial"规则，把隔离产品从 processedCount 扣除即可。宁可这次不做下架判断，也不能误下架。

**实现要点**：

1. normalize 循环里产品级失败（域名解析、Unify 不完整、Facts 缺失）不再中止，移入 `quarantined`，其余继续。
2. Batch 汇总时：隔离产品写 `review/quarantine.json` 并逐产品建 review 记录；正常产品进 run 级暂存等待入库。
3. 隔离产品人工处理后，用新 runId 以 `partial` scope 补入库（partial 不触发下架，安全）。
4. 只有 run 级致命错误（挑战页、目录为空、渠道身份无法确认）仍走整 run `needs_review`。

**验收**：注入 1 个域名解析失败的产品，其余产品正常入库、run scope 为 `partial`、该产品在 Review Queue，无任何 listing 被下架。

## 方案 4：Pool 进程模型与并发上限

**现在的问题**：三个写死的约束让计划 §11 的并发表填不进现有系统——`NODE_MAX_CONCURRENCY` zod 上限 2（`mac-worker.ts:45`，服务端二次校验）；`CODEX_CONCURRENCY` 进程内全局信号量、上限 4（`mac-worker.ts:130`）；GNC egress 守卫强制单槽专用 worker（`mac-worker.ts:138-140`）。

**怎么解决**：一个 Pool = 一个独立进程，各自注册 capability、各自配并发；Codex 账号级限流用静态预算切分。

**实现要点**：

1. 通用 worker 入口按 env 装配。zod 上限从 2 放宽到 16（服务端注册上限本就是 16，`node-api.ts`）。
2. **Codex/Luna 限流是账号级、跨进程的**。第一版静态切分：Text 进程 `CODEX_CONCURRENCY=10`、Unify 2、Image 2（视觉补救用），总和 ≤ 账号实测限流；`CODEX_CONCURRENCY` zod 上限放宽到 16。中央 token-bucket 留作后续，第一版不做。
3. launchd 每 Pool 一个 plist + 各自 `.env`：

   ```text
   com.supplysmart.crawl-capture-gnc      NODE_CAPABILITIES=gnc            并发 1（egress 守卫兼容：本就是纯 capture 单槽）
   com.supplysmart.crawl-capture-amazon   NODE_CAPABILITIES=amazon         并发 1
   com.supplysmart.crawl-capture-swanson  NODE_CAPABILITIES=swanson        并发 1
   com.supplysmart.crawl-text             NODE_CAPABILITIES=process_text   并发 10
   com.supplysmart.crawl-image            NODE_CAPABILITIES=process_images job 并发 2~4；OCR_IMAGE_CONCURRENCY=4 为进程级全局信号量
   com.supplysmart.crawl-unify            NODE_CAPABILITIES=product_join,product_unify  并发 2
   com.supplysmart.crawl-finalize         NODE_CAPABILITIES=catalog_finalize,ingest_staging,cleanup_run  并发 1
   ```

4. **并发分两层，限流资源用进程级全局信号量**：job 级并发（同时几个 Batch 在流水线）与资源级并发（同时几个 OCR / Codex 调用）分开配置。Image Pool 允许多 Batch 交错——Batch N 在 OCR 时 Batch N+1 在下载图片，OCR 的 4 个槽位始终打满；实际 OCR 并发由 `OCR_IMAGE_CONCURRENCY` 全局信号量兜底（沿用现有默认 4，`mac-worker.ts:46`），OCR 服务吞吐提升时只改这一个值，不影响其他线。
5. capability 三处同步修改（阶段 1 一次改齐）：`packages/contracts/src/index.ts:3-5` zod enum、`config.ts:28-29` token→capability 映射、`mac-worker.ts:30` worker schema。DB 列为 text，无迁移。
6. GNC egress 守卫保留不动——新架构下 GNC worker 只做 capture、单槽，守卫条件自然满足。

## 方案 5：断点续跑改成"认任务状态"，不再"认文件在不在"

**现在的问题**：worker 重启后能接着跑，靠的是土办法——每步跑完存个 JSON，重跑时发现文件已存在就跳过（captured/label/ocr/semantic/unify 各级缓存）。`LocalCheckpointStore` 只写不读，是摆设（`packages/runtime/src/index.ts:49-101`）。今天"整 run 结束才删文件"所以没事；新架构里任何提前清理都会让重试的任务以为自己没干过，把昂贵的 OCR、模型调用全部重跑，甚至跑出不一致结果。

**怎么解决**：恢复的最小单位定为一个 job。job 干完活、产出全部写好后，原子放一个"完工牌"（ready 标记，tmp→rename + 防覆盖守卫，泛化 `publish-capture-batch.mjs` 的现成模式）；重启后重新领到该 job 的 worker 先看完工牌——有且 fingerprint 一致 → 直接 complete 收工（幂等键 `complete:<jobId>` 已存在）；没有 → 整 job 从头干。

**为什么能行**：以前是"看灶台上有没有剩菜判断做没做过饭"，现在是"看墙上有没有挂完工牌"。剩菜可能被人收走；完工牌只在整个 run 彻底结束、所有 job 已终态、没人再需要恢复时才随 run 目录一起删（`cleanup_run` 是唯一删除点）。job 内部的细粒度缓存（如逐商品 OCR sidecar）保留为同一 attempt 内的加速优化，但正确性不得依赖它。

**实现要点**：输出目录 `runs/<channel>/<runId>/<stage>/<batchId>/` + `<stage>.ready.json`；`LocalCheckpointStore` 裁剪——删除无人读的 checkpoint/outbox 表，仅保留 Windows 端在用的 `codex_session`。

## 方案 6：磁盘背压——别把 Mac mini 硬盘塞满

**现在的问题**：抓取产生文件的速度远快于处理消化的速度，而全仓库没有任何磁盘检查代码（无 statfs/free-space 逻辑），是 100% 从零建设。

**怎么解决**：只在抓取 worker 里装一个"油表"（`disk-guard.ts`，用 Node `fs.statfs(WORK_ROOT)`），两条刻度线：

- **软线** `DISK_SOFT_MIN_FREE_GB`（建议 40）：不再领新品牌（不 claim 新 `capture_catalog`），手头品牌抓完收尾——温和减速。
- **硬线** `DISK_HARD_MIN_FREE_GB`（建议 15）：连当前 Batch 也暂停发布，抓取循环原地等待——急刹车。

**为什么油表只装抓取线**：处理线、入库线、清理线干活就是在释放磁盘空间，它们越跑硬盘越空；给它们装阈值等于自己锁死自己。

**实现要点**：背压状态经 worker 心跳上报控制面 → 网页 Disk 面板（计划 §12）；日志打明确的 `disk_backpressure_soft/hard` 事件。

## 方案 7：吞吐指标——先别建新系统，现成数据够用

**要解决的问题**：验收标准 12 要求看出真实瓶颈在哪条线（抓取慢、OCR 慢还是模型慢）。

**怎么解决**：不新建指标上报系统。`pipeline_job` 表本来就记着每个 job 的创建、领取、完成时间戳，`summary()` 直接加按 `stage × channel` 的聚合 SQL：最近 1h/24h 完成数、平均耗时、当前 queued/leased/needs_review 数。网页流水线视图消费该聚合即可。

**后续再说的**：单产品耗时、模型 token 用量等细指标，需要时经心跳 extras 上报，第一版不做。

## 方案 8：DTC 转换——Windows 那边一行代码不动

**现在的问题**：计划以为 DTC 已在用标准契约（`EvidenceBundleV1`）传数据，实际契约只是声明了没用上——Windows 端发的是三字段描述符 `{ordinal, itemCount, evidenceDirectory}` + zip 包（`publish-capture-batch.mjs:34-40`）。

**怎么解决**：不改 Windows 端，传输链路（描述符 + zip + Artifact/S3 + sha256 校验）保持原样。Mac 端下载解包后加一个"翻译器"（`dtc-capture-converter`）：把 evidence 目录（页面快照、图片、Codex 抽取结果）翻译成 `CapturedProductBatchV1`，作为 DTC 的 `capture_batch_finalize` job 输出发布 ready 标记。翻译之后 DTC 与 Sales Channel 数据长得一模一样，走完全相同的处理线。

**实现要点**：DTC 天生缺的字段（rating、unitsSold 等）在契约里全部 optional，翻译器有啥填啥。

## 方案 9：下架保险丝——迁移期物理上杜绝误下架

**要防的事**：如果网站分页静默少展示商品而抓取端没察觉，系统会以为"抓全了"（`exhausted=true`、数量对得上），scope 判成 full，漏掉的商品被误判下架——现有防线全建立在"抓取端知道自己抓漏了"的前提上，这种情况客户端无解。

**三层保险**：

1. **迁移期总开关（核心，必须做）**：新增 env `FORCE_PARTIAL_SCOPE=1`，置位时 `buildObservationPayload` 无条件降级 `partial`。阶段 2～5 全程开启——新流程调试期间**物理上不可能发生任何下架**，怎么折腾都安全。阶段 6 验收通过后才关闭。
2. **服务端保险丝（提需求，不阻塞开工）**：`completeCrawlRun` 支持 `maxDeactivateCount` / 比例阈值，超限时不执行下架、返回 `deactivation_blocked` 转人工确认。此变更在 Product Server，不在本仓库。
3. **让下架看得见**：每次入库返回的 `deactivated` / `deactivatedListingIds` 现在只存 run 目录、清理后就没了；改为持久化到控制面数据库、网页展示每次 full run 的下架数。异常肉眼可见，而不是几周后才察觉。

## 方案 10：幂等键——一个防重复机制的小漏洞

**现在的漏洞**：抓取完成的幂等键是 `capture:<jobId>:<itemCount>`（`browser-node/src/index.ts:164`）——键里嵌了会变的商品数量。重试时如果数量变了（比如网络抖动少抓 2 个），键就变了，系统当成全新请求放行：防重复机制被绕过，还掩盖了"两次抓取结果不一致"这个本该报警的问题。

**怎么解决**：键只用稳定标识——`capture:<jobId>:<batchId>`；`itemCount`、文件哈希放进 fingerprint。重试内容一致 → 正常幂等返回；不一致 → 按设计抛 fingerprint 冲突（`repository.ts:51`），把问题暴露出来而不是吞掉。

## 实施顺序（并入计划 §13）

| 阶段 | 本文档方案 |
| --- | --- |
| 阶段 1 | 方案 2（run 状态解耦）、方案 4 的 capability 三处修改与 zod 放宽、方案 10 |
| 阶段 2（GNC） | 方案 3（quarantine + scope 降级）、方案 5（job 级 checkpoint）、方案 9 的 `FORCE_PARTIAL_SCOPE` |
| 阶段 3 | 方案 4 的 Pool 进程与 launchd、方案 6（disk-guard）、方案 7（指标） |
| 阶段 4 | 方案 8（DTC 转换器） |
| 阶段 6 | 关闭 `FORCE_PARTIAL_SCOPE`；跟进方案 9 的服务端阈值 |

一句话总览：**方案 2、3 保证局部出错不拖累全局；方案 5 保证重启不丢活也不重复干活；方案 6 保证抓太快不撑爆硬盘；方案 9 保证改造期绝不误下架**——这四组是安全网；方案 4 是并发落地的进程骨架；方案 7、8、10 是顺手修正。
