# DTC Codex / Ego native capture — CRAWLV3-163

用户确认：恢复迭代后的旧 DTC 采集步骤，只把 Chrome 改为 Ego。Codex 自主读取 Ego skill 操作浏览器；采集原始资料后才交给现有数据处理流程，不引入 CDP 桥。

## 核对的旧版本

Server 二 `/Users/server2/apps/crawler-dtc/source` HEAD `b891f0da436d0c35e466d0232deee1ee3c3a8a63`，`dtc-legacy-capture` 和 `crawl-products` 最后相关变更为 `20b09db`。模型仍使用旧配置的 `gpt-5.6-luna` / `medium`。保留 release 固定的 `crawl-products`、视觉探索、路线/终止契约、runHarvest、规格、完整图库和方法 profile；关闭 native 模式中按 HTML 关键词额外补图的旧规则，图集由模型的真实观察决定。

## 修改边界

- 分析、品牌目录发现、单品采集都交给同一个 Codex capture agent，通过 Ego CLI 的 TaskSpace / Page 操作。
- `ego-native-browser.mjs` 只适配旧机械 harvest 方法，无服务、端口、Chrome 或 Playwright 连接。
- 宿主创建精确任务页，Codex 结束且进程组消失后关闭并验证页面不存在。用户接管时保留 pending。
- 采集 workspace、原始 HTML/图片、方法与视觉核对证据归档 R2；File Activity 校验并读取同次采集的 R2 原图。
- 站点品牌/来源隔离、目录耗尽证明与规格归属不满足时保留 Review；不自动重试业务。
- DTC 采集还需持有模型许可，防止绕过已有模型并发容量。

## 配置迁移（部署时填写并核对，不包含密钥）

Server 二 `browser.dtcAgent` 使用旧 Codex 模型配置、`/Users/server2/.agents/skills/ego-browser/SKILL.md` 和 `mini-model-account`。codex.workRoot 沿用 `/Users/server2/apps/crawler-dtc/browser-model`，方法 profile 原地复用；新任务写其 `dtc-native/` 子目录，没有搬迁历史缓存。
Server 一 API `brandScans.permits.dtc.additionalResources` 增加同一模型资源一单位；`pipeline.channels.dtc.resources.activities.captureProduct` 也同时需要浏览器和模型许可。所有开始操作必须由现有 API/ResourceGate 发起。

## 验证状态

2026-10-02 07:22 UTC：两台 Mini 经 fresh Git clone/build 部署 main `92d4cb3911c56665b4dd77be4482a8b504c379b3`，所有改动进程通过健康确认。完整 pnpm check 通过；纯测试 22 项 worker/采集、41 项 harvest、4 项 R2、4 项 recovery 通过。Server 二进程/浏览器适配/Temporal replay 共 57 项通过，扩大回归 327 项通过、6 项跳过，构建成功。隔离 HOME 下 Ego CLI 连接验证通过。

Solaray 原生单品测试于 07:23:04 UTC 受理：run `ffc58ad5-451c-49d0-a7cd-b08f9d82ddcf`，source `e9b8bcd7-7fc6-4605-969c-c8cd6d776f3e`，`https://solaray.com/products/zinc-copper`。该次 Review：Codex 报 `code-mode host is disabled`，没有访问商品页。直接原因是 capture profile 从纯文本/视觉 profile 继承了 code_mode_host=false；修复启用 capture 专用 code_mode/code_mode_host，保留文本/视觉原限制。进程组停止证明已写出，heldPermits=[]；失败产物保留。待新任务验证：Codex 读取两个 skill、Ego 原生调用、完整产品原图归档和下游读取、目录发现/耗尽、分析、页面与模型许可释放。Worker 被强杀后的 Codex 进程自动停止尚未实现；没有停止证明时不释放许可、不关闭仍可能使用中的页。

父验收 CRAWLV3-151；本次修改 CRAWLV3-163。服务器代码只能经 origin/main 的 fresh clone/build 部署，DTC 队列保持手动控制。

## 第二轮与底层诊断（07:45 UTC）

Server 二已部署 `49bf609`，第二轮 Solaray run `2ca43098-fc07-4be9-9acb-1ae72592b782` 于 07:28:26 UTC 受理，07:36:59 Codex 停止。模型读取两个 skill 并直接调用 Ego，页面 DOM 可读取，但原生 `Page.screenshot` 超时；runHarvest 返回 `worker_product_not_discovered`，0 records。该次没有产品原件，没有通过视觉验收。R2 `v3/dtc-agent/product-2ca43098-fc07-4be9-9acb-1ae72592b782/archive.json` 中 20 个失败证据文件已全部读回核对大小和 SHA-256。

