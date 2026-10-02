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

部署前所有队列自然暂停且无 held permit；部署后恢复原本 running 的 Amazon/GNC/Swanson/Whole Foods/Costco，DTC 批量队列保持 paused。配置和队列快照在两台机器各自的 `manual-releases/dtc-native-20261002/`，旧 PM2 配置由部署器留存。
