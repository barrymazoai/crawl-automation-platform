# DTC 通知请求中断采集（CRAWLV3-185）

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
