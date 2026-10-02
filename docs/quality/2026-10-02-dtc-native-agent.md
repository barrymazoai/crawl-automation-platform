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

`0084ef9` 已于 09:29:49 经 fresh Git clone/build 部署 Server 二，browser-worker 健康确认，包含 `2023c22`。Mini 真实第六轮原件只读重放通过（所有原件 hash 校验、禁止网络、独立临时目录），49 项 harvest/原件留存与五项恢复检查全部通过；全仓 pnpm check 通过。第七轮 Solaray `009abc74-6df3-4451-9e53-51f4bd822d3b` 于 09:30:20 开始，目前仍在页面/图库/下方折叠区检查。DTC 批量 paused，其他原本 running 的无待处理渠道已恢复原状态。CRAWLV3-164 原件留存修复进入 Review；父票 151、原生链路 163、多规格 155 和恢复 150 仍 In Progress。

补充尚缺的采集执行器超时测试：原用例只覆盖正常结束和取消，现加入一秒受控超时、子进程忽略 SIGTERM，要求结束后实际子 PID 不存在、持久化 process.json 和 ledger 停止证明均具备，错误仍为 TEXT.CODEX_TIMEOUT。仅在 Mini 以独立假 provider 进程运行，不触碰当前业务、真实 Codex 或浏览器；尚待 Mini 验证，不代表 Worker SIGKILL 演练。

## 第七轮可售状态冲突（09:44 UTC）

第七轮 Codex 于 09:38:06 停止并返回 needs_review/availability_conflict：完整取得一个商品、一个规格、两张原图，品牌已正确保存 Solaray；旧提取字段 availability=OutOfStock 与本商品实际可用购物按钮及 JSON-LD Offer 的 InStock 冲突。R2 `v3/dtc-agent/product-009abc74-6df3-4451-9e53-51f4bd822d3b/archive.json` 全部 36 文件、7,418,751 字节回读大小/SHA-256 一致，Workflow 已结束，heldPermits=[]。CRAWLV3-165 单独立案 In Progress。

根因：旧 engine.extractAvailability 对所读页面片段做全局文字匹配，并不能证明本商品/规格的状态。原生修复改为从本轮留存 HTML 中读取 URL 精确匹配的 Product/ProductGroup Offer，并按网站 variantId 保存各规格状态；显式规格 URL 只使用该规格，基础商品的多规格状态不一致时不强塞一个值。缺失证据不再沿用全页猜测值，结构化证据冲突保留 availability_conflict 标记，不覆盖为成功。原机械图库采集及网站规格枚举不变。64 项纯回归通过，Mini 第七轮原件重放待执行。

独立执行器测试 `2a51b03` 已推送并在 Server 二 fresh Git clone 执行，四项全部通过：正常结束、取消、超时（含拒绝 SIGTERM 子进程）、执行登记失败时不发 prompt。测试验证了子 PID 实际不存在和 process.json/ledger 停止证明；没有调用真实模型或浏览器，没有切换生产，不能替代 Worker SIGKILL 恢复验收。

## 字段预览约定与模型 503（09:58 UTC）

`25f0271` 可售状态修复在 Mini 第七轮真实原件只读重放通过：InStock、唯一规格 available=true，品牌、全部规格、图库及图片字节核验一致；59 项 Mini 检查通过。09:47:48 经 Git fresh clone/build 部署。随后原件复核另见 recommended_daily_intake/notes 与实际 Ingredients/Directions 串位、Facts 混入 FAQ，所复用方法 profile lastValidatedAt=null、successCount=0，记录 CRAWLV3-166 In Progress。单商品 prompt 要求收割前逐项核对 profile 字段预览，先修正方法或使用实际观察节点的 extract hook，保存 field-preview.json/profile-validation.json；不能只改计数称验证通过。该约定只适用于商品采集，不用于目录发现/站点分析。`31f5d39` 于 09:51:30 经 Git fresh clone/build 部署 Server 二，Server 一仍 `92d4cb3`。

第八轮 `619dec03-06f8-45f3-af12-fdc2322348b7` 于 09:51:58 受理，但 Codex 09:52:25 在读取 skill 后即上游 503：`Unable to verify Daybreak Blue access`，request `1f24778d-646d-417d-b749-114442a8f2c3`。没有导航/采集产品，没有原件；PID 44491 进程组停止、heldPermits=[]。R2 archive 的五份错误/过程文件、167,924 字节全部回读大小/hash一致。它不能作为库存或 profile 修复失败/成功的证据。

Server 二 Codex login status 仍已登录 ChatGPT。等待后的一次独立 30 秒连接测试（不使用工具、不访问网站，目录 `manual-releases/dtc-native-20261002/provider-probe-GW580C`）返回 complete/OK。确认当时服务恢复后，手动启动新的第九轮验收 `169c3416-fad4-4e11-8c47-a3e5e4b98fae`，09:57:57 受理；旧失败 Workflow/Review 保持原样。09:52:23 fleet 检查 Server 一七进程 ready、OCR 4/4 healthy。DTC 批量继续 paused；当前仍无新原生路径端到端通过。