`13fc82b` 修复恢复 Page 无 targetId 的兼容：传入宿主精确 ID，每次从 task.tabs 验证；单品牌允许多个同站目录 seed；Codex 先登记执行身份再接收 prompt。Mini 6 项新增/相关测试全部通过。该版本尚未切换生产 Worker。

独立 Mini 原生诊断进一步复现旧 harvest 调用 `evaluate(fn, undefined)` 被 Ego 拒绝：`page.evaluate argument must be JSON-serializable`。适配器现改为省略未提供的第二参数，保留 null/对象参数；新增回归。采集 prompt 增加 harvest 原因日志和视觉 preflight 失败立即 Review，禁止 DOM 冒充视觉验证。

环境阻塞：Server 二 IOConsoleUsers 报 `CGSSessionScreenIsLocked=Yes`；原生 screenshot 超时，页面级 captureScreenshot(fromSurface=false) 返回 Unable to capture screenshot。锁屏是候选原因，尚需解锁后对照验证。独立诊断的 p91/p92/p93 均已精确关闭并核验不存在，保留基线 p1。Server 一 Docker 日志于 07:36:53–54 UTC 正常退出，Docker socket 不存在，数据库 127.0.0.1:55432 拒绝连接。Tailscale SSH 同时不可达，可经 Server 二跳转 LAN 并沿用已验证主机密钥访问。未擅自恢复可能由用户停止的服务；已请求说明和 Server 二解锁。第二轮精确页已关闭且本地 Codex 进程组不存在，但因数据库停止，账本停止/许可释放尚不能确认。不得宣称端到端验收成功或启动下一商品任务。

`ccfb0d8` 已推送 main，43 项 harvest/native 纯回归及完整 pnpm check 通过。Server 二从 origin/main fresh clone 到 `manual-releases/dtc-native-ccfb0d8/source`，仅用于隔离接口测试。真实旧 openPage 成功读取 Solaray 的 793,182 字符 HTML；同源商品数据返回 1 个规格、2 项图片元数据；原生文件下载返回 22,147 字节 SVG。该下载样本实际为 Best Seller 徽章，只验证文件传输，**不计作商品图库或视觉验收**，未写入业务产品。诊断页 p94 / `560B64FDB7BCD5F6A324B0A7A6D3B232` 已关闭并核验 absent=true。完整报告保留在 Server 二 `manual-releases/dtc-native-20261002/native-evaluate-smoke.json`。

待验收：环境恢复后的精确账本停止/许可释放；部署新修复；新 Solaray 任务完整轮播逐图检查、HTML/原图 R2 和下游处理；HMW 全目录发现/耗尽与站点分析；后续多规格、其他截图品牌和异常恢复。Server 一生产仍为 `92d4cb3`，Server 二生产仍为 `49bf609`，不能把 main 最新修复当成已上线。

## 窗口显示复核与恢复（08:11 UTC，替代上一节阻塞状态）

