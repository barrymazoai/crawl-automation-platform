# DTC Windows / Mini 职责修正

Windows 原先复用了 Mini 的完整 Worker 入口，导致启动和浏览器 Activity 都需要数据库配置。现在 Windows 使用独立的 `dtc-browser-worker.js`，只执行目录、商品页、原图采集、R2 证据保存和任务页面关闭；业务校验、Review 登记、资源准入及节点状态入库留在 Mini。沿用现有数据库，没有新建数据库或 Windows 数据库隧道。

## 实现

- Windows 配置严格拒绝 `database` / `resourceDatabase`，不再读取 `baseLabel`。构建验证 Windows Worker、supervisor、恢复入口的导入图不加载 PostgreSQL 或 Mini Worker。
- 当前浏览器 Activity 向所属 workflowId/runId 发出有限的 Temporal Update，Mini 核验来源、任务、持有的许可及留存文件计划。没有 SQL 或任意数据库操作接口。
- 新路由兼容标记为 `dtc-live-v2`，新产品/目录 Workflow 包装器保留旧版历史行为。控制 Update 在失败/取消收尾期间可完成；目录 Continue-As-New 后仍保留路由。
- Windows 通过 Temporal 上报本机状态。Mini 记录 20 秒有效期、独占节点会话和递增报告序号；停止旧会话不能改变新会话。会话定期 Continue-As-New。
- 正常停止先停止新准入，等待三个 Worker 退出，再确认节点会话结束。异常记录保留供显式恢复；不会自动释放隔离的任务许可，也不会强杀 Chrome。
- 页面仍按任务目标精确关闭并复查；用户接管继续保留 pending。原图保存完毕后关闭页面，OCR/标签使用留存证据。

## 验证

MacBook 只执行 TypeScript 检查与源码构建，均通过。Mac mini 的 14 个测试文件合计 116 项通过：原渠道回归、DTC 目录/原图/页面生命周期、配置拒绝、节点会话及分开队列的浏览器与 Mini 通信。DTC 流水覆盖旧版和 V2 各自的成功、文件失败、取消；退出客户端及目录 Continue-As-New 经过真实本地 Temporal 服务验证。

合计 21 份历史重放通过：原渠道 6、DTC 两版 12、节点会话 1、目录两次执行 2。测试使用浏览器/provider fixture，真实浏览器与付费 provider 调用均为 0。首次新增配置测试暴露两项 fixture 格式错误；修正后补测通过。最终通信客户端调整后重新运行相关测试，通过。

最终构建：18 个 JS；activityBuild `4aefac185c12264127f7c956dfa149731d28805a3b9366361f527076142bfa47`；workflowBuild `7ab2b9a92b2b3a623508493ca2e613c3fce3228916ba796b170478aa5c96854c`。

Mini 的实际 Temporal 预检另行验证，未提交真实品牌采集。Windows 的本地 doctor、三个 Worker 稳定启动及真实 Innerbody 商品采集，需要 Windows 现场验收，不能用 Mini fixture 代替。

## 交付

私有包单独传给用户，包含 Temporal mTLS 文件、R2 凭据、Innerbody 来源配置、完整 release 和 Windows 部署 Prompt；不进入 Git。Windows 使用新的 `D:\crawlv3-dtc-v2`，保留旧目录证据。旧的数据库/SSH 交付包废弃；本次未安装 SSH key、未改变数据库访问授权。
