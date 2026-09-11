# Windows DTC 节点：代码交付与部署

Innerbody 的当前部署入口：[Windows Codex 执行说明](deploy/innerbody/WINDOWS_CODEX_PROMPT.md)。代码、站点配置和部署辅助脚本统一从 Git 获取；复用目标机私有凭据，无需搬运新版 release 包。

本包是 Crawler V3 DTC 的独立增量。Windows 只运行 `dtc-catalog-source`、`dtc-capture`、`dtc-file` 三个浏览器 Activity Worker；Mini 运行 26 个控制、Workflow、计划及标签处理 Worker。不替换旧 `apps/browser-node`，不修改其控制平面，不把 OCR 或标签模型塞进浏览器节点。新队列使用同一个独立 `dtc-*` queueScope。

**交付状态：代码和测试交付；Windows 原生依赖、Codex 登录、专用 Chrome、现场网络及真实 DTC 商品尚待部署验收。不能据此把 Plane #35/#39 标为真实验收完成。**

## 行为与边界

- Codex 读取有界的公开 DOM 快照，决定选择哪些已观察到的标题、文本、商品链接和图片，以及是否点击显式允许的图库控件。模型只返回节点编号；不能返回脚本、创建任意网址或接触浏览器凭据。截图保存为证据，目前**不作为模型图片输入**。
- 这是配置站点范围的首版适配器，不宣称任意 DTC 网站开箱即用。每个品牌必须配置唯一的目录/产品根选择器、商品路径、图片来源和图库控件。模型不解验证码；挑战或用户接管停止自动操作，页面关闭状态保留 pending。
- 目录读取总预算 90 秒、产品读取总预算 240 秒，均在 Activity 时限前停止并进入关闭流程。目录最多 10 个显式页面；下一页必须在当前公开导航中观察到。产品为 selected URL，URL 查询参数保留，片段去除；不宣称全部变体、完整目录或图片全集。Review 保持被动，无自动重抓。
- 若官网从目录的无查询参数商品链接自动跳到默认规格，先现场核实最终 URL，再将该完整 URL 配为 `selectedUrls`。目录只允许把同源、同路径的无查询参数商品链接关联到这些明确配置的 URL；已带规格参数的目录链接仍须完全匹配。规格查询参数保留在商品身份中，原始目录证据和选择策略均留存，不自动猜规格。
- 任务创建带随机标记的独立页面，持久化意图后才打开，精确记录 target ID；恢复也不按域名猜测。通过 `Target.getTargets` 识别任务弹窗后代。
- 原图在同一页面浏览器网络中获取，遵守 CORS，不切换代理、不绕过站点登录或挑战。单图上限 4 MiB，保存原始字节；无法验证则 Review。
- 保存截图、DOM、模型选择、投影及原图后，关闭任务页面并只读复查目标消失。目录先关闭再出 ready；产品保留到最后一张原图保存，随后关闭、释放浏览器许可、封闭流式输入。OCR/文本/视觉使用 R2 留存证据。
- 成功、Review、失败、取消均有关闭路径。用户接管禁止自动关闭；未知结果保留许可与日志。关闭回执不能代替目标消失检查。

## 安装前准备

两台机器均把**同一份完整 release 目录**放在新部署根内，例如 Windows `D:\crawlv3-dtc\release`，Mini `/Users/barry/apps/crawlv3-dtc/release`。不要复制 macOS node_modules 到 Windows，不要在 release 中随意增删 `.js`（会改变 build ID）。使用 Node.js 22.16+ 或 24，目标机运行 `npm install --omit=dev`，确认 Temporal 原生模块能加载。本包的依赖版本来自构建机已安装版本。

Windows 需要当前用户自己的 Codex 登录及可执行文件；保持交互式桌面会话。使用专用 Chrome Profile，并由部署者开启**仅 127.0.0.1** 的 CDP 端口。勿给已有个人 Chrome 主 Profile 增加调试端口。节点不会启动或终止浏览器。

`http://127.0.0.1:9222/json/version` 的 `webSocketDebuggerUrl` 尾段就是 `browser.instanceId`。重启 Chrome 会变更实例 ID；不要直接改旧任务日志或删除证据来跨实例恢复。

两端连接同一 Temporal namespace、同一新 R2 prefix。**Windows 不连接数据库、不需要数据库凭据、Mini SSH 或数据库隧道。**业务库和资源记录仅由 Mini 访问；沿用已有数据库，不新增数据库。沿用现有全局模型账号和 OCR 资源编号；**不得为同一账号另建一份额度**。Windows supervisor 仅管理自己的独占浏览器资源，容量为 1。Mini 的新标签角色继续从原全局资源表领取额度。

Windows 只接收 mTLS runtime/证书，以及经过字段筛选的浏览器私有配置（R2 凭据和已验证的来源/解析参数）。配置中出现 `database` 或 `resourceDatabase` 会直接拒绝；不要把旧渠道完整配置复制到 Windows。Windows 无需 `baseLabel`。

Mini 的 `baseLive` 继续引用现有完整渠道配置，`baseLabel` 引用同渠道的标签私有配置（Codex 和 OCR provider）。这些文件留在 Mini。26 个角色指 26 个各有分工的后台 Worker 进程，不是 26 台机器。

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