用户说明 Server 二没有锁屏。本轮 IOConsoleUsers 已无 ScreenIsLocked 标志，Solaray 及 about:blank 的原生截图仍超时，32×32/raw 截图同样失败，Page.info 的 1908×861 视口和 1920×1080 在线显示设备正常。因此此前将失败直接归因为锁屏不准确。Ego 官方仓库 [PR 255](https://github.com/citrolabs/ego-lite/pull/255) 记录了隐藏/最小化窗口时 DOM 正常但截图超时的症状。用 `open -a '/Applications/ego lite.app'` 恢复现有应用窗口显示后，原生 `Page.screenshot` 成功；已实际查看 Solaray 正常商品页截图。该对照支持窗口显示状态相关，未区分隐藏与最小化，也未重启/升级浏览器或更改空间所有权。诊断 p95/p96/p97 均已精确关闭、核验不存在；截图保存在 Server 二 `manual-releases/dtc-native-20261002/native-visible-recheck.png`。采集时保持 Ego 窗口正常显示；只凭截图超时不能判断用户锁屏。

Server 一 Docker/Postgres 已恢复。第二轮真实 Workflow ID 为 `product-run-2ca43098-fc07-4be9-9acb-1ae72592b782`，Temporal run ID `01a0fb83-b040-74f3-8fe6-d31b9769aaee`；以业务 run UUID 查询 ledger 的 workflowId 会漏查。其 permit `permit-01a0fb83-b040-74f3-8fe6-d31b9769aaee-0` 因数据库中断保留 running。已验证 owner FAILED 且无 pending Activity，R2 process.json 与执行机原件 SHA-256 均为 `7383b07e75fecdb3ce82fc266d23a858822802b3e5b51e09e0ae9703e9a6122d`，本机 PID/PGID 71609 均 ESRCH。通过现有应用 ledger 精确补写原 Codex 停止证明，再调用 `resources.verifyStop`，返回四项 stopped=true、released=true，后续 held permits=[]。历史失败和 Review 没有重跑或修改。

08:11 UTC Server 二已从 origin/main fresh clone/build 部署 `3cf56e9`（包含 `13fc82b` 和 `ccfb0d8`），唯一 browser Worker 健康检查通过；Server 一保持 `92d4cb3`。08:11:50 新受控 Solaray 验收 run `3f9250b2-0478-4aad-8734-40c1cd0b9aad` 已受理，DTC 批量队列保持 paused。此处仅记录测试开始，不代表产品采集或端到端已通过。

部署前所有队列自然暂停且无 held permit；部署后恢复原本 running 的 Amazon/GNC/Swanson/Whole Foods/Costco，DTC 批量队列保持 paused。配置和队列快照在两台机器各自的 `manual-releases/dtc-native-20261002/`，旧 PM2 配置由部署器留存。

## 第三轮归档失败及交接回归（08:21 UTC）

第三轮 `3f9250b2-0478-4aad-8734-40c1cd0b9aad` 的 Codex 于 08:18:56 退出，最终保存一条 Solaray Zinc Copper record、一个规格 `32703815778364` 和两张图库原图。随后 finish 的 120 秒原件归档超时，08:21:01 Workflow 以 Review `PIPELINE.ACTIVITY_UNRESOLVED` 结束；不能将 Workflow COMPLETED 或模型自报 complete 当成业务成功。原件仍位于任务目录 `8598f052cfafa059085c8c75e9b1d296e63ce4fc792781627442bae7f592e201`，包含模型修正前的两轮 capture 副本。p98 / `81C4F1EC8C6E708377DB58E207AD78F3` 已关闭，space 6 仅余既有 p1，heldPermits=[]。

本地修复：归档最多并行四份文件、等待同批全部上传停止后才返回失败，归档上限五分钟；review 允许引用同一 workspace 已归档的截图，产品 HTML/图片仍限制在 capture 内，不放宽读文件的穿越/符号链接保护；仅一个规格时，保留其商品共用图库图并绑定已验证的选中规格。旧逻辑会丢弃 Solaray 的共享成分表图，因为该图的 assignment.variantId=null、选中规格非空。35 项针对性测试及全仓 pnpm check 通过，服务器尚未部署。

模型声称逐图视觉验证，但 exec JSON 记录中没有独立看图事件，尚未确认该日志是否完整记录此工具，不据此认定视觉验收通过。prompt 已明确要求使用 view_image 并记录逐图观察。旧版变体文档已复读：平台商品先保存全部 variants 和图库，基础商品语义处理后再展开规格；无法确定的规格图片不得混用。Solaray 只有一个规格，本次不是多规格内容歧义。多规格、HMW 目录/分析及 R2 到后续处理的端到端验收仍待完成。CRAWLV3-163 已补充精简状态评论。

用户进一步纠正：规格来自网站自身，而非图片。已移除新 capture projection 中 `variant_gallery_unassigned` 的前置拒绝及按默认规格筛掉其余图片的行为；交接保留全部网站 variants 和全部图库候选，单规格共享图片可归属唯一规格，多规格未明确绑定的图片维持 null、已知其他规格图片保持其原 ID。prompt 明确 SKU/选项/平台数据才是规格来源，共用图片未绑定本身不构成采集失败。没有放松后续 planner 的规格隔离，当前后续处理对多规格共享素材仍可能产生 CHANNEL.VARIANT_CONFLICT；CRAWLV3-155 继续跟踪旧版按基础商品处理后展开规格与现行处理链的差异，不能把本次修复称为多规格端到端通过。

`fa7bd351e52af7f9d250aabd618dcc4b247407da` 已提交 main 并推送（完整 pre-push check 通过）。Server 二通过 origin/main fresh clone 到 `manual-releases/dtc-native-handoff-fa7bd35/source`，安装锁定依赖；40 项采集/下游交接回归通过。用第三轮原件只读重放新交接：76 个文件、13,138,224 字节全部大小/hash 一致，根目录截图引用通过，新 projection 保留网站唯一规格（SKU 076280471052、100 ct、价格11.89）及两张原图。该验证仅使用内存 publication，没有访问网站、写 R2、启动新业务或更改旧 Review；它验证原件交接和归档遍历，不代表真实 R2 上传超时已验收。生产 Worker 仍为 Server 二 `3cf56e9`、Server 一 `92d4cb3`，本次修复尚未切换生产。

## 第四轮归档通过，品牌交接修复（08:54 UTC）

Server 二于 08:40:19 经 origin/main fresh clone/build 部署 `7df2d24`，Worker 健康确认；Server 一保持 `92d4cb3`。第四轮 Solaray run `51c8c9d7-f31e-4005-8575-35a645e558fe` 于 08:40:45 受理。Codex 原生 Ego 采集保存 1 条商品、1 个网站规格和 2 张实际图库原图，08:49:41 退出；p99 / `6D352C4FF1AA874407CEBC98E96713A9` 于 08:49:42 关闭并核验不存在。R2 archive.json 的 30 份文件共 5,268,756 字节全部回读核验大小和 SHA-256，归档约 52 秒内完成。heldPermits=[]，旧失败没有重试或覆盖。

最终业务结果仍为 Review `DTC.BRAND_UNVERIFIED`（08:50:34）。records.fields 未保存 brand，而原始 HTML 中本商品 URL 匹配的 Product schema 明确写有 Solaray。修复交接从已留存的本商品 schema 补读缺失品牌，拒绝异商品/重定向/歧义 schema，不用任务来源名称猜品牌，也不覆盖已采集的异品牌；prompt 同时明确采集品牌及其出处。这不改变 Codex 视觉决定路线、图库与旧 runHarvest 保存原件的分工。

另核对旧 V3 `archive/packages/v3-channels/src/dtc-rendered.ts`：旧交接使用基础商品 variantId=null；完整 variants 原件留存，但不等于自动逐规格提交已实现。修复新 capture 对多规格基础 URL 的默认规格误绑定：基础商品任务按商品级交接全图库，原始规格及图片对应关系仍在不可变 records/review 中；显式规格 URL 保留严格隔离。未将共用成分表无证据复制到不同配方。33 项纯回归通过；Mini 下游交接及真实多规格仍待验收，CRAWLV3-155 已设 In Progress。

补充日志审计：Codex 官方 exec JSONL emitter 只输出已映射事件，缺少独立 view_image 事件不能证明模型没有看图。当前证据是原生截图、图库切换、实际保存原图和模型逐图记录；不得把缺失日志事件当成失败断言。仍需核验具体原图内容。

## 品牌补读部署与单品入口缺陷（09:05 UTC）

`dbb7944` 于 08:56:07 经 Git 新克隆构建部署 Server 二；39 项 Mini 回归全部通过。第四轮真实原件按生产 multi-brand source policy 只读重放，品牌补读得到 Solaray 并通过 matched 校验，网站规格和两张原图保留，未访问网站或改写旧业务结果。两张原图已实际查看：100 VegCaps Zinc Copper 正面、清晰的 Supplement Facts 图，后者为 Iodine 53 mcg / Zinc 50 mg / Copper 2 mg / Pumpkin 10 mg，另有四项 Other Ingredients。这只是验收对照，不是另行采集或健康建议。

第五轮 run `4b088559-c505-4b09-af24-bd3e05f62457` 于 08:56:50 受理，尚在运行。模型先把长目录路径拼短导致 import 失败，自行纠正后又出现 `worker_product_not_discovered`：旧引擎默认从详情页枚举目录链接，得到推荐商品后被单品范围门过滤，反而找不到已派发商品。本地修复 Ego 单商品 runHarvest 的枚举入口，直接使用宿主已派发的精确 URL（包括明确 variant），不再调用该商品页的目录发现；后续提取、身份和原件校验保留，无 productUrl 的目录模式不变。新增两项回归，相关 harvest/native 共 45 项通过。提示直接提供完整 native import 命令，避免重新手抄任务目录。此修复尚未部署，也未中止正在进行的第五轮。

## 第五轮取消与原件留存缺陷（09:12 UTC）

第五轮采用的旧 imageProfile 只有 `.product__media-list` 的 galleryContainerHints；通用提取仍合并了推荐商品图。模型发现后删除了第一次 harvest 的 checkpoint、records、HTML 和 9 份图片，再 fresh 收割。该行为违反保留原件要求，于 09:06:03 通过 runs.cancel 停止本轮；最终 CANCELLED、heldPermits=[]，process.json 证明原 Codex 进程组不存在。R2 archive 保留取消时的 20 份文件（含第二次收割的 HTML、两张图片和 records）。第一版 HTML/图片已删，不能将第二次抓取或第四轮原件冒充第一版恢复。CRAWLV3-164 单独记录此缺陷，In Progress。

`a39efab` 单品入口修复已提交并推送，但 Server 二仍运行 `dbb7944`。新增修复在原生 HTML、平台响应和图片取回时，立即在任务根目录 `native-originals` 写内容哈希命名的独立只读副本及每次捕获 receipt（URL、时间、大小、SHA-256）；每次 harvest 返回模型前同样保存 plan/result/records 快照。宿主既有 archive 会收齐这些副本。副本与 capture 工作目录分开，规范写入只追加，不覆盖同名内容；这不是对恶意模型的操作系统级不可删除保证。采集提示明确禁止删除或 fresh 重跑证据目录，发现采后错误须返回 Review。

原生单品同时新增必填 observedGalleryUrls，由模型在收割前依据本次实际页面确认完整轮播及详情图集合；脚本仅保存这个集合，不采用旧通用图片提取器的关键词/推荐图片区启发式。旧目录发现不变。50 项 harvest/native 纯回归通过，涵盖新入口、保留不同捕获版本、清工作目录后原件仍存在、损坏副本拒绝，以及缺少已观察图库时不开始收割。服务器部署与下一次真实验收尚未完成。

## 第六轮进行中与恢复候选补测（09:21 UTC）

Server 二于 09:14:34 经 origin/main fresh clone/build 部署 `6d5b9a1`，Mini 上 50 项 harvest/native 和 12 项交接/恢复检查通过。第六轮 Solaray `9b94c240-7541-41d5-b720-629fd598fad7` 于 09:15:49 受理；09:20 仍由 Codex 在原生 Ego 中观察两张图库及页面，尚未开始 harvest，不算采集通过。Space 6 的任务页为 p101 / `B5A8A4679B3953FC7B79ABCC96A7FE58`，基线页保持不动。Server 一保持 `92d4cb3`，DTC 批量队列 paused。

第五轮取消的四项停止证明全部齐全：Codex 进程组不存在、CLI 已退出、精确任务页 absent、round 已结束，09:06:23 许可自然释放。该正常取消验证不等于 Worker 被强杀后的 orphan Codex 自动清理已实现。

CRAWLV3-150 补查发现自动恢复候选 SQL 只认 `ego-single-page/1`，遗漏新 `ego-native-capture/1`。修复只加入新协议，保留活动已结束、本机、本空间、许可未释放的筛选；恢复执行器仍要求 Codex 停止证明后才关闭任务页和释放资源。新增 PostgreSQL 集成测试使用独立连接的临时表并回滚，验证 native/legacy 命中，运行中、已释放、异机器、异空间及未知协议排除。类型/lint 和七项纯恢复/准入回归已通过；数据库集成测试待 Mini 执行，此修复尚未部署。当前正常采集不会为此重启。

## 第六轮原件留存通过，品牌缺字段的前置 Review（09:28 UTC）

第六轮于 09:23:20 结束 Codex，09:24:03 业务结果为 Review `DTC.CAPTURE_REVIEW`（模型 reasonCode=`brand_field_missing_in_records`）；没有进入后续处理。1 条原始商品、1 个网站规格、2 张实际图库原图均取得；两个图像内容哈希与第四轮一致。新增原件副本包含 HTML、商品 JSON、两张图片、harvest plan/result/records 快照，各有 receipt；R2 `v3/dtc-agent/product-9b94c240-7541-41d5-b720-629fd598fad7/archive.json` 全部 38 文件、7,890,721 字节回读大小和 SHA-256 一致。最终 heldPermits=[]。原件留存验证通过不等于整条产品业务通过。

前一版的宿主 HTML 品牌补读没有机会运行，因为模型看到 records.fields.brand 缺失就在更前面返回 Review。原始商品 JSON 自身明确 `handle=zinc-copper`、`vendor=Solaray`，引擎此前只取 variants，没有保留 vendor。修复原生 harvest 在字段缺失时从 handle 精确匹配的实际平台商品 vendor 保存 brand，并保存其 product-json-vendor 来源和 JSON URL；不覆盖已有品牌，不从配置期望值补写，异商品或空 vendor 不采用。54 项纯回归通过；新增 Mini 原件重放测试只读第六轮原件，在新临时目录重放，禁止网络，验证品牌、全部网站规格、完整图库及图片字节。原任务和 Review 保持原样。

恢复候选修复 `2023c22` 已推送，Server 二 fresh Git clone 的真实 PostgreSQL 临时表集成与四项恢复回归共五项通过；尚未切换生产。CRAWLV3-150/163/164 分别跟踪恢复、采集交接和独立原件留存。
