# V3 独立 Worker 入口

2026-09-07 [GNC 产品接线](GNC_PRODUCT.md)：独立 product-input/父 Workflow、独立 gnc-file 下载角色；页面与逐张图片处理并发，再汇合保存。图片从已核验计划解析精确URL，私有产品授权绑定域名/期限/凭据和原网络出口，支持 direct/static-proxy，无隐式直连。Saved latest saved-product-v3 / mixed-product-v5。已通过独立进程+本机代理/TLS整链，未部署或验真实站点；Web/API授权分发仍待实现。PDF 暂停。

2026-09-07 新增 [GNC 独立 Worker 与编排](GNC_WORKER.md)：catalog、product、receipt、workflow 四角色独立启动，本机 Temporal/PG/HTTPS 模拟服务验证下游缺席释放采集槽位、空缓存恢复不重抓、原HTML及被动Review保留。使用 `build:gnc` / `test:gnc`，不构建 PDF 资产。尚未部署、接 Web/Brand 入口或下游页面/图片处理；PDF 继续暂停，下方 PDF 条目为历史记录。

2026-09-07 [SavedProductWorkflow](SAVED_PRODUCT_WORKFLOW.md) 已扩展明确页码的 PDF 文本来源，可与 HTML/图片独立推进、混合汇合保存。saved Workflow 最新 v2，混合 Activity 最新 v4；以下 v1/v2/v3 均为历史记录，不作为新任务部署配置。自动全页发现/媒体路由与网站 Adapter 尚未接入。

2026-09-07 新增 [PDF 单页直接文字入口](PDF_TEXT_WORKFLOW.md)：独立 PDF 提取、无引擎文本准备、Codex、只读回执四步。只完成单页文本登记；整份 PDF 混合产品清单和网站 Adapter 后续接入，未部署。

2026-09-07 新增 [已保存 HTML／图片入口](SAVED_PRODUCT_WORKFLOW.md)：独立 SavedProductWorkflow 逐来源准备、处理、汇合保存；未命中和失败保留原始清单，混合 Activity 队列升级 v3。使用合成文件完成隔离验证，不包含网站爬取 Adapter 或生产部署。

2026-09-07 [文本／图片混合链路](MIXED_PRODUCT_WORKER.md)已增加独立汇合、保存和父 Workflow 角色：来源并发推进，汇合 ready 后独立保存新库快照。Activity 混合队列 v2、Workflow 专属队列 v1，现有图片流程不变；009 迁移仅在临时库验证，未部署现有库或常驻 Worker。

最新[真实文本Worker联调](../../docs/plane/evidence/CRAWLV3-21/REAL_CHAIN.md)通过：真实Codex+R2、单合成样本、临时PG/本机Temporal，空缓存替换进程只读恢复无新执行。`scripts/live-text.ts`需显式单业务执行授权，不加入普通构建/测试。未常驻部署。

新增[独立文本 Worker](TEXT_WORKER.md)：`worker:text` 默认关闭，专属角色/队列及Codex Provider已装配。一次业务执行内部的模型轮次不计数；真实本机Temporal/临时PostgreSQL/独立进程链路已验证，Codex/S3为测试替身，不代表真实账号或生产部署。

最新[真实OCR/R2整链](../../docs/plane/evidence/CRAWLV3-20/REAL_CHAIN.md)已用业务入口通过3样本及空缓存换进程恢复；本机隔离Temporal和新临时业务库，未常驻部署。`scripts/live-ocr.ts`为显式授权验收入口，不随构建/普通测试发真实请求，失败不自动重跑。

2026-09-06：[业务OCR入口隔离验收](../../docs/plane/evidence/CRAWLV3-20/BUSINESS_WORKER.md)新增4项测试，真实临时PostgreSQL/Temporal、外部服务为回环模拟。独立结果/Review账号、换进程恢复与失败证据已验证，真实OCR/R2联调尚待配置和限定授权。

Plane `CRAWLV3-9` 落地共享运行/注册基础设施；[运行层](../../packages/v3-worker-runtime/README.md)在 `packages/v3-worker-runtime`，本工程只做部署组装和角色注册。

**默认业务注册表仍为空，未开放真实采集。** CRAWLV3-20 另增默认关闭的 `ocr-worker.ts` 独立业务入口及其 OCR 角色注册，真实提供商/R2/数据库联调仍待授权；不要把默认 worker.ts 当成 OCR 入口。25/36 负责产品/目录 Workflow，其余角色在各自任务中显式注册。旧 pilot 不自动变成业务实现，也未被本项修改。

