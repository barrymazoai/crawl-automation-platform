# Windows Codex：整站测试后的商品范围与退出证明修复

> 2026-09-12 阶段更新：当前先执行同目录的 `WINDOWS_WRITE_DIAGNOSTIC_PROMPT.md`，不要按本文立即部署。用户要求先检查 Testosterone 的实际写入问题，主会话根据结果完成修复后，再统一部署并开启下一轮。本版 main 已增加单图策略和组合装跳过记录；最终部署还需 Mini 应用 017 迁移，并同步新的识别指纹与 evidencePolicy。本文原有步骤不能直接代替该同步。

连续完成这次更新。代码从现有 Git 仓库 main 拉取，复用现有凭据、专用 Chrome 和 `D:\crawlv3-dtc-v2`。不用新版凭据包，不重新部署数据库，不由 Windows 连接 Mini 业务库。禁止提交真实采集请求；启动后由主会话从 Brand 入口发新单。

本次保持旧版完整采集器及 gpt-5.6-luna / medium，增加宿主给出的单商品范围：Shopify 即使枚举整个目录，runHarvest 也只处理当前派发的商品，保留其全部规格和图库。采集范围仍是整个目录（site.selectedUrls=null），各商品分别执行。另包含 Mini 的引用待审退出证明修复；内容待审继续保留，不把它改成成功。

开始停止旧节点前，必须确认 Mini 本次请求 294846ca-3c4d-4e56-9926-6bd2032c3d0e 的全部商品已结束。总任务 TIMED_OUT 不能代替商品子任务结束证明。若仍有任务运行，先完成代码构建准备，等待本批收尾再切换。

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

5. 保留 inputs、证书、Chrome Profile、source-journal、browser-pages、source-cache、browser-model、日志及全部历史证据。先在内存核对现有 settings 的 scope、queueScope、site 与 Git 一致；不一致则报告非敏感差异。确认现有 settings.codex 的 `runtimeProfileVersion="dtc-legacy-agent/1"`、`timeoutMs=900000`，保持原值。确认 `settings.site.selectedUrls === null`。保留 executable、codexHome、workRoot、disabledMcpServers、模型设置及所有其他路径/凭据。采用备份后原子写入，不输出配置正文。无需重跑首次安装的 prepare-windows.mjs。

6. private 改用新空目录，由现有 settings 生成，不覆盖旧文件：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

三个 runtime、两个 build ID、routing 及 Skill 文件完整性全部通过后才启动。Windows private/dtc.json 不能含 database、resourceDatabase、baseLabel。不要把 Codex 再改成 DOM-only 决策器或使用 bypass-approvals-and-sandbox。完整执行器沿用旧版 approve-for-me；遇到权限拒绝保留证据并报告。

7. 在新的日志目录以 Start-Process 后台启动：

```powershell
$dtcLog = Join-Path $dtcRoot ('logs\full-catalog-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
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

源码至少包含 deployment.json 中 commit 指定的祖先；使用最新 main 构建。以 deployment.json 的两个 build ID、20 个 JS 和 Skill 完整性为准。不要手动添加全局 CRAWL_WORKER_PRODUCT_URL；它由每个任务的宿主单独注入。不要自行重跑历史失败任务或释放 Mini 的隔离许可。

本轮 Testosterone Support 的采集代理曾报告 `filesystem_write_permission_required`。更新时在 Windows 本地核对该任务目录的权限、启动参数与日志，区分“实际写入被拒绝”和“代理只读完说明就自行停止”。只回报是否发生写入尝试、非敏感错误码和证据路径，不发送凭据或整段执行日志。普通 Node 的写入检查不等于 Codex 子会话有写权限。若确有权限边界，沿用已有审批机制；不能增加 bypass 参数、关闭 sandbox 或修改全局安全策略。本次部署检查不能冒充该商品已经补采成功。
