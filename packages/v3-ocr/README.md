# V3 单文件 OCR

最新：[真实业务整链验收](../../docs/plane/evidence/CRAWLV3-20/REAL_CHAIN.md)已通过：3次真实OCR、实际R2原件/结果/清单/intent共12个对象、新临时PostgreSQL结果3行；换空缓存Worker后3项只读恢复无新OCR/PUT。使用本机隔离Temporal，未部署生产；本轮OCR请求未重叠，不能作为新版真实并发容量依据。下方保留之前各阶段说明，最新边界以上述报告为准。

CRAWLV3-20：[旧接口真实续验](../../docs/plane/evidence/CRAWLV3-20/LIVE_OCR.md)5次合成识别通过；本轮已补受信内网 HTTP、类型化 minScore 及完整 JSON 证据保留，并用5份已保存响应离线复验。[兼容验证](../../docs/plane/evidence/CRAWLV3-20/COMPATIBILITY.md)。本轮新增真实 OCR 请求为0；真实 V3 整链联调尚未完成，部署门禁不自动放开。
新包不依赖旧 `ocr-client`、批处理链或 PDF Python 环境。

## 已实现的职责

- `MultipartOcr`：一张图片字节 → 原始文字、lines/坐标/置信度及服务 JSON 元数据，不解释 Formula/Ingredients，不调用 Codex。
- `OcrIntents`：所有节点共用存储中的不可覆盖执行记录，不使用机器内存锁，不按时间释放执行权。
- `OcrFileModule`：契约/配置/归属检查，解析 ArtifactRef，单次 OCR，证据捕获/可靠上传/结果登记，失败被动 Review。
- `createOcrRole`：独立 Temporal Activity Worker 的工厂，注入连接和客户端；操作状态为局部变量。
- `apps/v3-workers/src/ocr-worker.ts`：独立业务启动入口，不混进默认空 registry，也没有打包测试 OCR 服务。

共享类型、执行记录、Activity 小型结果和 `ocrActivityOptions(queue)` 在 `v3-contracts`，可安全导入 Workflow。
Temporal `maximumAttempts=1`，Activity 还拒绝 `attempt > 1`。Heartbeat 每 2 秒发送，不包含图片/文字/凭证。

## 一次执行如何完成

1. 验证 OcrInput 的单文件、observation/source/listing/variant、指纹和消费者版本。PDF 页保留父 PDF 与页码。
2. 已有可靠登记则只读返回引用；已有本地完成证据但交接不足则转 Review，不重新 OCR。
3. ArtifactResolver 从可访问本地缓存或 R2 取字节并验证。
4. 对固定 `ocr-intents/<operationId>.json` 执行不可覆盖 create，并读回。
5. **只有明确收到 created 且读回自己 nonce 的当前调用**才能请求 OCR；exists、网络未知、内容冲突都不授予执行权。
6. 原始文字和完整解析后 JSON 封装为 OcrOutput v2，先 capture 本地证据，再上传原件/结果/清单并登记；全部核验后返回小型引用。
7. 出错只做一次只读结果核验；不能证明可靠登记时写被动 Review 并读回，不在异常分支补传/补登记/重新 OCR。

晚到的取消不丢弃已经收到的有效结果：capture 用独立 10 秒清理预算。Review 回执丢失只读核验，不重复 append。
Review 无法保存/核验时 Activity 非重试失败，不能谎报已进入 Review。
本步可靠交接后即可空出 OCR Worker，不等待下游产品工作；如果交接故障则保留证据、返回 Review，不占住 Worker 永久等待。

“响应未知”不会被解释为“没有执行”。关闭本地 HTTP 请求也不能证明远端停止识别。
claim 写入后 Worker 死亡、甚至尚未发请求，也不会自动解除；后续只能人工核验证据。
这提供防重复调用的保守约束，**不是 exactly-once 或自动事故恢复**。

## 存储约束

所有可能处理同一 operation 的节点必须连接同一个强一致、支持原子 create-if-absent 的存储 scope；
生产组合使用已实现的 R2Objects（If-None-Match: * / SDK maxAttempts=1）。不同桶/不同 prefix 不是同一把防重锁。
执行记录不能设置过期清理，否则未来重复投递可能重新执行；和原件/派生结果一样不随成功删除。
`storageId` 是共用逻辑存储身份，不是每台机器的名字；nodeId 单独记录。

