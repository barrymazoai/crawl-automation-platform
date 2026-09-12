# Windows Codex：待审修复后的统一部署

把本文完整交给 Windows Codex 执行。代码从 main 获取，不需要新的凭据附件。

本次源码祖先：`072a916704e681f1c738f83e9082cd610ecc26ed`。

- JS：20 个。
- Activity build：`b5d3d4f19a93c93fa5004f8f2e66643c3427b71359a98670decac3b5de073d1b`。
- Workflow build：`a5156a8c2626549780df3fd487b73d4b3941e512bdd2491f0dfab0fc34ffe8b8`。

以上用于识别本次版本；以最新 main 的 deployment.json 为校验真源，不可绕过不匹配。

连续完成这次更新。代码从现有 Git 仓库 main 拉取，复用现有凭据、专用 Chrome 和 `D:\crawlv3-dtc-v2`。不用新版凭据包，不重新部署数据库，不由 Windows 连接 Mini 业务库。禁止提交真实采集请求；启动后由主会话从 Brand 入口发新单。

本次包含单张完整标签优先、同义成分归组、组合装单独跳过，以及泛化写入错误的诊断指令。仍使用旧版完整采集器和 gpt-5.6-luna / medium；采集范围为整个目录（site.selectedUrls=null），每个商品任务只处理当前商品并保存全部图库和规格。识别在 Mini 完成。Windows 写入诊断已完成，不必重做，不改 ACL 或审批模式。

主会话已于 2026-09-12 核实上次请求 294846ca-3c4d-4e56-9926-6bd2032c3d0e 全部商品子任务结束、没有遗留占用和来源锁；父任务原有 TIMED_OUT 记录保留。若本机出现新的在途任务，先等其正常结束，再切换。

1. 检查现有仓库状态，确认 main；保留 tracked 修改和全部 untracked 文件。没有 tracked 修改时执行 `git pull --ff-only origin main`。仓库已有 .gitattributes 保证构建源码 LF；确认 tracked 干净后执行 `git -c core.autocrlf=false checkout-index --all --force`，重新写出同一 HEAD 的受跟踪源码，让已有 Windows checkout 也应用 LF。这个操作不得用在有用户 tracked 修改的工作区；此时使用新的独立本地 checkout 构建。不要 reset/clean。

2. `pnpm install --frozen-lockfile`，然后 `pnpm --filter @crawl-automation/v3-workers build:dtc`。读取 Git 中 `apps/v3-workers/deploy/innerbody/deployment.json`，核对源码包含 DtcLegacyCapture、DtcLegacyFileTransport 和 dtc-skill-integrity.js 的生成逻辑。按该 JSON 核对 JS 数量、Activity/Workflow build；不要沿用旧的“18 JS”或旧 build ID，也不要自行改预期 ID。Workflow build 是全部根目录 JS 加 product-workflows.cjs 的组合标识。

3. Mini 更新期间已观察到旧 Windows 节点报告 dtc_node_stopped。先在本机核实 supervisor/三个 Worker 的精确 PID 是否已退出、session 和锁是否清除，以及没有 pending 页面账本和 USER-CONTROL。若已正常停止，不再创建 STOP 文件；若仍运行且没有在途任务，用旧 release 正常 stop：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

核对 supervisor 和三个 Worker 的精确 PID 退出、会话与锁清除，才处理本次完成的 STOP。不能删锁绕过检查。不要重启/杀 Chrome，不碰个人标签页。用户接管时报告 pending，不能接管浏览器清页。旧试单及 Review 不重放、不修改。

4. 在带时间戳且权限受限的备份目录保存 release、private、settings.private.json。新 release 必须完整替换为 `apps/v3-workers/dist/dtc-windows`，包括 **crawl-products 目录和 dtc-skill-integrity.js**；不要混用新旧文件。执行 `npm --prefix "$dtcRoot\release" install --omit=dev`，核对 playwright-core 可加载；不下载 Playwright 浏览器，使用已有专用 Chrome。Temporal 原生依赖在 Windows 本机安装。

5. 保留 inputs、证书、Chrome Profile、source-journal、browser-pages、source-cache、browser-model、日志及全部历史证据。先在内存核对现有 settings 的 scope、queueScope、site 与 Git 一致；不一致则报告非敏感差异。确认现有 settings.codex 的 `runtimeProfileVersion="dtc-legacy-agent/1"`、`timeoutMs=900000`，保持原值。确认 `settings.site.selectedUrls === null`。保留 executable、codexHome、workRoot、disabledMcpServers、模型设置及所有凭据。无需重跑首次安装的 prepare-windows.mjs。

   本次必须同步三个公开策略字段，不能只换 release：读取 settings.baseLive 指向的 JSON，复制为 inputs 下本次部署专用的新文件（如 channel.browser.review-日期时间.json），仅将 evidencePolicy、visionConfigFingerprint、sourceVisionConfigFingerprint 更新为 Git deployment.json.channelDefaults 中对应值。将 settings.baseLive 改为该新文件路径，备份后原子写入 settings；保留其他字段原值和原文件。新私有文件继承现有 inputs 的受限 NTFS 权限。预期 evidencePolicy=label-image-first/5，两个 vision 指纹均为 623632994ec3090b741c8e67fc1abb9962bcb8d38b04dc371ec4798075bedaba；最终以 Git 为准。不要输出配置正文或凭据。

6. private 改用新空目录，由现有 settings 生成，不覆盖旧文件：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

确认生成的 private/dtc.json 三个策略字段与 Git 一致。三个 runtime、两个 build ID、routing 及 Skill 文件完整性全部通过后才启动。Windows private/dtc.json 不能含 database、resourceDatabase、baseLabel。不要把 Codex 再改成 DOM-only 决策器或使用 bypass-approvals-and-sandbox。完整执行器沿用旧版 approve-for-me；遇到权限拒绝保留证据并报告。

7. 在新的日志目录以 Start-Process 后台启动：

```powershell
$dtcLog = Join-Path $dtcRoot ('logs\review-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dtcLog | Out-Null
Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput (Join-Path $dtcLog 'stdout.log') `
  -RedirectStandardError (Join-Path $dtcLog 'stderr.log') `
  -PassThru
```

连续至少四个健康采样，确认 healthy=true、三个角色 ready、PID 属于新 release、心跳持续且无重启循环。CDP 仍仅监听 127.0.0.1，实例不变。

报告三个策略字段的核对结果、Git commit、JS 数量、两个 build ID、Skill 完整性、routing/doctor 结果、supervisor/三个 Worker PID、sessionId、日志目录。节点保持后台运行。真实业务链及 Windows 取消/冷启动行为，未实测的不要声称已通过。凭据不输出、不上传 Git。

源码至少包含 deployment.json 中 commit 指定的祖先；使用最新 main 构建。以 deployment.json 的两个 build ID、20 个 JS 和 Skill 完整性为准。不要手动添加全局 CRAWL_WORKER_PRODUCT_URL；它由每个任务的宿主单独注入。不要自行重跑历史失败任务或释放 Mini 的隔离许可。