## 构建与启动

```sh
pnpm --filter @crawl-automation/v3-workers build
node apps/v3-workers/dist/worker.js --list
pnpm --filter @crawl-automation/v3-workers worker
```

`--list` 当前返回 `[]`。普通启动需要 `V3_WORKER_ENABLED=true` 和绝对路径 `V3_WORKER_CONFIG`；配置中角色尚未注册会在任何连接或拉取前拒绝。普通构建仅输出业务入口，不打包测试 Workflow/Activity。SDK 原生库作为固定版本外部依赖，部署时须保留对应生产依赖。

配置结构示例（结构示例，不是可用 OCR；buildId 从已构建角色的 `--list` 取值）：

```json
{
  "role": "ocr-file",
  "capability": "ocr.file",
  "contractVersion": 1,
  "compatibility": "c1",
  "expectedBuildId": "<实际构建的64位sha256>",
  "hostId": "mac-mini-1",
  "namespace": "crawler-v3-test",
  "address": "<明确的Temporal域名>:<端口>",
  "transport": {
    "mode": "mtls",
    "serverName": "<证书服务名>",
    "caFile": "/absolute/private/ca.pem",
    "certFile": "/absolute/private/client.pem",
    "keyFile": "/absolute/private/client-key.pem"
  },
  "concurrency": 1,
  "shutdownGraceMs": 10000,
  "shutdownForceMs": 20000,
  "startupTimeoutMs": 30000
}
```

Worker 主动连接 Temporal，不暴露公网接单端口；不读 Temporal 内部数据库。HTTP API、交接运行器、编排 Worker 和每个原子 Worker 各自独立进程。交接运行器的 `target.taskQueue` 必须取自相应已注册 Workflow 能力的元数据/规则；不能将业务入口指向 `RuntimeIsolationProbe`。本项未改变 V3 API 的接收关闭设置。

## 独立测试入口

```sh
pnpm --filter @crawl-automation/v3-workers test:integration
```

显式测试构建才生成 `.local/test-dist`：一个合成 Workflow 角色和一个 echo Activity 角色，共用同一运行层，按不同进程启动。测试配置必须为回环 Temporal、`default` namespace 和独立 `testSession`；不读取业务 DB、不调用模型、不切网络、不部署 Railway。

验收内容：业务构建无 Probe 且拒绝测试角色；错误构建指纹拒绝启动；无 Activity Worker 时任务仅排队；两个角色的真实 Temporal history identity/PID 不同；SIGTERM 先停接单，已开始的 Activity 完成后释放模块；新任务由替代实例领取；合成失败无自动重试；卡住 Activity 强退且不提前释放模块资源。测试服务结束后关闭，临时证据目录保留排查。

2026-09-05 最终验收：共享运行层 **14 单测**、Worker **3 个真实本地 Temporal 多进程场景**通过，两个新包类型检查/构建通过；原 V3 API 14 单测与 pilot 11 单测回归通过。独立进程证据：编排 PID `41352`、原子 PID `41353`、替代原子 PID `41354`；Workflow `runtime-probe-a6a1fdbd-1a26-452a-b234-58c776738cad`，Activity 返回执行 PID `41353`，模块在完成后释放、进程退出 0。证据文件 `/var/folders/8g/hb1c2xq156b15mbh1ljhkqs00000gn/T/v3-worker-runtime-CsT3He/worker-runtime-proof.json`；临时证据不是持久备份。强退场景单独验证退出 1、不释放仍可能使用的模块资源，不把它记作业务成功。

未在本项验收：真实业务流程、实际提供商、Windows/Mac mini 实机、云端长期运行、共享资源限额、原子业务 SIGKILL 关键副作用窗口及完整跨 Run 收口。后续 CRAWLV3-10 已验证[入口交接进程中断与保守隔离](../v3-api/RECOVERY.md)，不等同于原子业务 Worker 内部副作用恢复；不能把运行壳验收当成整个爬虫上线。
# 单文件 OCR 独立入口（CRAWLV3-20）

新增 `src/ocr-worker.ts` / `dist/ocr-worker.js`，通过独立 `RoleRegistry("business", [ocrRole])` 注册 OCR；
默认 `worker.ts` 空 registry 保持不变。业务入口默认关闭，私有配置/启用门禁、scope、构建 hash 与队列说明见
[v3-ocr README](../../packages/v3-ocr/README.md)。本地 mock/真实 Temporal 验证不等于真实 OCR/R2/数据库联调，尚未常驻部署。
