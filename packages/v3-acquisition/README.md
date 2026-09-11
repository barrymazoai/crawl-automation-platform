# 文件获取 / 页面整理 · V3-018

两个可独立组装的原子模块，位于共享 package，而非旧 Worker 或某一台电脑里。
核心实现不依赖 Temporal、具体数据库、浏览器控制、OCR/Codex 或最终产品校验。2026-09-06 已新增持久交接外壳与两个独立 Worker 角色，见下文。

| 模块 | 一次输入 | 输出 |
| --- | --- | --- |
| `acquireFile` | 一个 observation 下的 resourceId + 来源会话/出口标识 | bytes、经过筛查的 ArtifactRef、图片尺寸、重定向次数 |
| `preparePage` | 一个已保存 source-html 引用及对应 bytes | 原文文字、表格/行/单元格、表头与 rowspan/colspan |

共用 `v3-contracts/acquisition.ts`，校验 request / observation / operation、来源/挂牌/变体、版本、策略及输入指纹。
任务载荷不接收下载 URL、Cookie、代理地址或浏览器对象；签名 URL 由受信任来源会话通过 resourceId 解析。
HTML 使用新增 `source-html` / `text/html` 引用；原始文件仍可单独留存，不用处理后的文字替代原件。

## 职责与可靠交接

模块返回的是**已计算的内存产物，不是已经持久保存的成功**：`artifactDurable=false, resultRegistered=false`。
ArtifactRef 此时描述待发布字节，其 key 不能作为“远端已存在”的证明。

```ts
const prepared = await acquireFile(input, { access: sourceAccess, dns: systemDns }, signal);
// 以下属于运行外壳，而非 acquireFile 的职责：先保留证据，再做可靠交接。
const publication = await artifactResolver.publish(prepared.file, observation, prepared.bytes, signal);
// publication.durable 仍不等于结果已登记、Workflow 完成或产品入库。
```

已验证与 v3-artifacts 的本地保留、远端发布及回读配合。页面输出供外壳保存为版本化 JSON/文字。
上述低层函数没有自动重试、备用出口、营养门槛或入库入口；不要绕过交接外壳直接重复调用下载。

### 文件路径运行组装（2026-09-06）

- `AcquireFileModule`：远端条件创建一次性执行标记后才允许来源请求；原文件本地留存、共享存储发布并核验，最后发布 `acquired-file/1` 完成证据。返回 `durable` 不等于 processing_result 登记或产品入库，本轮不新增该登记 codec。
- `PrepareImageOcr`：独立核验原文件和完成证据，构造带正确身份/配置指纹的单文件 OCR 任务，保存不可覆盖的任务证据。没有下载、图片缩放/重编码或 OCR 能力。显式上游 Review 经核验后沿用；下载 Activity 丢回执时只查已有证据。
- 重复投递先读已完成证据；成功操作换空缓存节点无需下载/PUT。存在未完成执行标记则被动 Review，不自动续下载。失败重投可能条件 PUT 已存在的执行标记，但不再次请求来源或上传原文件。上传失败保留本地原件和候选，显式恢复另行处理。
- `StaticDirectSources`：首个显式公开 HTTPS/直连来源适配。私有配置保存 owner/resourceId/binding/URL/allowedOrigins/expiresAt；任务只传标识。没有浏览器登录态、Cookie、Clash 控制或 ScraperAPI，也不自动刷新过期 URL。
- 当前只接图片路径；PDF 原件可保存，但 OCR 输入准备返回 `IMAGE.PDF_ROUTE_REQUIRED`，不能把 PDF 当图片发给 OCR。HTML 整理/PDF 分页各自模块仍待接入编排。

启动与队列配置见 [ACQUISITION_WORKERS.md](../../apps/v3-workers/ACQUISITION_WORKERS.md)，整链证据见 [验收报告](../../docs/quality/2026-09-06-file-acquisition-chain.md)。没有生产切换或常驻部署。

## 来源会话与网络

`SourceAccess.acquire` 返回受信任租约，必须真正固定来源会话和对应出口；这是调用方的能力，不是传一个字符串就真的锁住网络。
租约包含完整 owner（request/observation/brand/source/listing/variant）、resourceId、sessionId、egressId、
受信任 allowedOrigins、私有 URL、按 origin 提供请求头的方法，以及实际 transport。

每跳请求之前、每个响应块前后和返回前检查 owner/会话/出口一致性及租约有效性。
下载结束或失败后 release **本操作的租约**，不关闭他人的浏览器、不改变 Clash 节点。
release 失败不报告成功；已有错误不会被 release 错误覆盖。调用方的会话管理器须执行真正的固定和安全释放。

网络默认边界：

