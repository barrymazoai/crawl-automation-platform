# 2026-09-15 吞吐改造：ScraperAPI 抓取、OCR 云端模式、配方只提一次、补齐步骤

状态：代码与候选构建已在 mini 上验证通过，**尚未部署**。mini 主舰队与 batch 监控自 15:50 起停机（用户经 Codex 全停），由用户执行部署。

## 改了什么（只动 Amazon 一组，其他渠道不动）

1. **Amazon 抓取 adapter**：`capture.mode = "scraperapi"`（静态 HTML，`country_code=us`，5 credits/页），大图直连 `m.media-amazon.com`（`egressId direct/1`）。准入车道换成新资源 `scraperapi-lane`（容量 40，ScraperAPI 上限 50，留余量给重试）。`deliveryPostalCode` 必须删掉（已验证美国各邮编价格一致）。浏览器配置保留，仅目录页/回退用。
2. **OCR 通用队列 + 云端模式**：`ocrFile` 仍是一个队列。mini 的 OCR worker（本地模式，连库，调本地 Windows OCR 192.168.0.6:8081，4 路）与美国 Windows 的 OCR worker（云端模式，无 `database`，只写 R2，返回 `uploaded`，本机 OCR 127.0.0.1:8081，6 路）同时轮询；mini 回执 `resolveOcrReceipt` 对 `uploaded` 走 `registerFromRemote` 重建登记。`windows-ocr` 容量 2→10。文字/图片解析同样支持云端模式（`v3-text`/`v3-vision` 的 `uploaded`），两台 Windows 各跑 text/vision worker。
3. **模型并发**：ledger `mini-model-account` 2→14、`mini-cpu` 2→14（mini 4 + 美国 4 + 本地 6）。mini 进程并发：text 4、vision 4、collection 2（collection 现在也跑补齐）。
4. **配方只提一次**：产品工作流规划后先 `inspectExistingFormula`；已有当前结构（codec /3 /4）配方就跳过大图、OCR、模型，直接 `reusedFormula:true` 并只做补齐。8 月旧结构 24,646 份不算。
5. **补齐步骤** `enrichProduct`：collection 角色上的一次文字模型调用，产出统一名/基础名/剂型/规格属性/健康功能；幂等键 sha256([listingId, 配方内容哈希, `product-enrichment/1`])，已有记录直接复用。新表 `product_enrichment`（迁移 020，追加式、禁改禁删）。证据在 R2 `v3/product-enrichment/<id>.json`。
6. **稳态修复**（前一轮崩溃 review 的结论）：资源等待退避 10s/30s/60s 且不再被 `until` 截断；批次控制活动长重试（6h）并支持 `maxInFlight` 并发块；品牌根轮询退避；业务错误映射为不可重试。

Temporal 变更全部用 `patched()` 标记：`resource-wait-backoff-v1`、`batch-control-retry-v1`、`batch-concurrent-chunks-v1`、`brand-inspect-retry-v1`、`amazon-formula-once-v1`、`product-enrichment-v1`。26 份历史回放通过。

## 验证记录（mini，候选目录 `~/apps/crawlv3-history-20260913/ocr-cloud-20260915/candidate`）

| 项目 | 结果 |
| --- | --- |
| 候选全套 vitest（19 个套件，含 4 个 fixture 套件与 3 个 Temporal 集成套件） | 241/241 通过，`test-results-20260915b.json` |
| 历史回放（`replay-ocr-cloud.mjs`） | 26/26，bundle `12270fcf…` |
| 批次并发集成测试（真实 Temporal） | 2/2 |
| 只读预演 `apply-throughput-rollout.mjs --check` | 通过：31 个 job、迁移 020 待应用、配置与两份 manifest 均过 schema |
| Windows 云端 release `dist/cloud-workers` | BUILD_ID `dcf01efc…`，已同步到 `…/ocr-cloud-20260915/cloud-release/` |

## 部署顺序（用户执行，均在 mini）

前提：主舰队与 batch 监控均 `monitor-stopped`，`launchctl list` 无 `com.crawlv3` 项（脚本会校验）。

1. `cd ~/apps/crawlv3-history-20260913/ocr-cloud-20260915 && node apply-throughput-rollout.mjs`
   - 应用迁移 020；复制候选到 `~/apps/crawlv3-batch-a.UiA4dx/release-throughput-20260915/{label,workflow,plan,amazon,batch}`；生成 `private/amazon-scraperapi.private.json`（key 从 `private/scraperapi.key` 读）；改写主 manifest 29 个 Amazon job 与 batch manifest 2 个 job；改 ledger 容量并新增 `scraperapi-lane`；每个改绑 worker 先在一次性 queueScope 上预启动到 `WORKER_RUNNING`。收据在 `rollout/receipt.json`。
   - 资源容量/资源列表变了 = 拓扑变更，所以必须整队重启，而不是单个 restart。
2. 启动监控（与 Codex 停机时相反的操作）：
   ```
   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.crawlv3.m.fd3cd8cdbc9ad96e.plist   # 主舰队 90 个 job
   launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.crawlv3.m.e63308fcc11e0470.plist   # batch 监控 2 个 job
   ```
   看 `~/apps/crawlv3-batch-a.UiA4dx/status.json` 全部 ready，ledger 里 `scraperapi-lane` / `mini-model-account` 等被监控接管（controller 非空、healthy）。
3. 生成两台 Windows 的 worker 配置包：`node prepare-cloud-workers.mjs cloud-release cloud-sets`（美国：ocr 6 + text 2 + vision 2；本地：text 3 + vision 3）。把 `cloud-sets/us`、`cloud-sets/local` 各自发过去，按 `release/README.md` 起进程；路径占位符（`D:\crawlv3-cloud\…`）由对方填。成了的判据：Temporal 对应队列出现 `us-amazon-*` / `local-amazon-*` 开头的 poller。
4. 单个测试：`node submit-throughput-one.mjs [ASIN]`，看 `EVIDENCE` 行：`captureVia.mode=http`、OCR `byHost` 与 `outcomes`（mini 是 `registered`，Windows 是 `uploaded`）、`receipts` 全 `registered`、`reusedFormula` 或 `collectedProducts>0`、`enrich.rowsAfter>rowsBefore`、`heldPermits=0`。同一 ASIN 再提交一次应见 `reusedFormula:true` 且 `enrich.calls` 结果 `reused:true`。
5. 批量：新的活动 `maxInFlight` 只对新启动的 campaign 生效（现有 run 的输入没有该字段，默认 1）。启动新 campaign 时在输入里带 `maxInFlight`（≤10），`cursor` 取当前已结算游标。

## 待用户拍板 / 已知边界

- `windows-ocr` 的健康探针仍只看本地 Windows OCR 的 `/health`；美国 OCR 是否在线只能从 Temporal poller 看。
- `mini-cpu` 与模型账号同为 14：ledger 不区分机器，mini 上理论上最多可同时起 text 4 + vision 4 + collection 2 个 Codex。
- `amazon-batch-control` 的依赖健康检查仍看 `mini-ego-space-1`（未改）。
- `apply-mini-capacities.mjs`、`deploy-ocr-cloud.mjs` 是早先的分步/预演脚本，已被 `apply-throughput-rollout.mjs` 取代。
- Codex 会话存储：mini `~/.codex` 1.9 GB（`state_5.sqlite` 911 MB、`logs_2.sqlite` 272 MB、sessions 185 MB）；Windows 配置里 `codexHome` 已指到 D 盘。