补充停止账本只读核验：第六、七轮各四项停止证明齐全，精确任务页分别于 09:23:20.785 / 09:38:06.476 验证 absent，许可分别于 09:23:59.638 / 09:38:39.699 自然释放。不是只删了许可账目。

## 第九轮字段污染复现与结构解析修复（10:11 UTC）

第九轮 `169c3416-fad4-4e11-8c47-a3e5e4b98fae` 于 10:05:32 结束 Codex、10:06:15 业务 Review `DTC.CAPTURE_REVIEW`，reasonCode=`field_contamination_supplement_facts`。品牌 Solaray、网站唯一规格、两张完整图库均保存，真实记录 availability=InStock、唯一规格 available=true，库存修复已在真实页面采集中生效。R2 archive 的 38 份文件、7,254,667 字节全部回读大小/SHA-256一致；heldPermits=[]。全部旧原件和 Review 保留。

预览文件手写了正确的页面字段，但正式 upgradeProducts 沿用通用 fallback，保存结果仍把 Ingredients 配给 Directions、把用法配给 notes，并把 Directions 和含 supplement 的 FAQ 拼入 Facts。模型采后将 profile-validation 标记失败，没有删除/重抓或篡改 records。CRAWLV3-166 继续 In Progress，不能把提示词要求等同于实现。

根因已从留存 HTML 对照：旧 traitBlockRe 把嵌套 accordion__content 当成新区块边界，前一正文与后一 summary 配对；buildSupplementFacts 又把 Directions/notes/storage 及任何含 supplement 的标题当 Facts。修复以已有版本 linkedom 解析区块结构，按同一 details/summary、ARIA controls、同一 accordion 行或有界 heading/body 配对，不跨相邻区块；Facts 只接受真实 Facts/营养/活性成分表标题和表格，图片形式无文本时留空，图像仍按完整图库保留给下游。显式模型字段映射保留。采前预览要求调用实际提取方法，不能手写期望值代替。

87 项本地纯回归通过；新增 Mini 真实原件回放使用原 HTML 实际重新提取字段，而非复用错误 records.fields，检查 Directions、Ingredients、空文本 Facts，再在独立临时目录校验品牌、规格、图库、字节及库存。Mini 原件回放、部署与新端到端任务尚待完成。目录耗尽、HMW 多规格和 Worker SIGKILL 异常恢复仍未验收。

`c026d9b` 已通过全仓 check 并提交/push main；Server 二 fresh Git clone 的 61 项检查（包括第九轮原件实际提取/完整 harvest 重放）全部通过，不访问网络、不改旧记录。10:14:00 经 Git fresh clone/build 部署成功，只有 browser-worker 更换，Server 一仍 `92d4cb3`。第十轮 Solaray `4f615cb1-5129-46bf-8273-fa6f4aea4860` 于 10:14:22 启动；任务目录 `c6f4c6d360d0461860106603a35973f5244fe31a2ca3a6f19c6853e2a34d54b2`、p105 / `9671318C8DD9A4ECF0E5203644CC8344`。DTC 批量保持 paused，其他原本 running 的空队列已恢复原状态。CRAWLV3-165 库存修复进入 Review，166/163 仍待真实端到端结果。

第九轮账本四项停止证明已逐项读出核验：Codex PID 47471 进程组 absent（10:05:32.674）、精确任务页 absent（10:05:33.020）、CLI PID 47469 exited、round ended；许可自然释放于 10:06:11.305 UTC。

## 首个原生单品 collected 与目录接线问题（10:34 UTC）

第十轮 `4f615cb1-5129-46bf-8273-fa6f4aea4860` 于 10:28:17.756 返回 collected。记录 `label-be75167e52eb56e572cf5270232095efad2fe6cc916b54779971a301de0675a2`：Iodine 53 mcg / 35%、Zinc 50 mg / 455%、Copper 2 mg / 222%、Pumpkin 10 mg，四项辅料和 Serving Size 1 VegCap 均与实际原图一致；warningCodes=[]。R2 42 份文件、7,931,219 字节全部回读大小/hash一致。下游 file.acquire 的 Facts 原件 SHA-256 `fb4d15753485a989a47e989fc22f98ebc3c4905cc67141ef97266d2716776318` 与采集原件相同，没有替换或重抓。四项停止证明齐全：Codex PID55894 进程组 absent、CLI55892 exited、p105精确目标10:23:51.547 absent、round ended；许可10:24:49.503释放，最终所有heldPermits=[]。

