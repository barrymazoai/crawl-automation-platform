# 给 Windows Codex：从 Git 部署 Innerbody DTC

请直接从已有 Git 仓库拉取 main，构建、配置并启动 Innerbody DTC 节点。部署代码、站点配置和辅助脚本全部使用 Git 中的文件，不要求用户搬运新版 release 或私有部署包。连续完成相关步骤；普通可逆操作无需重复确认。

本地凭据保留复用，不上传 GitHub、不输出正文。Windows 不连接数据库，不需要 Mini SSH 或数据库隧道。Mini 已有对应的 26 个后台 Worker；Windows 只运行目录、商品页和原图三个浏览器 Worker。

## 1. 拉代码并构建

在已有仓库确认当前分支和本地修改。保留用户修改、未跟踪采集文件与证据，不 reset/clean；正常情况在 main 执行：

```powershell
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @crawl-automation/v3-workers build:dtc
```

使用本机 Node 22.17+ / 24、pnpm 10.14.0。所有下面的仓库相对路径都从仓库根执行。部署配置位于 `apps/v3-workers/deploy/innerbody/deployment.json`，包含 Mini 匹配的构建标识、队列、真实来源和站点规则。文件中的 commit 是对应运行代码基线；后续只改部署文档/旁路脚本的提交不改变 release 的 JS 构建标识。

## 2. 复用本机配置和专用 Chrome

先检查 `D:\crawlv3-dtc`、`D:\crawlv3-dtc-v2` 的实际状态。保留旧配置、日志、浏览器 Profile 和采集证据。如果旧 supervisor / Worker 还在运行，使用对应节点的 stop 命令并确认退出，不能让两套 Worker 共用同一 Chrome，也不能按进程名批量终止 Node 或 Chrome。

优先复用本机已有 inputs 中的：

- `runtime.private.json`：Temporal 地址、namespace 和 mTLS 文件路径。
- `channel.private.json`：现有 R2 配置与凭据。新脚本只复制其中 R2 字段，丢弃旧数据库字段；来源/解析配置采用 Git 中已验证的版本。
- Temporal CA、客户端证书及客户端私钥：原绝对路径有效时直接复用，否则读取该 inputs 下 `certs/ca.pem`、`certs/worker.pem`、`certs/worker-key.pem`。

先检查这些文件是否确实存在，不要假定已转移。本地文件名称不同但内容对应时，可以在受限私有目录创建对应的输入副本，保持原文件。只核对字段是否齐全，不输出值。若确实不存在，只列出缺少的凭据/证书种类；这是首次凭据配置，不能要求重发整个部署包，也不能生成占位符。Git 中没有真实凭据。

复用之前的专用 Chrome：Profile `D:\crawlv3-dtc\chrome-profile`、CDP `http://127.0.0.1:9222/`。读取实时 `/json/version`，核对监听仅为 127.0.0.1；不依赖旧 PID，不重启正在使用的 Chrome，不修改个人主 Profile。若有未清理任务，先按原配置完成恢复，不能删日志绕过。

找到本机 Codex 安装实际的原生 `codex.exe`，使用当前部署用户已经登录的账号。不能把 `.cmd` 或 `.ps1` shim 当作 executable；不要输出 auth.json。保持交互式桌面会话。

## 3. 放置本机构建并准备配置

首次 V2 部署使用 `D:\crawlv3-dtc-v2`。在该目录为空/未运行、无待恢复节点和页面时，将本机构建的 `apps/v3-workers/dist/dtc-windows` **完整复制**为这个根下的 release，不能只合并部分 JS。已有部署先核实状态并保留旧 release/config 备份，不能直接覆盖运行中的目录。私有目录用 NTFS ACL 限制到部署账号、SYSTEM 和管理员。

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
# 这里替换为刚才现场确认的原生 codex.exe 路径及现有 inputs 目录。
$dtcCodexExe = '实际的codex.exe绝对路径'
$dtcInputs = 'D:\crawlv3-dtc\inputs'
$dtcCodexHome = Join-Path $env:USERPROFILE '.codex'

npm --prefix "$dtcRoot\release" install --omit=dev
node .\apps\v3-workers\deploy\innerbody\prepare-windows.mjs $dtcRoot $dtcCodexExe $dtcCodexHome $dtcInputs
node "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
node .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
node "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

辅助脚本从 Git 读取来源、站点和构建信息，从本机复用凭据，读取实时 Chrome instanceId 及 Codex MCP 名称，再生成配置。它不依赖 handoff.json、mini-routing.json 或 ZIP，也不打开任务网站或调用模型。

应看到 SETTINGS_PREPARED、CONFIG_PREPARED（Windows 3 角色）、ROUTING_MATCHED 和 DOCTOR_PASSED。doctor 会通过 Temporal 创建一条基础设施预检工作流，请 Mini 只读核验资源；不会提交品牌采集。生成配置应不含 database/resourceDatabase/baseLabel 依赖。

若构建标识与 Git 中的部署配置不匹配，保留日志并说明两端版本问题，不跳过校验、不要求用户提供新版包。Mini 需要和新的运行代码同步时，向主会话报告具体 commit/buildId。

配置生成拒绝覆盖不同内容。对已有运行/待恢复节点不要重新准备：先沿原配置正常停机或恢复，保留证据，再处理配置更新。此前仅填错本机路径且从未启动的配置可以备份后按真实值重新生成。

## 4. 启动和核验

全部检查通过后启动：

```powershell
$dtcNodeExe = (Get-Command node.exe).Source
$dtcProcess = Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput "$dtcRoot\supervisor.stdout.log" `
  -RedirectStandardError "$dtcRoot\supervisor.stderr.log" `
  -PassThru
```

持续观察至少三个采样周期：status.json 中 healthy=true，capture/catalog-source/file 全部 ready；真实 PID 和命令行对应新 release 的 dtc-browser-worker.js；nodeWorkflowId/sessionId 存在；没有反复退出重启。进程创建成功本身不代表部署成功。

正常停止命令：

```powershell
node "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

等待三个 Worker 和 supervisor 退出、Mini 会话关闭、锁文件清除；确认后再移除自己创建的 STOP。异常时保留 node-session.json、锁、页面日志与 R2；按 `apps/v3-workers/DTC_WINDOWS.md` 恢复，不强杀 Chrome，不删除证据绕过检查。

采集任务的页面须在浏览器阶段结束后关闭：先存截图/文本/原图，再关闭精确任务 target 并复查目标消失。成功、Review、失败、取消都有清理结果；用户接管保持 pending。OCR/标签使用已保存证据。

## 5. 报告

报告实际 Git commit、release buildId、doctor、三个角色 PID/ready/healthy、nodeWorkflowId/sessionId、日志路径，以及仍然缺失的具体项目。不要打印凭据。

本次目标是启动节点。已配置 Innerbody 目录及首个 Astaxanthin 规格；启动后将结果交回主会话，从正常 Brand 入口做真实采集验收。不直接调用 Activity、伪造数据库记录或自行批量采集。未跑真实商品时明确写“节点已就绪，真实采集待验收”。
