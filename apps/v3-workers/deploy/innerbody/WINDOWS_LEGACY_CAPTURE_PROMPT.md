# Windows Codex：把已部署 DTC Worker 更新为旧版完整采集执行器

连续完成这次更新。代码从现有 Git 仓库 main 拉取，复用现有凭据、专用 Chrome 和 `D:\crawlv3-dtc-v2`。不用新版凭据包，不重新部署数据库，不由 Windows 连接 Mini 业务库。禁止提交真实采集请求；启动后由主会话从 Brand 入口发新单。

此次代码复用旧 Browser Node 的完整 CodexProcessRunner、采集 prompt 和 crawl-products Skill。模型仍是 gpt-5.6-luna / medium。V3 负责调度、许可、证据交付及后续处理。采集已下载的原图直接交给 V3，不再打开网页重新下载。原图、HTML、全部 variants/SKU、站点方法 profile 均保留。目录与商品任务依然由 V3 分开调度。

1. 检查现有仓库状态，确认 main；保留 tracked 修改和全部 untracked 文件。没有 tracked 修改时执行 `git pull --ff-only origin main`。本次增加 .gitattributes 保证构建源码 LF；确认 tracked 干净后执行 `git -c core.autocrlf=false checkout-index --all --force`，重新写出同一 HEAD 的受跟踪源码，让已有 Windows checkout 也应用 LF。这个操作不得用在有用户 tracked 修改的工作区；此时使用新的独立本地 checkout 构建。不要 reset/clean。

2. `pnpm install --frozen-lockfile`，然后 `pnpm --filter @crawl-automation/v3-workers build:dtc`。读取 Git 中 `apps/v3-workers/deploy/innerbody/deployment.json`，核对源码包含 DtcLegacyCapture、DtcLegacyFileTransport 和 dtc-skill-integrity.js 的生成逻辑。按该 JSON 核对 JS 数量、Activity/Workflow build；不要沿用旧的“18 JS”或旧 build ID，也不要自行改预期 ID。Workflow build 是全部根目录 JS 加 product-workflows.cjs 的组合标识。

3. 检查旧节点没有正在采集的任务、没有 pending 页面账本和 USER-CONTROL。用旧 release 正常 stop：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

核对 supervisor 和三个 Worker 的精确 PID 退出、会话与锁清除，才处理本次完成的 STOP。不能删锁绕过检查。不要重启/杀 Chrome，不碰个人标签页。用户接管时报告 pending，不能接管浏览器清页。旧试单及 Review 不重放、不修改。

4. 在带时间戳且权限受限的备份目录保存 release、private、settings.private.json。新 release 必须完整替换为 `apps/v3-workers/dist/dtc-windows`，包括 **crawl-products 目录和 dtc-skill-integrity.js**；不要混用新旧文件。执行 `npm --prefix "$dtcRoot\release" install --omit=dev`，核对 playwright-core 可加载；不下载 Playwright 浏览器，使用已有专用 Chrome。Temporal 原生依赖在 Windows 本机安装。

5. 保留 inputs、证书、Chrome Profile、source-journal、browser-pages、source-cache、browser-model、日志及全部历史证据。先在内存核对现有 settings 的 scope、queueScope、site 与 Git 一致；不一致则报告非敏感差异。只更新现有 settings.codex 的两个非凭证字段：`runtimeProfileVersion="dtc-legacy-agent/1"`、`timeoutMs=900000`。保留 executable、codexHome、workRoot、disabledMcpServers、模型设置及所有其他路径/凭据。采用备份后原子写入，不输出配置正文。无需重跑首次安装的 prepare-windows.mjs。

6. private 改用新空目录，由现有 settings 生成，不覆盖旧文件：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

三个 runtime、两个 build ID、routing 及 Skill 文件完整性全部通过后才启动。Windows private/dtc.json 不能含 database、resourceDatabase、baseLabel。不要把 Codex 再改成 DOM-only 决策器或使用 bypass-approvals-and-sandbox。完整执行器沿用旧版 approve-for-me；遇到权限拒绝保留证据并报告。

7. 在新的日志目录以 Start-Process 后台启动：

```powershell
$dtcLog = Join-Path $dtcRoot ('logs\legacy-capture-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dtcLog | Out-Null
Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput (Join-Path $dtcLog 'stdout.log') `
  -RedirectStandardError (Join-Path $dtcLog 'stderr.log') `
  -PassThru
```

连续至少四个健康采样，确认 healthy=true、三个角色 ready、PID 属于新 release、心跳持续且无重启循环。CDP 仍仅监听 127.0.0.1，实例不变。

报告 Git commit、JS 数量、两个 build ID、Skill 完整性、routing/doctor 结果、supervisor/三个 Worker PID、sessionId、日志目录。节点保持后台运行。真实业务链及 Windows 取消/冷启动行为，未实测的不要声称已通过。凭据不输出、不上传 Git。