字段预览本次确实执行 applyDetailExtractionProfile，不是手写期望值；正式记录 Ingredients/Directions/Warnings 分开，Facts 文本缺失时留空且两张图库完整。CRAWLV3-166 进入 Review。但网站 variants 中 `100 ct` 未进入后续 enrichment（candidate.variant.count=null，notes 说未提供包装数），单列 CRAWLV3-167 In Progress。标签配方结果与网站包装元数据是不同来源；不能改用每份量或图片猜规格，也不能因 collected 就宣称全部数据完整。

10:30:02.482 发起 HMW 原生目录 scan `454aaa75-59fb-45d4-88af-8750a7ef1938`。10:30:36.441 以 Review `DTC.AGENT_REQUIRED/capture_model_permit_required` 结束，0页/0产品/0入队，未执行原生浏览器采集。账本实际 workflow 是 `brand-listing-*`，只申请 dtc-brand-scan 与 server2-ego-space-6；私有 API 配置 additionalResources 已有 mini-model-account。根因 gatedListings 依据 BROWSER_SCAN_PERMITS 排除浏览器渠道，该集合遗漏 DTC；TemporalBrandListings 因此抢先接走 DTC，未走已有正确保留 additionalResources 的 TemporalBrowserScans。CRAWLV3-168 In Progress。修复纳入 DTC 浏览器渠道，实际 brandScanParts/runner/Temporal 接线等33项回归通过；尚待 main 部署 Server 一和新受控目录验证。旧 Review 保留，DTC 批量仍 paused。

## 网站规格传递修复与目录阶段冲突（10:48 UTC）

`9c14f79` 已经 main 推送、Server 一 fresh clone/locked install/build 部署，10:40:07 七个服务 ready；Server 二的33项路由回归也通过。新 scan `853b613c-cae2-4b37-a617-b2f5e9302368` 10:40:35 提交、10:40:37 开始，实际走 browser-scan Workflow，许可包含 dtc-brand-scan、mini-model-account、server2-ego-space-6，Codex PID69003 和任务页 p106 均登记。DTC 批量仍暂停。

目录任务随后暴露通用提示混入 runHarvest 和图库/规格收割要求，生成脚本在目录发现后调用完整商品 harvest，与 catalog 专用仅发现指令冲突。10:45:51 精确请求取消该扫描，随后 Temporal 正常取消；10:46:14 Codex 进程组 absent、任务页 3FFA3AA3FB83A1471DC61506E4C21534 absent，round 结束。归档、许可和扫描终态待复核。CRAWLV3-169 单独立案；本轮不能称目录扫描完整通过。

CRAWLV3-167 修复将经过 owner/hash 校验的 DTC 网站唯一或明确选定规格，作为 website-variant/1 元数据传入 enrichment；原始 title、配方及旧 enrichment 保持原样。多规格基础商品不套用默认规格，其他渠道行为保持不变。选定规格的原始 options 也由后续采集投影保留。新增内容参与 inputHash，来源地址不参与内容去重；无规格上下文的旧输入和 prompt 保持一致。数量校验仍排除 servings 和含糊/冲突数量。83项纯回归通过，另加 Mini 留存投影离线重放测试，尚待执行和生产部署。

已从 R2 回读第十轮 enrichment input 和原投影，投影2840字节、SHA256 `6946469ffdd7418632ae4ddd39155e6aa13d14c9805a5fbcaf52075f70f26324` 与原 artifactRef 一致。缓存目录 Server 一 `manual-releases/dtc-native-20261002/solaray-website-variant-replay`，不会重新抓网页或修改旧原件。

HMW 第二次原生目录扫描于10:47:23.600终态 cancelled，0产品入队，heldPermits=[]。R2 archive71文件、24,703,223字节全部回读大小/hash一致，原始目录及误入商品阶段的产物均保留，不能作为新目录验收结果。CRAWLV3-168的真实路由已验证；CRAWLV3-169继续处理阶段隔离。

169修复按product/catalog/analysis分别给机械步骤，目录不再收到runHarvest调用样例，并要求真实零增长复核记录。宿主把captureMode传入独立Codex环境及原生工具，runHarvest在目录/分析模式下于任何读取/写入前拒绝；保留原商品模式行为。58项纯测试通过，新增宿主模式环境传递由Mini的执行器集成检查验证，尚未部署。

167的83项测试在Server一fresh clone通过；首次真实投影回放因测试错误使用single-brand配置而被严格品牌校验拒绝。原投影实际是按品牌来源matched配置保存，测试改成相同品牌来源政策，未放松生产校验。`a9b4040`同时禁止跨独立元数据字段拼接数字与单位。真实重放和生产验证仍未结束。

## 规格真实验收通过；目录缺少稳定轮次被拦截（11:04 UTC）

