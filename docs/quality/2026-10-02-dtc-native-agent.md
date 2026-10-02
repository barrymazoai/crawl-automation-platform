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

Server 二 `browser.dtcAgent`：旧 Codex 配置、Ego skill 绝对路径、共享 modelResourceId。持久 profile 在新 codex.workRoot/site-profiles；只按实际需要迁移方法文件，不搬历史证据缓存。
Server 一 API `brandScans.permits.dtc.additionalResources` 增加同一模型资源一单位；`pipeline.channels.dtc.resources.activities.captureProduct` 也同时需要浏览器和模型许可。所有开始操作必须由现有 API/ResourceGate 发起。

## 验证状态

本记录初稿：代码尚未部署。纯测试：22 项 worker 路由/品牌/采集检查，41 项 harvest/原生方法检查，7 项 R2/恢复检查通过。全仓 lint、依赖与重复代码检查已通过，类型检查进行中。

待 Mini 验证：进程成功/取消时子进程停止、Ego 真实原生调用、Codex 读取两个 skill、完整产品原图归档和下游读取、目录发现/耗尽、分析、页面与模型许可释放。Worker 被强杀后的 Codex 进程自动停止尚未实现；没有停止证明时不释放许可、不关闭仍可能使用中的页。

父验收 CRAWLV3-151；本次修改 CRAWLV3-163。服务器代码只能经 origin/main 的 fresh clone/build 部署，DTC 队列保持手动控制。
