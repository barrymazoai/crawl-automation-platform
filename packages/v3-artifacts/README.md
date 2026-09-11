# V3 artifact storage

CRAWLV3-15：真实 R2 对象读写 9 项验收通过，4 个合成对象保留于 supply-smart-test 的独立测试前缀。生命周期读取 403，但用户随后确认无自定义删除规则、仅默认未完成分片清理；采用用户确认，不冒称 API 已验。不是生产上线，也没有把 P0 本地证据适配器切到真实 R2。[真实验收记录](../../docs/plane/evidence/CRAWLV3-15/REAL_R2.md)。

独立 Node 包：只负责字节读取、校验、保留与远端持久化，不负责 OCR、任务队列、操作登记或 Temporal 调度。contracts 仍只定义传输格式，Node 文件系统/AWS SDK 不进入共享契约或 Workflow。

## 分工与调用

- LocalCopies / ObjectStore：窄端口；无 delete、list、覆盖、隐式重试接口。
- FileCopies：部署注入私有绝对目录，按 SHA-256 定位本地副本。不接收上游绝对路径，不按主机名判断可见性。
- R2Objects：固定 endpoint/bucket/prefix，每次按稳定 objectKey 发起新的 SigV4 请求；不保存临时签名 URL。
- ArtifactResolver.resolve(ref, owner, signal)：先校验观察/来源/挂牌/变体归属；本地可见且 hash/长度/媒体签名通过则直接返回，否则读取远端并校验。远端有效但缓存保存失败时返回 cacheRetained=false，不覆盖损坏缓存。
- ArtifactResolver.publish(ref, owner, bytes, signal)：验证字节 → 保留本地 → 条件 PUT → 远端回读核验。远端响应丢失，只做一次只读核验；不能确认就 UPLOAD_UNKNOWN，不重复 PUT、更不重新 OCR。

应用组装时显式注入：

```ts
const local = await FileCopies.open(privateCacheDirectory);
const { store, close } = createR2Objects(scope, credentials);
const artifacts = new ArtifactResolver(local, store);
// await artifacts.resolve(ref, observation, abortSignal);
// await artifacts.publish(ref, observation, bytes, abortSignal);
// close() 只释放 SDK 客户端，不删文件/对象。
```

scope 包含 endpoint（仅 Cloudflare R2 HTTPS）、bucket、专用 prefix、timeoutMs；代码会在所有 objectKey 前强制加 prefix，并验证总键长度。credentials 必须由启动层注入，工厂不读取环境、AWS 默认凭据链或旧项目配置。任务中只有稳定引用，无密钥。另有显式 opt-in 的验收脚本，必须指定配置文件，不自动探测凭据或随普通测试上传。

本包私有源码导出供 workspace:* 使用，运行 JS 构建内联契约，声明文件仍引用共享类型包；不复制 ArtifactRef。不能把 Node 包导入浏览器/Workflow。

## 保留与冲突

上传使用 If-None-Match: *，同键已存在时只回读，不覆盖。已有字节与 ref 不一致为 KEY_CONFLICT，原对象和本地候选均保留。SDK maximum attempts=1（配置 maxAttempts:1）；未知写入不会触发内部重试。远端回读成功才返回 durable:true；这仅是对象写入/回读证据，不表示数据库结果已登记、Temporal 已完成或产品入库。

本地副本先写独立 staging 文件并 sync，再排他硬链接发布；已存在副本必须通过校验。只有发布已确认，才移除本次 staging 链接；未完成的 staging 保留。没有原件、派生结果、完成清单的成功清理功能，不自动淘汰缓存。损坏副本也不覆盖；人工修复/回收属后续明确操作。

本地目录必须是当前用户/运行环境控制的私有目录，拒绝最终缓存文件的符号链接和非普通文件。目录祖先不能被不可信进程替换；不声称抵抗恶意同权限进程的文件系统竞态。fsync + 硬链接不是跨机器事务或断电灾备保证，保留远端核验边界。

## 限额、取消和格式

默认每文件 32 MiB，可在组装时调整。先限制分配，再按实际流大小读取；SDK 请求与响应流均有超时/取消处理，超限或超时关闭响应流。当前返回内存 bytes，Worker 并发必须考虑此上限；大文件分片/流式磁盘处理未实现。

SHA-256 与长度精确校验。PNG/JPEG/WebP/PDF 仅检查容器签名，UTF-8 使用 fatal 解码，JSON 额外检查语法；这不是完整媒体解码、安全扫描、PDF 页数或图片可识别性验收。后续文件/PDF/模型模块还要做各自语义验证。完成清单作为 JSON artifact 保留，清单字段语义和业务登记由后续完成交接模块校验。

错误码区分 MISSING、INTEGRITY、MEDIA_TYPE、TOO_LARGE、UNAVAILABLE、UPLOAD_UNKNOWN、KEY_CONFLICT、CACHE_UNAVAILABLE、SCOPE。R2 错误不泄露 SDK 原始签名/授权消息。只有 NoSuchKey 是缺对象，桶不存在和授权错误均为不可用。取消时不返回伪成功；可能发生的远端写入仍应先核验，本地副本保留。

