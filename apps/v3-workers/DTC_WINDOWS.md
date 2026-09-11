# Windows DTC 节点：代码交付与部署

本包是 Crawler V3 DTC 的独立增量。Windows 只运行 `dtc-catalog-source`、`dtc-capture`、`dtc-file` 三个浏览器 Activity Worker；Mini 运行 26 个控制、Workflow、计划及标签处理 Worker。不替换旧 `apps/browser-node`，不修改其控制平面，不把 OCR 或标签模型塞进浏览器节点。新队列使用同一个独立 `dtc-*` queueScope。

**交付状态：代码和测试交付；Windows 原生依赖、Codex 登录、专用 Chrome、现场网络及真实 DTC 商品尚待部署验收。不能据此把 Plane #35/#39 标为真实验收完成。**

## 行为与边界

- Codex 读取有界的公开 DOM 快照，决定选择哪些已观察到的标题、文本、商品链接和图片，以及是否点击显式允许的图库控件。模型只返回节点编号；不能返回脚本、创建任意网址或接触浏览器凭据。截图保存为证据，目前**不作为模型图片输入**。
- 这是配置站点范围的首版适配器，不宣称任意 DTC 网站开箱即用。每个品牌必须配置唯一的目录/产品根选择器、商品路径、图片来源和图库控件。模型不解验证码；挑战或用户接管停止自动操作，页面关闭状态保留 pending。
- 目录读取总预算 90 秒、产品读取总预算 240 秒，均在 Activity 时限前停止并进入关闭流程。目录最多 10 个显式页面；下一页必须在当前公开导航中观察到。产品为 selected URL，URL 查询参数保留，片段去除；不宣称全部变体、完整目录或图片全集。Review 保持被动，无自动重抓。
- 任务创建带随机标记的独立页面，持久化意图后才打开，精确记录 target ID；恢复也不按域名猜测。通过 `Target.getTargets` 识别任务弹窗后代。
- 原图在同一页面浏览器网络中获取，遵守 CORS，不切换代理、不绕过站点登录或挑战。单图上限 4 MiB，保存原始字节；无法验证则 Review。
- 保存截图、DOM、模型选择、投影及原图后，关闭任务页面并只读复查目标消失。目录先关闭再出 ready；产品保留到最后一张原图保存，随后关闭、释放浏览器许可、封闭流式输入。OCR/文本/视觉使用 R2 留存证据。
- 成功、Review、失败、取消均有关闭路径。用户接管禁止自动关闭；未知结果保留许可与日志。关闭回执不能代替目标消失检查。

## 安装前准备

两台机器均把**同一份完整 release 目录**放在新部署根内，例如 Windows `D:\crawlv3-dtc\release`，Mini `/Users/barry/apps/crawlv3-dtc/release`。不要复制 macOS node_modules 到 Windows，不要在 release 中随意增删 `.js`（会改变 build ID）。使用 Node.js 22.16+ 或 24，目标机运行 `npm install --omit=dev`，确认 Temporal 原生模块能加载。本包的依赖版本来自构建机已安装版本。

Windows 需要当前用户自己的 Codex 登录及可执行文件；保持交互式桌面会话。使用专用 Chrome Profile，并由部署者开启**仅 127.0.0.1** 的 CDP 端口。勿给已有个人 Chrome 主 Profile 增加调试端口。节点不会启动或终止浏览器。

`http://127.0.0.1:9222/json/version` 的 `webSocketDebuggerUrl` 尾段就是 `browser.instanceId`。重启 Chrome 会变更实例 ID；不要直接改旧任务日志或删除证据来跨实例恢复。

两端必须连接同一 Temporal namespace、同一业务/资源库、同一新 R2 prefix。沿用现有全局模型账号和 OCR 资源编号；**不得为同一账号另建一份额度**。Windows supervisor 仅管理自己的独占浏览器资源，容量为 1。Mini 的新标签角色继续从原全局资源表领取额度。

将现有已验证渠道的以下三个私有 JSON 安全复制到目标机私有目录（不放入 release、不提交 Git）：

1. 一个 mTLS Worker runtime，证书路径改为该机器真实路径。
2. 对应渠道的完整 `*.private.json`（含 sourceText、labelText、OCR、vision 指纹及资源配置）。
3. **同一渠道**的完整 label 私有配置（含 Codex 与 OCR provider）；Mini 路径必须有效。Windows 只用其配置准备，不运行标签 provider。

Windows 的私有目录通过 NTFS ACL 限制到部署账号；不要放共享可写目录。Mini 私有 JSON 使用 chmod 600、目录 chmod 700。生成器不迁移数据库、不新建品牌、不启用来源、不替换现有 Web 路由，也不启动工作流。

## 生成配置

复制并填写 `settings.example.json`。Windows 使用 `target=windows`；Mini 使用 `target=mini`。两份保持 scope、site、queueScope、evidencePrefix、browserResource、browserModelResource 一致；路径和 runtime 证书各自本地化。Mini 的 browser.pauseFile 只作为未使用浏览器配置的本地合法路径；实际控制以 Windows 配置为准。`scope` 必须取自现有 V3 DTC 来源的真实已启用 revision，不能凭空编 ID。

```powershell
cd D:\crawlv3-dtc\release
npm install --omit=dev
node .\dtc-prepare.js D:\crawlv3-dtc\settings.private.json
node .\dtc-node.js doctor D:\crawlv3-dtc\private\node.json
```

