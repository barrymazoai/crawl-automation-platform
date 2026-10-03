# DTC 通知请求中断采集（CRAWLV3-185）

## 当前进度：跨 CLI 丢失预加载已实证

用户回复“好了”后，Space 6 的只读状态为 user；按本次明确授权 claim 成功。
第二个失败分析 cdc9e58d… 经 `resources.verifyStop` 得到四项 stopped=true、
released=true；精确 p6 消失，原失败及未知来源空白页保留。回执为 Server 一
`manual-releases/dtc-native-20261002/notification185-first-fix-cleanup.json`。

2026-10-03 10:24Z 在 Server 二作两次独立 Ego CLI 实测，只导航 data URL：

- 第一次注册中性标记后导航，页面值为 `call-one`（10:24:11.892Z）。
- 第二次 CLI 读旧文档仍有该值，再次导航后变为 null（10:24:33.337Z）。
- p7 / target `76F7272873A7126EDAED664A0DACC9D2` 已关闭并验证消失。
- 原始回执在 Server 二 `manual-releases/notification185-46d33f9/probe-{one,two}.json`。

因此最初只在宿主开页阶段注册预加载不足。修正为宿主生成固定的
`browser-preparation.mjs`，每次实际 Ego 调用在观察/导航前执行：核对当前空间控制权
与精确任务页、为本次 CLI 注册定位/通知拒绝，并立即应用于现有文档；原始回执写入
任务目录并随采集证据归档。模块显式接收当前 CLI 的 taskSpace/listTaskSpaces，
不假设导入模块能读到调用方局部变量。产品固定 launcher 自动调用；站点分析、目录
及临时观察脚本使用同一模块。旧采集方法保持原样，不添加产品规则或解析。

策略版本为 `deny-each-ego-call/2`。静态检查与生成模块语法检查通过；修正后的
跨调用实测与新的站点分析尚待部署验证。下文保留第一版补丁及失败过程。

## 已确认的原因

Nature’s Truth 分析 `ec8a7bc7-397a-4230-adc9-67404b3c9975` 的原生 Ego 日志在
`task.listTabs` 返回 `A browser permission prompt for notifications has appeared`，
随后将 Space 6 交给用户。原有截图只包含网页内容和 Cookie 提示，不能证明通知提示现在
仍然显示；用户明确反馈未看见。原分析保持失败，任务页清理与资源许可恢复另记 150。

## 修复范围

原生 DTC 的 `EgoAgentPage` 已在导航前通过 `Page.addScriptToEvaluateOnNewDocument`
拒绝页面定位请求。本次在相同位置加入页面级通知拒绝，覆盖站点分析、目录和产品三种
模式。没有修改共享 Profile 权限，不接管空间，也不改变产品采集、变体或后续解析。

- `Notification.permission` / `requestPermission` 返回 `denied`，兼容旧回调与 Promise。
- `navigator.permissions.query({name: "notifications"})` 返回拒绝状态；其他查询沿用原实现。
- 页面 `PushManager.subscribe` 拒绝为 `NotAllowedError`，`permissionState` 返回 `denied`。
- 仅在宿主新建的任务页注册，随该页生命周期结束，不更新已有用户页。
- 执行元数据记录 `notificationPolicy: deny-task-page/1`，这是启用策略记录，不是实测证明。

沿用页面准备机制的原因：现有 Ego 集成已记录当前版本拒绝 `Browser.setPermission`；
本次不再尝试修改共享浏览器权限。已经出现的浏览器提示或用户控制仍须按规则停止。
此修复预防后续任务页的通知请求，不能解除本次已交给用户的 Space 6。

通知接口形态依据 [WHATWG Notifications 标准](https://notifications.spec.whatwg.org/#dom-notification-requestpermission)。

## 验证与待办

没有新增或运行单元测试。执行必要类型、格式、依赖及注入脚本语法检查。
实页验收尚待当前 Space 6 恢复控制后，在 Server 二进行：

1. 先完成旧执行的精确页面清理并核对许可释放，保留未知来源空白页。
2. 新任务页验证通知请求返回拒绝、权限查询一致、Push 请求被拒绝，空间保持 Agent 控制。
3. 重新导航后仍生效；实际站点目录和代表产品可读，关闭任务页并证明目标消失。
4. 区分代码检查、浏览器实测与完整 DTC 链路验收，不把未跑项目写成通过。

## 部署与本次恢复

实现提交 `46d33f901683ab116fe334600a635e5082b35fbc` 已推送 main，`pnpm check`
及注入脚本语法检查通过。Server 二按 Git fresh clone、锁定依赖和构建流程部署，
browser-worker 于 10:07:15Z ready。Server 一随后同样 fresh clone/build，通过现有
JobService 只切换 collection-api，另外六个 Worker 保持原运行版本；同时上线 158fbc1
对站点分析未清理许可的队列保护。

用户第一次确认后，`takeOverTaskSpace` 报旧任务已结束，需要 `claimTaskSpace`。
自动审批拒绝认领，要求对该状态重新确认；未绕过。用户再次明确授权后认领成功。
`resources.verifyStop` 对旧许可返回四项 stopped=true、released=true，未知来源空白页
保留。R2 的旧分析 archive.json 下 14 份文件（1,819,270 字节）全部回读、大小及 SHA-256
校验通过，原分析失败未改写。

新的明确授权实测分析 `cdc9e58d-083a-4ef6-8558-dd988d5f5a02` 于 10:08:30Z 开始。
Server 一证据目录：`manual-releases/dtc-native-20261002/notification185-*`；
Server 二部署记录：`manual-releases/notification185-46d33f9/deploy.log`。

## 首次补丁实测未通过

新分析保存首页后，在下一次 Ego 调用读到 `agentDelegatedToUser` 并停止。
本轮没有明确的 notifications 错误，控制权变化原因待核；不能仅凭此说通知再次弹出。
PID66941 于 10:10:56Z 退出，精确页 `E182F582D72378C9F129C8A26C61B0B0`
仍待清理，许可 `permit-01a1013c-9598-71e5-aa31-dd7ab3b73f56-0` 未释放。
修复后的 API 队列正确显示 paused / queued2 / running0 / cleanupPending1。

待验证的生命周期问题：宿主注册预加载的 CLI 会先退出，Codex 另开 CLI 导航；
[Chromium 实现](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/page_handler.cc)
把新文档脚本存放在 DevTools session state。Ego 各调用之间是否保留该会话，必须用两次
独立 CLI 的页面标记验证，不能凭注入注册成功就认定后续导航生效。

本轮失败的 14 份原件（2,141,545 字节）亦已从 R2 回读并核对大小及 SHA-256。
失败分析执行 `applySiteAnalysis(enqueue=true)` 实测返回 HTTP400 /
`SITE_ANALYSIS.NOT_APPLICABLE`，关联 tasks 为空，原两条品牌扫描仍暂停排队。
小范围跨调用验证尚待用户交还本轮 `agentDelegatedToUser` 空间；尚未执行，不算通过。
