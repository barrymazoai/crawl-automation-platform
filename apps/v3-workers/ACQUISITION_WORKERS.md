# 独立文件下载与 OCR 输入准备 Worker

每个角色独立启动一个进程，经 Temporal 领自己的队列。没有互调 HTTP、共享进程对象或依赖上游本地路径。这里只交付代码和本机隔离验证，尚未部署常驻。

| role | capability / Activity | 队列 |
| --- | --- | --- |
| file-acquire | file.acquire / acquireSourceFile | v3.file.acquire.v1.acquisition-v1 |
| file-receipt | file.receipt / acquireSourceFile（只核验已获取文件） | v3.file.receipt.v1.acquisition-v1 |
| image-ocr-input | image.ocr-input / prepareImageOcr | v3.image.ocr-input.v1.acquisition-v1 |

共同入口：`pnpm --filter @crawl-automation/v3-workers worker:acquisition`。contractVersion=1、compatibility=acquisition-v1。先 build，再在私有配置已就绪时运行入口 `--list` 取得准确 buildId。配置只选一个 role，不会同时启动两个模块。

2026-09-09：新增不持有下载端口的 `file-receipt`，用于已保存来源计划的续接；不替换正常新采集的file-acquire/gnc-file。只读模块不PUT，不写Review；共用外壳仍需要现有配置和Review库启动检查。见 [GNC保存证据续接](GNC_SAVED_DOWNSTREAM.md)。

## 启动配置

共同开关 `V3_WORKER_ENABLED=true`、绝对路径 `V3_WORKER_CONFIG`，字段沿用统一 runtime：role/capability/contractVersion/compatibility/expectedBuildId/hostId/namespace/address/transport/concurrency/shutdownGraceMs/shutdownForceMs。远程 Temporal 使用已支持的 mTLS，不开放本机公网服务。

业务开关 `V3_ACQUISITION_LIVE_ENABLED=true`、绝对路径 `V3_ACQUISITION_CONFIG`。私有普通 JSON 文件最大 4 MiB，不接受符号链接，POSIX 权限 0600。字段：

- `cacheRoot`：本进程的原文件缓存绝对路径；同机可配置受信共用缓存，异机可空缓存启动。
- `journalRoot`：本进程完成/Review 证据绝对路径。保留原件和 journal，不自动删除。
- `r2`：endpoint/bucket/prefix/timeoutMs；`r2Credentials`：accessKeyId/secretAccessKey。使用受限前缀 GET/条件 PUT。不能在浏览器、任务载荷、日志或版本库暴露凭证。
- `reviewDatabase`：`{ connectionString, tls }`；专用账号仅 SELECT/INSERT 已有 `review_record`。不需要 collection/result DB 写权限；不自动迁移数据库。
- `sources`：仅下载角色必需，可为空数组用于只读完成证据复验；准备角色可以省略。每项 `{owner, resourceId, binding:{sessionId,egressId:"direct/1"}, url, allowedOrigins, expiresAt}`，owner 是完整 Observation。URL 与白名单保存在私有配置，不进入 Temporal。

静态来源适配仅公开 HTTPS/显式直连，无 Cookie 或登录会话管理。sessionId 在此只是固定绑定标识，不声称拿到了浏览器登录态。URL 必须符合逐跳公网 DNS/TLS/目标白名单约束，过期失败关闭；不读取代理环境变量或切 Clash，主机 TUN/路由仍可能生效。未来浏览器/代理/ScraperAPI 来源须实现各自 SourceAccess/transport，不能换个 egressId 冒充。

## 处理及交接

下载 Worker：先条件创建远端不可覆盖执行标记，确认是本次创建才请求来源一次。检查媒体/大小/hash，保留原件，上传并核验，再写 `v3/acquisition/<operation>/completion.json`。完成状态为 durable，**不是** processing_result 登记或采集入库。

准备 Worker：只核验完成证据、原文件关联及 SHA-256，构造单文件 OCR 输入并发布不可覆盖任务证据。不重新下载、缩放、压缩或识别图片。PDF 返回 `IMAGE.PDF_ROUTE_REQUIRED`，交由未来独立 PDF 路径处理。

下载已完成但 Activity 回执丢失时，只读取证据即可恢复；没有可证明完成的证据则 Review，不自动抢占/清除执行标记。成功操作换空缓存节点复验无新来源请求/PUT；失败重投可条件 PUT 已有标记，但不重新下载/上传原件。Review 追加后必须同 ID 回读确认；JSONB 字段顺序变化不算证据变化，内容修改仍会拒绝。

Activity 仅尝试 1 次、心跳 2 秒。Worker 完成自身交接便释放；后续角色未上线时任务停在 Temporal 队列，不占下载 Worker。两角色故障/取消不触发浏览器切换或昂贵识别补偿。

由 [产品 Workflow](PRODUCT_WORKERS.md) 的 fileTasks 模式编排。HTML 整理、PDF 分页、Brand/渠道爬虫和网页触发全链尚未接入此路径。
# 页面角色补充（2026-09-07）

同一入口新增 page-prepare 与 page-text-input 两个可单独启动的角色，只处理已保存 HTML，不走下载器。页面队列 compatibility 为 page-v1；原文件下载/图片准备角色仍为 acquisition-v1。配置与边界见 [PAGE_WORKERS.md](PAGE_WORKERS.md)。