`bb8bb14` 已于10:54:54/55分别在Server二/一经Git fresh clone/build部署，所有相关进程ready。Server一84项检查通过，包括R2原投影严格品牌/owner/hash校验的离线重放；Server二62项目录模式/执行器/旧harvest检查通过。Solaray仅用既有sourcePlan启动标准化工作流 `product-enrichment-2131e1276ee3ea286f76131c82151224e77cea59cd9889c1a1d562bb1f977d6e`，10:55:32.279成功记录 `3b7a8b064bb4adfa554fc34e3ae0913f17e42d970a55f55ea9a489d9d90cb266`，count=100、notes=null、明确websiteVariant标题100ct。新input/prompt/response/record全部从R2回读，prompt/response hash一致；旧5a8e318a记录仍count=null，formulaHash相同。未重抓网页、未重跑OCR；CRAWLV3-167转Review。

HMW第三次原生目录scan `6e6a71fe-fca7-4bcc-8f72-5e470b7667e7`（10:55:18提交）已只执行目录发现，不再runHarvest。实际发现6个产品，保存了目录HTML/截图、标题及路线；但只有一次collectProductUrls，events只有added=6，zeroGrowthRounds=0。Codex错误声称complete，宿主正确拦截catalog_completion_unverified，11:00:16.332 Review DTC.CAPTURE_EVIDENCE，0入队、heldPermits=[]。R2 archive21文件、4,107,716字节全部大小/hash回读一致。169阶段隔离已在实际任务生效，但目录完成仍失败；新增CRAWLV3-170 In Progress。

170根因是拆目录阶段时只调用了底层单轮collector，漏掉旧runHarvest ENUMERATE-to-fixpoint循环。补充discoverCatalog仅做该机械阶段，保留逐页原始HTML/截图，至少两轮且额外一轮无增长才报告complete，预算/覆盖缺失/异常保持不完整且不自动业务重试；新增宿主按实际轮次/增长/产品集与留存页面校验。69项目录收集和旧collector纯测试通过，另有12项宿主校验/指令测试正在核验。修复尚未部署。

## 目录设计复核与用户决策（11:20 UTC 后）

补齐上节实际部署状态：`561457f1d1a4a731ad33a99ce02fc627ff3ac51b` 在 Server 二完成 Git clone/install/build，部署器于 11:09:25.251 UTC 记录 browser-worker 已替换、ready、Deployed；81 项相关检查在 Mini 通过。11:19:44 的 fleet 显示新 PID83772 正常轮询。尚未启动第四次 HMW 原生目录 scan，不能宣称真实目录验收通过。

用户要求先讨论原设计和如何修改。再次对照 `20b09db` skill 与旧 V3 接入后，纠正上节过度概括：完整旧 skill 的 runHarvest 确有枚举至零增长循环，但旧 V3 本来就将目录和单品分开，并对受支持的 Shopify 单目录提供 DOM / 目录结果 / 对应接口完整集合的一致性与空终页证明。因此，所有目录强制额外遍历并不等价于原样恢复旧 V3 的完成判据。

用户确认“确实复用旧机制比较好”。确定方向：共享旧 ENUMERATE 阶段和原契约，保留当前逐页证据与防提前结束修复；恢复旧 Shopify 有界集合对账校验，通过 Ego 原生操作取得原件；宿主按明确的证明类型核验，不维护两套枚举算法，不接回 CDP。详细设计为 `docs/spark/2026-10-02-dtc-legacy-catalog-reuse-design.md`。此方向尚未实施；CRAWLV3-170 保持 In Progress，旧 Review 和原件不改。

上一轮部署的五个其他渠道仍临时 paused。核验它们均无 queued/ready/running、无 held permit 后，于 11:20:05.881 UTC 按部署前快照恢复 Amazon/GNC/Swanson/Whole Foods/Costco 原 running 状态；DTC 保持 paused。Server 一保留 `after-dtc-catalog-fixpoint-deploy-restored.json`，没有投送新 DTC、重新入队或改写历史业务结果。

## 复用旧目录机制的实现（待 Mini 与真实验收）

用户明确要求开始处理后，将 runHarvest 的 ENUMERATE 阶段提取为 `catalog-enumeration.mjs`，旧 harvest 和 discoverCatalog 共用；原合同的稳定轮次、coverage、产品限制、预算回调及检查点保留，复核每轮重新完整遍历。新增真实旧 collector 的三页回归：第二轮前两页无变化、第三页出现新品，增长必须为 `[3,1,0]`，不能提前判稳。

旧 Shopify 对账算法提取到 `catalog-coverage.mjs`，供采集与宿主共用。Ego 原生 `captureShopifyCatalogCoverage` 按旧上限取得目录容器实际 DOM、HTML、截图及最多两页对应接口响应；每份响应先落盘后解析，失败也留存。只有页面集合、提交集合与接口完整集合相同且有空终页才通过，接口独有商品不纳入发现。宿主还核对保留 HTML 的目录链接、独立响应原件、source/seed 范围及平台身份；不接受手写计数。新目录证明类型区分 enumeration/shopify，旧普通目录证据默认 enumeration，不修改历史 Review。