## R2 实际验收门槛

本地测试不能代替真实 R2：需确认独立 bucket 或专用 prefix、凭证的本地配置位置、允许写入并保留的少量 fixture。还需检查该范围没有导致证据过期删除的 lifecycle。应用的 prefix 校验不能代替云端 IAM，最好使用只限测试桶的专用凭证。

官方 [S3 兼容表](https://developers.cloudflare.com/r2/api/s3/api/)列出 PutObject 条件写入支持；[生命周期说明](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)说明对象可能受删除规则影响。真实验收时应再次核对，不擅自修改 bucket 生命周期或 IAM。

真实条件写入、同键冲突、隔离运行目录远端读取、原件/派生/清单结束后回读已通过。2026-09-07 补齐 Mac mini 宿主机与 Linux Docker 容器真实边界：有效签名 200、过期签名 403、稳定键读取同一原图成功，容器看不到宿主机缓存；无 PUT/删除。生命周期采用用户确认，非 API 核验。跨 Windows 节点仍由部署任务验收。[收尾记录](../../docs/quality/2026-09-07-r2-closeout.md)。

### 显式真实验收入口

本工作区配置位置（2026-09-06补齐）：`/Users/songtianjian/Documents/browser-scaperskill/.automation-state/secrets/.env.r2`。使用用户此前提供的配置，文件权限0600、私有目录0700、Git忽略；已通过配置解析和一次HeadBucket（200，无上传）。后续本机验收显式传此路径，不再重复向用户索取配置。dotenv文件不是已注入所有进程的环境变量；没有修改全局Shell或自动启动Worker。若密钥轮换，更新该私有文件，勿写入文档/日志。

用户于 2026-09-06 授权并提供 supply-smart-test 配置。实际 HeadBucket 返回 200，GetBucketLifecycleConfiguration 返回 403 AccessDenied；以单独的对象检查模式执行了真实验证。保留策略随后由用户确认，脚本的 API 验证状态仍保持未验证，不伪造通过。

配置文件使用 dotenv 格式，接受完整的 S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY，或对应的 CLOUDFLARE_R2_* 字段（REGION 若指定必须为 auto）。拒绝两套字段混用，防止 endpoint 与密钥跨配置拼接。只解析，不 source、不执行 shell，不回退到其他凭据，不把内容打印或写入报告。命令中的路径仅为示例，需换成用户提供的绝对路径。

```sh
pnpm --filter @crawl-automation/v3-artifacts test:live-harness
pnpm --filter @crawl-automation/v3-artifacts r2:preflight /absolute/path/to/r2.env
pnpm --filter @crawl-automation/v3-artifacts r2:verify /absolute/path/to/r2.env
# 只验对象，不视为长期保留通过；仅在明确选择时容许生命周期 AccessDenied/403
pnpm --filter @crawl-automation/v3-artifacts r2:objects /absolute/path/to/r2.env
```

preflight 只读生命周期，不上传；无权限核验或存在可能匹配的到期删除规则就停止，不改变策略。verify 重新预检，在 crawlv3-acceptance/<随机 UUID>/ 下条件写入四个小型合成对象并保留。另行显式选择的 objects 模式仅容许生命周期 AccessDenied/403，不容许签名错误、超时、其他错误或已知到期规则；成功状态为 object-checks-passed-retention-unverified，不是完整 passed。9 个步骤覆盖上传回读、重复、冲突、真实 PUT 后人为丢回执、两个独立本地 Node 进程、坏缓存、缺失键及新客户端最终回读。故障注入不冒充真实网络断线；两个进程不冒充跨机器或容器部署。

脚本先记录计划对象键，再上传；脱敏 report.json 和缓存保留于 v3-artifact-live-* 临时目录。退出失败也不清理对象；可依据报告只读核验未知上传。本脚本没有对象列表/删除或桶策略写入，不修改业务配置。错误只输出稳定错误码及本脚本行号。配置/生命周期与真实 SDK 凭证隔离的 9 项离线测试通过，真实对象检查也已通过 9 项。修复了预检 SDK 向凭证附加内部 $source 字段导致后续严格工厂拒绝的问题；预检使用独立副本。

## 测试

```sh
pnpm --filter @crawl-automation/v3-artifacts test
pnpm --filter @crawl-automation/v3-artifacts test:integration
pnpm --filter @crawl-automation/v3-artifacts build
pnpm exec tsc --noEmit --skipLibCheck false --moduleResolution bundler --module esnext --target es2023 packages/v3-artifacts/dist/index.d.ts
```

26 个单元/模拟传输测试与 2 个独立 Node 进程测试。SDK 测试使用假密钥和自定义内存传输，完全不联网；跨进程不可见目录场景的远端同样是 fake，不是跨机器/R2 已验收。临时文件保留在 v3-artifact-* 目录，子进程正常退出。[任务记录](../../docs/plane/evidence/CRAWLV3-15/README.md)。