R2 执行记录保存输入/nonce/nodeId/storageId/time，不存凭证。`failure.evidenceKey` 是 intent 的定位键；
在取文件或前置检查失败时对象可能尚未创建，不能仅凭这个键断言存在执行证据。
跨机器看不到旧节点本地完成文件时仍不会重新调用；当前没有自动定位/搬运另一台机器的本地清单。

显式人工批准的交接修复复用 `OcrResultHandoff.uploadMissing/register`，之后再次读取可成功返回；不能自动消费 Review。
来源原始文字在 OcrOutput，完整文件/产品/提供者关联在 OcrRegistration；Activity 历史不塞入图片或文字。

## HTTP Adapter 与旧客户端审计

当前只实现旧项目中自定义服务的 **multipart field `file` → JSON `{text, lines, ...metadata}`** 协议，不宣称兼容任意云厂商 SDK。
已有内网服务的协议与合成识别已实测，生产鉴权/内部重试仍须审计；`provider` 应明确部署/模型版本，不填漂移的“latest”。
固定服务 URL 是部署配置，任务不能带 URL、本机路径、脚本或文件数组。

审计 `packages/ocr-client/src/index.ts`：旧客户端默认 `retries ?? 1`，意味着最多两次请求；没有传递外部取消信号；
默认 fetch 会跟随重定向，并将所有 4xx 当作同类拒绝；旧 backend 的 shared/deps.ts 还显式配置 retries=2，最多三次请求。新系统没有复用这些行为，也没有修改旧客户端。

新 Adapter 使用 Node 原生 http/https.request：单次 POST、无重试循环、无 SDK 重试、无重定向跟随、agent=false；
HTTP 429/500、断流、超时、非法 JSON、空文字均不重发。只接受 200 JSON，不自动解压响应。
默认 45 秒（最大 60 秒）、输入 ≤16 MiB、响应 ≤8 MiB、最终接受的 OcrOutput JSON ≤1 MiB。
空文字为 OCR.EMPTY；正常文字不 trim、不改写。超限响应/输出被拒绝，不承诺保留越界完整内容。
Review 存放类型化错误事实，不把可能含 URL/凭证的底层网络异常原文写进日志/Temporal。

默认远程仅 HTTPS；allowLoopbackHttp 仅开放 127.0.0.1/[::1] 开发服务。
内网 HTTP 需 trustedHttpOrigin 精确匹配 endpoint 的协议/IP/端口，仅接受 RFC1918 IPv4 字面量，无域名/CIDR/全局放行。
endpoint 禁止用户名、密码、query 和 fragment；minScore 是单独的0–1数值选项，由 Adapter 生成唯一 min_score 查询参数并计入配置指纹。省略时不发送，使用服务默认值。可注入 Bearer token，token 不进入语义指纹；HTTP 无加密，跨不受信网络须 HTTPS/安全隧道。
不自动读取代理环境变量或切换 Clash；此自定义 OCR 服务的网络路线需部署明确配置。
这是字节/签名筛查，不是完整图片解码/解压炸弹防护；提供商也必须有限额和隔离。

`multipart-ocr/2` 固定输出 resultSchemaVersion=2：text 与 rawResponse.text 逐字一致；rawResponse 保留完整解析后 JSON，包括 lines 与服务返回的 request_id、模型、耗时、后端尝试等字段。不是 HTTP 原始字节存档，JSON 空白/键排版不承诺保留。
lines 必须存在（允许空数组，不伪造缺失行），最多20000行；score 为0–1有限数，polygon 如存在须为4个有限数坐标对，行顺序与文字不变；未知 JSON 字段保留在 rawResponse，不提升为业务身份。
这些元数据只表示服务自报，不作为调度、防重或内部重试已审计的依据。原始证据仅存结果/私有 Review，不塞进 Temporal 历史。
共享契约仍能验证 P0 的 v1 文本结果，但新模块只接 v2，版本参与输入指纹和完成凭证核验；旧文字结果不能充当新版完整证据。没有迁移或重投旧任务。

## 独立 Worker 配置

入口 `apps/v3-workers/dist/ocr-worker.js`。默认不启动，不自动读取旧 .env，不下载模型，不迁移数据库。

部署私有 JSON（POSIX 权限 0600，绝对路径；Windows 需等效 ACL）包含：