首轮本地 132 项旧 collector/harvest 与新目录测试、19 项宿主/模式测试通过；补充原合同要求多个稳定轮次的拒绝检查。类型检查通过，全仓检查已修正复杂度、函数长度和非空断言问题后通过。尚未以该实现切换 Worker、启动新 HMW 目录或多规格任务；Mini 留存原件重放、构建和真实验收继续执行。

`6899b3b` 已 main 推送，Server 二 fresh Git clone 的 133 项 collector/harvest/原件重放和 20 项宿主检查全部通过，Worker 构建成功。原件重放读取 Solaray 第十轮 native-originals，先核对全部 receipt 大小/hash，在独立临时目录重新提取，不访问网站；规格、品牌、库存、字段和两张图片字节一致。11:37:15.867 UTC 正式部署完成，仅 browser-worker 切换；Server 一仍 bb8bb14。

11:37:39.286 UTC 新 HMW 目录 scan `dd93e125-5c07-4a01-82d2-0172623ebb5e`、request `60fd5a05-7d82-4530-96e0-e8146275a4b6` 受理，11:37:43.356 开始。资源含 dtc-brand-scan / mini-model-account / server2-ego-space-6；Codex PID97928，p108 / `A587EE68878FEFA6209F3B6E2BC0FE70`，workspace `f30288e08e2067f5c19e76de00b85b1a420a763fc364dd9515d6b17bf59032fd`。11:41 已进入原生机械脚本执行，尚未报告验收通过。其他原 running 空渠道已按部署前快照恢复，DTC 仍 paused。

## 原生单品被 pack 关键词提前排除（CRAWLV3-171）

多规格验收准备时，从 R2 重读既有 HMW Travel Pack HTML：`v3/dtc-html/product-9fd4d4ee-f43b-40aa-9e54-a7f44cace411/original.html`，475111 字节、SHA256 `0dc966e703b803bbfc1c78b897313db09fb617cde22ab43d2732571ef9d91135` 一致。实际 ProductGroup 为同一 Multivitamin & Mineral，网站提供 One Week Supply / 30 Day Supply、SKU012/022；未重抓网页。旧 runHarvest 的 URL 预筛选会仅凭 travel-pack 排除，新的纯测试复现 complete=0/excluded=1。

修复限定 Ego 宿主精确派发的 capture-only 单品：URL 范围和身份校验保留，原件采集不执行旧 pack/bundle/non-nutrition 关键词的采前筛选；保存完整资料后交现有下游判断。普通独立旧 harvest 继续原筛选规则，目录不因此直接采集商品。77 项 harvest/产品范围回归和全仓检查通过（另一个首次测试失败是 fixture HTML 少于既有 500 字符最低值，修正测试原件长度，未放松生产门槛）。该修复尚未部署，等待当前目录任务完成；155 的真实多规格验证仍待执行。

## 旧 Shopify 目录证明真实通过；开始原生多规格验收（11:50 UTC）

HMW 第四次目录 scan `dd93e125-5c07-4a01-82d2-0172623ebb5e` 于 11:43:30.827 UTC complete：full=true、1页、6个产品、入队6、missing=0、付费 credits=0。实际采用旧 Shopify 有界证明：`main` 容器的真实 DOM / 提交条目 / 对应接口均为同一6项，第二页接口原件为空；只有一轮目录观察，增长6、zeroGrowthRounds=0，未伪称普通枚举已收敛，也没有执行商品 harvest。

R2 `v3/dtc-agent/catalog-dd93e125-5c07-4a01-82d2-0172623ebb5e/archive.json` 的26份文件、4,253,322字节全部回读大小/SHA256一致。停止账本四项齐全：Codex PID97928进程组11:42:29.803 absent、精确p108目标11:42:30.198 absent、CLI97926已退出、round结束；许可 `permit-01a0fc67-e926-7116-a4af-12fabe7bff13-0` 于11:43:30.754释放，held=[]。CRAWLV3-170转Review；此结果不代表大目录分页/load-more、其他品牌或Worker强杀恢复已验收。

`210a1aaf36c4306ff4d92f4a35a5a200788ec0b6` 已main推送，Mini Git拉取后的78项harvest/范围/留存原件重放与3项模式检查全部通过。11:46:00.914 UTC经fresh clone/locked install/build部署Server二；Server一仍bb8bb14。DTC保持paused、queued=6，其他五个原running空渠道按部署前快照恢复。

HMW Travel Pack新的手动原生单品run `78cb3b78-f65f-41c0-9171-fdfee1dbeb0c` 于11:46:30.339受理。来源 `743aae55-33ee-4233-ba73-037c1b534af5`，网页 `/products/foundation-multiviatim-and-mineral-travel-pack`；模型PID2916、p109目标 `EAEC75AEB040B6EFA7C4052165E9DB07`，round `c30bf9f7-501d-451f-9ef7-c198c8c6907e`，原baseline页保持。11:50只读检查仍在采集页面结构，无业务终态，不能将保存网站规格视为所有规格均已完成后续处理。CRAWLV3-171与155保持In Progress。