Mini 同样安装依赖并执行 `node ./dtc-prepare.js /绝对路径/settings.private.json`。生成 Windows 三个 runtime、Mini 26 个 runtime、各自私有配置、`routing.json`；生成器拒绝覆盖不同内容的既有配置。

先在 Mini 启动这个新目录的 `deployment-supervisor.js <生成的 private/deployment.json>`，检查新目录 status.json 的 26 个角色全部 ready。现有 90 个常驻角色保持原部署，不合并、不切换其 manifest。再启动 Windows：

```powershell
node .\dtc-node.js start D:\crawlv3-dtc\private\node.json
```

`doctor` 只读检查：固定 Chrome 实例、未清理的页面记录、Codex 环境、Temporal namespace 和原生 SDK、模型资源存在、R2 读取。它不调用模型推理、不打开站点、不提交任务。`start` 再次执行 doctor，并在已有 STOP 文件时拒绝启动。

Windows `status.json` 必须三个角色 ready、healthy=true。两端 `private/routing.json` 队列必须一致。最后把现有 Web DTC delivery target 的 **taskQueue** 配置为 `routing.json.brandTarget.taskQueue`，保留其其余连接/身份字段；通过正常 Brand 入口提交一个配置内的商品试单。此前不能据进程存在宣称端到端通了。

## 停止、暂停与恢复

```powershell
node .\dtc-node.js stop D:\crawlv3-dtc\private\node.json
```

这是 STOP 请求；父进程先撤销新浏览器准入，再通过 IPC 通知精确的三个子进程优雅退出。核对进程已退出和 status/log；不强杀整个浏览器，也不自动重新拉起失败 Worker。正常关闭后才移除 supervisor.lock。确认全部退出后才删除自己创建的 STOP 文件，以允许下一次启动。

在配置的 `browser.pauseFile` 创建空文件可明确交还用户控制；所有浏览器动作包括 cleanup 均拒绝继续。只有用户交回控制且移除该文件后，才能恢复。

崩溃时保留 `browser-pages`、全部 R2、私有配置、日志、health/status 和 supervisor.lock。先暂停来源，核对 lock PID 与三个 health PID 均已退出；如 lock 遗留，**把该 lock 重命名留证**。不要删整个目录、清 Profile、关闭其他窗口或凭域名批量清理。

```powershell
node .\dtc-recover.js D:\crawlv3-dtc\private\node.json
```

恢复命令独占 supervisor.lock，检查三个旧 Worker PID 不存在，核对页面绑定的 Temporal run 已终止，只关闭记录的目标及其后代并复查消失，写 R2 恢复证据。工作流仍运行、实例改变、用户接管、身份不明时拒绝。失败保留 lock，继续人工检查。**页面关闭证明不等于模型执行停止证明，恢复命令不释放隔离的资源许可。**许可恢复仍走已有资源证据流程。

## 现场验收

先单个 selected URL，再扩目录范围。检查：Windows 网络下抓到公开页面 → R2 有截图/DOM/选择/投影与原图 → Mini 接收 plan/文件流并执行 OCR/标签 → Saved 或终态 Review → 任务 target 和弹窗不在清单中，原用户页面仍在。再验失败、取消、用户接管、Worker 异常退出恢复；最后确认没有新增重试/重复记录、旧 Review 与 R2 未改动。用户接管保留 pending 是预期结果。

## 源码构建与验证证据

源码构建：`pnpm --filter @crawl-automation/v3-workers build:dtc`。产物位于 `apps/v3-workers/dist/dtc-windows`；测试产物是相邻的 `dtc-windows-tests`。测试包必须同步到 Mac mini 执行，勿在 MacBook 运行浏览器/provider/integration 测试。

2026-09-11 最终验证：MacBook TypeScript 检查/构建通过；Mini 13 个测试文件共 109 项通过（DTC 44 项、旧渠道 65 项），含有界 HTTP/WebSocket CDP 协议 fixture、原图字节保真、用户控制、取消/失败/冷恢复、DTC 及原渠道两组真实本地 Temporal 流水与共 12 份历史重放。模型、OCR、真实站点调用均为 0；不能将 fixture 的处理计数解释为实际付费调用。Mini 另验证三个 CLI 入口拒绝缺失参数、26 个角色构建匹配与配置生成幂等。Windows 真机验收仍待部署。

完整报告：仓库 `docs/quality/2026-09-11-dtc-windows-code.md`；原始测试证明在相邻 `evidence/2026-09-11-dtc-windows/`。上述是源端验收记录；Git 发布状态以仓库提交为准。尚未替换现有部署、未修改历史 R2/Review。

## 从 Git 部署

确认本地修改已妥善保留后，拉取远端 `main`。仓库使用 Node.js 22.17+ 和 pnpm 10.14.0。在仓库根目录安装**完整工作区**依赖，再构建 DTC；Worker 有对 V3 API 源码的直接引用，仅安装 Worker 的过滤依赖不足以构建。

```powershell
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @crawl-automation/v3-workers build:dtc
```

发布前已将暂存源码导出到干净目录，使用锁文件重新安装依赖，DTC 构建及 V3 live 界面构建均通过。这不代替 Windows 原生环境和真实站点的现场验收。