`doctor` 检查固定 Chrome 实例、待清理页面、Codex 环境、Temporal namespace/原生 SDK 和 R2 读取，并通过一个 `DtcNodePreflightWorkflow` 请 Mini 只读核验已有资源。它会创建这条基础设施检查工作流，不提交业务采集、不调用模型推理、不打开站点。`start` 再次执行 doctor，并在已有 STOP 文件时拒绝启动。

Windows `status.json` 必须三个角色 ready、healthy=true。两端 `private/routing.json` 队列必须一致。最后把现有 Web DTC delivery target 的 **taskQueue** 配置为 `routing.json.brandTarget.taskQueue`，保留其其余连接/身份字段；通过正常 Brand 入口提交一个配置内的商品试单。此前不能据进程存在宣称端到端通了。

## 停止、暂停与恢复

```powershell
node .\dtc-node.js stop D:\crawlv3-dtc\private\node.json
```

这是 STOP 请求；父进程先撤销新浏览器准入，再通过 IPC 通知精确的三个子进程优雅退出。核对进程已退出和 status/log；不强杀整个浏览器，也不自动重新拉起失败 Worker。Mini 确认节点会话关闭、三个子进程退出后才移除 supervisor.lock 和 node-session.json。确认全部退出后才删除自己创建的 STOP 文件，以允许下一次启动。

在配置的 `browser.pauseFile` 创建空文件可明确交还用户控制；所有浏览器动作包括 cleanup 均拒绝继续。只有用户交回控制且移除该文件后，才能恢复。

崩溃时保留 `browser-pages`、全部 R2、私有配置、日志、health/status 和 supervisor.lock。先暂停来源，核对 lock PID 与三个 health PID 均已退出；如 lock 遗留，**把该 lock 重命名留证**。不要删整个目录、清 Profile、关闭其他窗口或凭域名批量清理。

```powershell
node .\dtc-recover.js D:\crawlv3-dtc\private\node.json
```

恢复命令独占 supervisor.lock，检查三个旧 Worker PID 不存在，核对页面绑定的 Temporal run 已终止，只关闭记录的目标及其后代并复查消失，写 R2 恢复证据。它还核对 node-session.json 的 supervisor/Worker PID 全部退出，通过 Temporal 关闭该节点会话；未知启动状态保留记录。工作流仍运行、实例改变、用户接管、身份不明时拒绝。失败保留 lock，继续人工检查。**页面关闭证明不等于模型执行停止证明，恢复命令不释放隔离的资源许可。**许可恢复仍走已有资源证据流程。

## 现场验收

先单个 selected URL，再扩目录范围。检查：Windows 网络下抓到公开页面 → R2 有截图/DOM/选择/投影与原图 → Mini 接收 plan/文件流并执行 OCR/标签 → Saved 或终态 Review → 任务 target 和弹窗不在清单中，原用户页面仍在。再验失败、取消、用户接管、Worker 异常退出恢复；最后确认没有新增重试/重复记录、旧 Review 与 R2 未改动。用户接管保留 pending 是预期结果。

## 两端通信

Windows 三个浏览器 Worker 使用独立入口 `dtc-browser-worker.js`，兼容版本 `dtc-live-v2`。Mini 的 `dtc-live-worker.js` 只提供控制、目录记录、产品输入和 Review 角色。构建会检查 Windows 入口的整个导入图，发现 PostgreSQL 客户端或 Mini Worker 引用即失败。

浏览器 Activity 用当前 workflowId/runId 向拥有它的工作流发送 `dtcBrowserControl` Update；工作流转给 Mini 做任务身份、已有资源许可和文件计划核验。请求只允许具体采集动作及绑定的 Review 记录，没有 SQL 或任意数据库操作接口。任务额度的含义是控制同一浏览器/模型账号的并发，仍由 Mini 统一管理。

Windows supervisor 通过 `DtcNodeSessionWorkflow` 上报浏览器、磁盘和三个 Worker 的就绪状态。Mini 将记录有效期设置为 20 秒；停止或失联后不再准入新任务。旧会话不能覆盖新会话；停止会话不会释放未查清的任务许可。会话定期 Continue-As-New，避免历史无限增长。异常退出必须通过现有证据恢复流程处理，不能删除锁强行重启。

## 源码构建与验证证据

源码构建：`pnpm --filter @crawl-automation/v3-workers build:dtc`。产物为 `apps/v3-workers/dist/dtc-windows`，测试产物为相邻 `dtc-windows-tests`。TypeScript/构建可在 MacBook 执行；浏览器/provider/integration 测试只在 Mac mini 运行。

旧版测试记录见 `docs/quality/2026-09-11-dtc-windows-code.md`。V2 改动增加 Windows 配置边界、Mini 节点会话和分机队列通信测试；Windows 实机与真实网站采集仍需现场验收。

## 从 Git 部署

确认本地修改已妥善保留后，拉取远端 `main`。仓库使用 Node.js 22.17+ 和 pnpm 10.14.0。在仓库根目录安装**完整工作区**依赖，再构建 DTC；Worker 有对 V3 API 源码的直接引用，仅安装 Worker 的过滤依赖不足以构建。

```powershell
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @crawl-automation/v3-workers build:dtc
```

发布前已将暂存源码导出到干净目录，使用锁文件重新安装依赖，DTC 构建及 V3 live 界面构建均通过。这不代替 Windows 原生环境和真实站点的现场验收。