## 多规格原件已保存，但字段采集路线偏差阻止验收（CRAWLV3-172）

上述单品保存1条记录、2张实际图库、网站两个规格（54311671398766/SKU012/One Week Supply/9.99/OutOfStock；54311689552238/SKU022/30 Day Supply/34.99/InStock）。描述却是`Your cart is empty`，基础price错误为推荐商品的$49.98。Codex采后返回needs_review / field_extraction_mixed_unrelated_content，PID2916于11:52:21.579停止；随后API查询工作流已结束、held=[]。R2逐件回读和精确页面停止账本尚待本轮复核，不能只凭无许可声称全部清理验收完成。

CRAWLV3-172已创建。用户质疑是否偏成机械提取后，暂停继续改代码，重新对照旧部署对应20b09db的skill、Shopify hooks和旧V3 prompt。旧设计确实包含机械执行，但动态站点/字段/图库判断由模型负责，脚本执行已验证的方法；Shopify可直接从真实商品数据获取title/body_html/variants等，浏览器补足页面证据。普通浏览器路径先视觉逐字段定位、再重放映射并验证、然后收割，失效局部重学。

本轮模型生成的run-capture.mjs没有复用旧Shopify字段extract hook，而将HTML送入applyDetailExtractionProfile；描述的后代/伪类CSS映射超出旧firstSelectorText正则模拟能力，静默落到通用全页fallback。采前检查仅检查非空和少量词，把购物车文本误判pass，直至采后模型复核才拦截。这是流程与实现共同的缺口，不能概括成仅缺一个CSS语法补丁，也不能宣称当前只是Chrome换Ego、旧采集方法已完整复用。下一步须先确认并恢复旧数据源选择、逐字段验证与执行分工；不为通过单个站点继续堆固定字段规则。本次质疑后未修改引擎、未部署或开启新测试。

用户随后明确“不能使用通用提取器”，要求修改前重新总结。172已追加此要求：原生DTC禁止通用全页字段提取及自动fallback；恢复模型观察并逐字段核验的站点方法、已验证profile的本轮复核、身份明确的平台商品数据映射。缺少有效方法时交回模型局部重新探索，不能自动走通用extract/upgrade；图片仍由实际完整图库决定，机械代码只执行明确的方法、IO、校验、归档和清理。规格来自网站，原件齐备后才进入既有后处理。此次仅记录设计边界，未修改引擎或上线。

## 172 实施与原件复核（12:29 UTC，部署前）

用户授权继续后，原生任务新增明确方法约束：缺少 hooks.extract 直接停止；通用 extract/upgrade/profile 及关键词 ingredients 路径在原生进程和嵌套 hooks 内拒绝。模型从已观察的唯一 DOM 节点或 JSON Pointer 取值，fieldEvidence 带原件路径/URL/hash；宿主按已归档的原件重放核对，缺失、歧义、字段被补写或原件变更均拒绝。prompt 与 skill 的原生章节同步要求实际内容核对，取消旧通用 profile 执行示例；单品方法只作为 candidate，不能晋升全站已验证方法。

当前渲染 DOM 的保存不导航，保留选中规格和展开状态；平台数据由模型确认后显式读取，失败原文也保留。引擎不再自动填品牌、库存、ingredients_text 或任意默认规格 SKU/价格，不按文件名给图片添加 Facts 排名，不虚构已搜索/展开的覆盖声明。旧规格规范化仍复用，基础商品保持所有规格数据；投影将 SKU、选项、价格、状态、图片 URL 和网站已有图片归属传给后续。多规格自动展开仍属155，未因元数据保留而宣称完成。

本地第一轮75项纯测试与25项宿主/品牌/模式测试通过；补充失败响应原件检查、两份Mini历史原件重放及全仓检查中，未部署、未开始新业务验收。新增Mini回归只读取已留存Solaray和HMW原件，在独立临时目录执行模型明确位置的方法；禁止网络，并比较所有规格和原图字节。其站点具体selector仅是历史测试fixture，不进入生产站点规则。

旧 HMW run `78cb3b78-f65f-41c0-9171-fdfee1dbeb0c` 的R2 manifest 36个文件、9,611,147字节全部回读，大小/SHA256一致。数据库查询 `product-run-78cb3b78-f65f-41c0-9171-fdfee1dbeb0c` 核实4项stop proof：Codex进程组11:52:21.579 absent、browser CLI退出、round结束、确切目标 `EAEC75AEB040B6EFA7C4052165E9DB07` 于11:52:21.984 absent；许可11:52:55.950释放。此前待核验事项已补齐。原Review及原件保持，DTC批量保持暂停。