- 仅显式允许的 HTTPS origin、443；拒绝用户名密码、IP 字面量、fragment、尾点主机及非允许来源。
- 每次跳转重新解析 DNS，任一结果为内网/回环/链路本地/保留/映射或隧道地址，整次请求拒绝。
- 固定选中的公网地址用于实际 socket lookup，保留原始主机名用于 TLS SNI/证书校验，不做二次系统 DNS 查询。
- 最多 3 次跳转，逐跳检查；跨 origin 时不携带 Cookie/Authorization/Referer，即使目标为允许的 CDN。
  需要独立 CDN 登录态时应建立它自己的来源操作，不能自动把原站凭证带过去。
- 只允许 Cookie/Authorization/User-Agent/Accept/Referer 请求头，不允许来源覆盖 Host、代理或传输控制头。
- 无客户端重试、无重定向自动跟随；身份编码请求，拒绝压缩响应、206、不一致长度、HTTP 非 200。
- 整体 30 秒，release 最多额外 5 秒；取消会关闭响应。来源/传输适配器应响应 AbortSignal。

首个 transport 为**显式选用**的 `DirectHttpsTransport`（direct/1），不读取 HTTP_PROXY/HTTPS_PROXY 等变量，
不是未来 `managed=false` 的默认实现。它仍可能经过主机的系统路由/TUN；egressId 不宣称已经测出真实公网 IP。
不能拿它替代要求指定代理、浏览器会话网络或 ScraperAPI 的 transport；不匹配时拒绝，不自动直连。
任务 28–30 再实现“不管理/静态代理/Clash/ScraperAPI”实际适配及授权验出口；本轮没有改现有网络配置。
代理适配器必须在代理端也落实目标地址约束；仅本地解析一次、再让远端代理重新解析域名，不满足这里的安全契约。

## 内容与资源边界

文件最多 32 MiB，流式计数不只相信 Content-Length；可核验期望 SHA-256。
支持 PNG/JPEG/WebP/PDF，通过字节签名确定类型，HTTP MIME 如有声明须兼容，扩展名不参与判断。
图片检查尺寸（最多 4,000 万像素）和末尾/容器长度；PDF 检查版本头与 EOF。
**这是容器/元数据筛查，不是完整解码、CRC 审计、病毒检测或 PDF 可渲染证明。** 损坏压缩流、PDF 加密/页数等继续由对应下游解码器验证；不把失败文件重新抓取当作默认修复。

页面只接受 hash/长度/owner 对应的 UTF-8 source-html；最多 2 MiB、深度 128、10 万节点、200 表、2 万单元格，
文字/嵌套表格展开也有 8 MiB 输出限制。超限失败，不静默截断。
使用 HTML parser 解实体、保留表格层次和跨度，不执行脚本、不加载 iframe/图片、不跟随链接。
剔除 script/style/template/noscript 的代码或非主内容；原始 HTML 仍由原件引用保留。
不按 CSS/hidden 属性删除业务文字，不做 Formula/Ingredients 判定或金额归属推断；这不是浏览器可见性/布局重建。
结果是**不可信纯文字**，可能包含解码后的尖括号；下游 UI 仍须转义，不能当成安全 HTML 注入。

## 验证与文档依据

```sh
pnpm --filter @crawl-automation/v3-acquisition build
pnpm --filter @crawl-automation/v3-acquisition test
pnpm --filter @crawl-automation/v3-acquisition test:integration
```

单测覆盖策略、来源关联、并发隔离、取消与页面解析。集成使用真实本地 HTTPS 服务与合成证书，
通过**仅测试使用的 socket 重定向**把受检公网 pin 接到 localhost；保留原始 SNI 和证书验证。
这验证实际 HTTPS/流式行为，不是外部网站、真实代理或公网 DNS 端到端验收。
远端证据存储为内存适配器，本地缓存为真实 FileCopies；不调用 R2、模型或旧库。

固定依赖：htmlparser2 10.1.0、image-size 2.0.2、ipaddr.js 2.5.0。设计参考
[Node HTTPS](https://nodejs.org/api/https.html)、[htmlparser2 parser API](https://github.com/fb55/htmlparser2)、
[image-size 的元数据读取范围](https://github.com/image-size/image-size)、[ipaddr.js 地址分类](https://github.com/whitequark/ipaddr.js)；
实际行为同时核对了本地安装代码及测试。

[早期核心任务验收证据](../../docs/plane/evidence/CRAWLV3-18/README.md)。当前运行组装进度以上方 2026-09-06 记录为准。
# HTML 可靠交接补充（2026-09-07）

已有 preparePage 离线解析器已接独立运行角色：PageEvidence、PreparePageModule、PreparePageText。文本、原 HTML 引用、表格/跨度和完成清单持久保留；回执未知只查证据，共享执行/发布意向防止空缓存节点自动重解析/补传。PageTextWorkflow 已接独立文本模型与回执核验，不代表产品入库。[运行说明](../../apps/v3-workers/PAGE_WORKERS.md)。