```json
{
  "provider": {"endpoint":"https://ocr.example.com/ocr","provider":"your-service/model-v1"},
  "bearerToken":"YOUR_SECRET",
  "storageId":"v3-evidence/1",
  "cacheRoot":"/absolute/private/ocr-cache",
  "journalRoot":"/absolute/private/ocr-journal",
  "r2":{"endpoint":"https://ACCOUNT_ID.r2.cloudflarestorage.com","bucket":"YOUR_BUCKET","prefix":"v3/evidence"},
  "r2Credentials":{"accessKeyId":"YOUR_KEY","secretAccessKey":"YOUR_SECRET"},
  "resultDatabase":{"connectionString":"postgresql://RESULT_ROLE:SECRET@HOST/NEW_V3_DB","tls":true},
  "reviewDatabase":{"connectionString":"postgresql://REVIEW_ROLE:SECRET@HOST/NEW_V3_DB","tls":true}
}
```

以上是不可直接使用的占位示例，不包含真实配置；bearerToken 无需时应省略。
已有内网 OCR 的 provider 配置可写为以下形式（不会因此自动发请求）：

```json
{
  "endpoint": "http://192.168.0.6:8081/ocr",
  "trustedHttpOrigin": "http://192.168.0.6:8081",
  "minScore": 0.3,
  "provider": "local-paddle/ppocr-v5-mobile-en"
}
```

这里 provider 标签是部署者声明，不是自动查询的模型指纹；模型/部署改变应更新标签。不要直接把带 `?min_score=0.3` 的旧 endpoint 原样放入新配置。
两个数据库客户端连接同一 V3 业务库但使用各自最小权限身份，不使用 Temporal 内部库。
启动只读检查 processing_result/review_record 列是否存在；不自动建库、迁移或授予权限。
源任务的 R2 scope 必须与采集/结果组件一致。

```sh
pnpm --filter @crawl-automation/v3-workers build
# 以下只有在配置、样本/调用授权及部署准入确认后使用。
V3_OCR_LIVE_ENABLED=true V3_OCR_CONFIG=/absolute/private/ocr.json node apps/v3-workers/dist/ocr-worker.js --list
```

`--list` 不连接 R2/数据库/OCR；给出真实 buildId、兼容队列标识。
将它们填入既有 V3_WORKER_CONFIG（role=ocr-file、capability=ocr.file、contractVersion=1）；compatibility 由提供商配置 hash 派生。
再配 V3_WORKER_ENABLED=true、V3_WORKER_CONFIG 绝对路径及上述 OCR 环境变量启动 `worker:ocr`。
云端 Temporal 使用原有 mTLS 配置，Worker 主动连出；移动整套部署不需要暴露本地 HTTP 入站。
dist 中所有 JS/chunks 必须一起部署，buildId 包含共同构建资产。

配置中的启用标志只是技术门禁，**不替代真实调用授权/预算**。本轮没有实际运行这个业务入口接远端资源。

## 验证与未验范围

新增[业务入口/真实PostgreSQL隔离验收](../../docs/plane/evidence/CRAWLV3-20/BUSINESS_WORKER.md)：直接运行构建后的业务入口，4项测试验证专用账号写结果/Review、换空缓存进程只读恢复、存储失败前后不重识别。S3/OCR仅回环协议模拟，不替代真实外部联调。

```sh
pnpm --filter @crawl-automation/v3-ocr test
pnpm --filter @crawl-automation/v3-ocr test:integration
pnpm --filter @crawl-automation/v3-workers test:integration
```

测试需监听回环端口；沙箱禁止时需单独允许，不能把被跳过场景记作通过。
HTTP 服务返回合成文字，不是真 OCR 识别；1px PNG 仅验证图片传输。Temporal 是真实本地 Server，OCR 是独立编译后的 Node 进程。
集成中的 R2/结果库/Review 用**测试专用共享磁盘适配器**，核心单测用内存存储；不冒称本轮真实 R2/PostgreSQL OCR 联调。
默认业务构建不包含这些测试存储或 Workflow。

尚待：新版 Worker 到真实 OCR/R2/业务数据库的整链验收、鉴权与服务内部重试审计、真实 R2 防重并发、
Windows/Linux 节点、网络隔离、进程硬中断/磁盘故障、生产常驻部署。当前只有正常退出/换进程恢复和模拟异常，不是完整灾备验收。

[验收证据](../../docs/plane/evidence/CRAWLV3-20/README.md)；
[Temporal Activity/Workflow 失败处理](https://docs.temporal.io/develop/typescript/workflows/timeouts)、
[Node HTTP 请求行为](https://nodejs.org/api/http.html#httprequestoptions-callback)。