`8bcd861` 已main推送。Server二 fresh Git checkout 的94项采集/原件重放及420项DTC/契约/label-plan检查通过（6项无外部fixture的检查跳过）。HMW重放正确读取描述且保持两个规格全部值；Solaray保持配料/用法/品牌/库存与两张原图，并保留描述后续完整段落。Worker构建失败：宿主校验模块为复用规格规范化导入整个run-harvest，间接将浏览器工具的fsevents原生依赖带入bundle。生产未切换。现将原有规格规范化原封不动提取为纯模块，由harvest与离线校验共享，继续Mini构建验证。

## 172 双 Mini 部署及新受控验收（12:36 UTC）

依赖隔离修复 `883ad5ccb78a64672224322b8655fb5829499deb` main推送后，Server二隔离checkout通过Git pull取得，94项采集/留存原件重放再次通过，Worker及workflow bundle构建成功。全仓检查和推送钩子通过。Server二12:33:36.192Z、Server一12:34:11.941Z正式部署完成：均fresh clone、locked install、在本机构建，配置job全部ready。Server一7个job与Server二browser-worker同步新版，以接收扩充的规格元数据契约；无数据库迁移或Temporal命令序列改动。

部署前保存 `manual-releases/dtc-native-20261002/before-dtc-observed-883ad5c-deploy.json`。其他渠道暂停请求初始返回draining但无ready/running和held permit，随后确认全部paused；DTC本来就paused，queued=6。部署后12:34:42各job ready、OCR4/4，12:35:04.272按快照恢复五个原running空渠道，保留 `after-dtc-observed-883ad5c-restored.json`，DTC仍暂停。

12:35:25.084手动受理一个新HMW基础商品验收，run/request `16ceca8b-35cc-473d-8377-fc1296d4d964`，workflow `product-run-16ceca8b-35cc-473d-8377-fc1296d4d964`。派发URL仍为Travel Pack，source `743aae55-33ee-4233-ba73-037c1b534af5`。Codex PID27353、p110/target `06E555D7291FCDC6EE9D99F0C32498F5`、round `524b0cbd-d74b-4859-bab8-a6b69fe62217`；workspace `c4ef3e955351b193e27122a1a0889f39eeb330e5a41d35856a2e832563c01a64`。12:36只读检查仍在原生Ego页面preflight，无业务终态。保持旧Review及原件，未开始6项批量。

## 172 首次真实新方法验收：字段正确，复核结构与库存交接仍失败

`16ceca8b-35cc-473d-8377-fc1296d4d964` 的模型12:40:50.242退出并报告complete，原生方法实际读取 `/product/title`、`vendor`、`body_html`，描述已是本商品完整原文，没有购物车内容；SKU012/9.99与SKU022/34.99完整保留在variants，基础商品未填价格/SKU；两张原图hash仍与历史原件一致。但 `capture-review.method` 错写为字段方法对象，宿主实际要求字符串，因此12:41:34.337工作流终态为业务Review：`PIPELINE.ACTIVITY_UNRESOLVED`，原因Zod `method expected string, received object`。不能将模型complete/Workflow COMPLETED算成通过。reviewId `pipeline-review-c4ef3e955351b193e27122a1a0889f39eeb330e5a41d35856a2e832563c01a64`。

另一个独立遗漏：Shopify `.json` 的variants未提供available，模型没有选择显式`offerSource`，所以本次两规格都缺少历史和网页已有的库存状态。本次提示把offerSource写为可选、不强制核查，是实现/说明缺口。继续172：由宿主实际Zod schema生成任务内capture-review.schema.json；明确字段方法对象与复核说明字符串分开；复核结构错误归类DTC.CAPTURE_EVIDENCE而非未解析Activity；平台库存缺失时强制指定状态来源，禁止静默丢失。

实际过程还包括采前计划误填oracle type=single_page_confirmed，校验拒绝后改为oracles=[]；首次修正重新读取了平台JSON，其时间性字段改变导致新hash与未覆盖的旧source文件不符，再次被source_hash拒绝。随后改为读取既有原件完成唯一一次正式harvest。所有版本原件保留；没有清空checkpoint或覆盖历史资料。后续指令将计划校验前移到获取原件之前，计划/方法修正复用原件，避免此类多余请求。

本轮39个R2文件共9,713,915字节全部回读大小/SHA256一致；四项stop proof齐备，精确p110目标12:40:50.729 absent、round12:40:50.949结束，API最终held=[]。旧Review保持，后续不自动重试；DTC6项批量仍暂停。

## 172 复核协议与库存来源补丁（885b96c）

`885b96c7fd5c581524506bd5bf766fafed8749ad` main推送，全仓检查通过。宿主与模型共用实际ReviewSchema生成的JSON schema，错误类型给出明确DTC.CAPTURE_EVIDENCE；平台JSON缺available时必须显式提供offerSource；方法对象改名observedMethod，避免误填到复核说明method字符串。补充await taskSpace、先validateHarvestPlan再取原件、修正计划复用已保存原件以及selectedVariantId记录真实页面选中状态的要求。

本地19项宿主/模式及24项库存/来源检查通过；Server二隔离checkout经Git pull后95项采集/两份历史原件重放和49项宿主检查通过，Worker构建成功。正式fresh clone/locked install/build部署：Server二12:49:44.324Z，Server一12:50:16.311Z；全部配置job ready。部署前已确认所有队列paused、无在途/held；12:50:37.323恢复五个原running空渠道，DTC仍paused/queued=6。前后快照在 `manual-releases/dtc-native-20261002/before-dtc-review-stock-885b96c-deploy.json` 和 `after-dtc-review-stock-885b96c-restored.json`。

12:50:58.052Z手动发起新HMW单品run/request `7725ee3e-611a-4110-92c7-fcd16fae0d71`，workspace `9a558d78a19688de3728bdd34a6f43820d8edddf227b39106cb8b00b57191179`。仅此一条受控验收，DTC批量仍暂停；业务结果待核实。

本轮Codex于12:55:16.668Z退出，原生采集和宿主字段复核通过，进入既有LabelWorkflow。实际保存1个基础商品、2个网站规格及2/2轮播图；标题/品牌/完整商品描述来自模型明确选择的Shopify字段，未使用通用提取器。SKU012/9.99/OutOfStock与SKU022/34.99/InStock均完整，库存由显式offerSource读取。基础商品未回填默认SKU/价格，复核method为字符串，selectedVariantId忠实记录页面当时的54311689552238而未改变任务身份。

R2 archive41份文件、9,375,010字节全部回读大小/SHA256通过。SQL核实4项stop proof：Codex35283进程组12:55:16.668Z absent；精确p111目标`10446BA95A7469ED5BF83BDB97967BF6`于12:55:17.073Z absent；round `f47c7f88-af20-4d04-869c-12e4a18a868f`结束、CLI35281退出；许可12:56:12.229Z释放。基线页面未动，DTC仍paused/queued=6。

后处理投影`v3/dtc-products/product-7725ee3e-611a-4110-92c7-fcd16fae0d71/projection.json`回读2763字节，SHA256 `bbba90bfe525ea91b80994de0e298eff8ffd95bcd1afdd041a90069f9e05edfe`。两个规格的SKU、options、price、availability/available完整到达后处理，2张图库均保留商品级null归属，不虚构逐规格关联。本次实际选择的是网页观察到的width=990地址，不能写成与上轮width=1800原图字节相同。原件采集通过仍不等于逐规格处理或完整业务成功；12:58检查LabelWorkflow仍在执行，155继续跟踪。

## 新原生采集与标签成功，标准化登记故障分票173

上述7725ee3e于12:59:56.566Z结束：标签业务`collected`，operation `label-fcfa330e47f84b950ea2f5f3347e63e6234e26299da7a9f180a0ad4fccb1e0e8`，recordHash `be72551f6ad58ccd07bf8b2a0302f73240d612b03898cdf90f053823bf7ddfa2`。标签使用的原图SHA256 `4f0d96d66c956d6980c43bfe08819cd09043f070648b62bdfbdf6e0cb85f1758`与本轮采集相同，19条营养行、6项Other ingredients已保存。仅基础商品的一份标签结果，不是两个规格均已独立处理；155保持未完成。

随后标准化返回`review / recordingPending=true / PIPELINE.ACTIVITY_UNRESOLVED`。新增CRAWLV3-173。R2 inputHash `8b4265ad8f2f0cc733bcd993a269113a24c9c1289db3e61e4c1725e936ba1841` 的原回答390字节、SHA256 `7c8bb9641941afc21f4cd4fd1687110a9f200b004094a9ded63c08cf3ae6afdb`按原解码器通过；record.json 1970字节、SHA256 `d47f2a7225f48f01f00d6e9d3c5cd7505539fc6707503267b34cf1ac29608954`也已保存，但数据库没有成功登记行。实际原因是EnrichmentTitleReader对无唯一规格显式赋值websiteVariant=undefined，严格JSON hash拒绝登记，同一字段又导致Review schema拒绝，遮蔽了原始错误。不是模型回答无效。

173修复只在来源处省略缺失属性，并清除可能遗留的旧规格字段，不放松JSON规则或任填默认规格。本地20项title-reader/service检查通过，新增Mini真实留存输入/投影/模型回答重放，验证JSONB往返hash及成功登记路径；不访问网站、不重新调用模型、不改旧workflow终态。当前未宣称该修复已部署。

另已向148补记原生内容完整性缺口：field-preview以capture-only为由未提取文本ingredients，缺少逐项存在/缺失/未检查证明；DOM明确节点的raw格式目前仍转纯文本，可能损失Facts表格结构（代码审计，尚未实站复现）。本轮172通过不替代148下方内容/展开/懒加载验收。
