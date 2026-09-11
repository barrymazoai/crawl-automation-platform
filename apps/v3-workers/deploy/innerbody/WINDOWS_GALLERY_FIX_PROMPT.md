# Windows Codex：更新 Innerbody 图库采集

请连续完成这次 DTC Worker 更新。代码只从现有 Git 仓库 main 拉取，复用本机凭据和专用 Chrome，不要求新版 ZIP 或重新上传凭据。部署根仍是 `D:\crawlv3-dtc-v2`，原生 Node 是 `D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe`；先核实实际路径。不要自行提交采集任务。

本次修复：逐张打开图库缩略图，等待标签大图加载并选入采集；关闭挡住下一张缩略图的大图预览，再打开下一张。官网实测 Supplement Facts 和另一张背标均能打开到 600×600。首次失败试单的隔离许可已经在 Mini 核验后释放，第二次试单已经结束；不要重新执行旧的首次试单恢复流程、修改旧 Review 或重放旧请求。

1. 在现有仓库确认分支、tracked 修改和 untracked 文件；保留用户文件，不 reset/clean。执行 `git pull --ff-only origin main`、`pnpm install --frozen-lockfile`、`pnpm --filter @crawl-automation/v3-workers build:dtc`。使用 Git 的 `apps/v3-workers/deploy/innerbody/deployment.json` 作为预期构建标识，不手工改成 Windows 自己算出的值。源码应包含 `galleryDismissControls` 和 `DTC.GALLERY_IMAGE_MISSING`。

2. 只读检查旧节点、任务页面账本和 USER-CONTROL/pauseFile。确认当前没有采集工作后，使用旧 release 正常停机：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

确认 supervisor 和三个 Worker 的精确 PID 均退出、会话及锁正常清除。只在停机完成后移除本次已完成的 STOP。停机或清理不确定时保留账本和会话，按 `DTC_WINDOWS.md` 恢复，不能删锁绕过。用户接管时不操作浏览器，报告 pending。不要杀 Chrome、重启现有专用实例或关闭其他标签页。

3. 在带时间戳的受限本地备份目录中保留旧 release、private 和 settings.private.json。将 `apps/v3-workers/dist/dtc-windows` 完整复制为新的 release，不混合新旧 JS。保留 inputs、证书、Chrome Profile、source-journal、browser-pages、source-cache、browser-model、历史日志及 R2 证据。运行 `npm --prefix "$dtcRoot\release" install --omit=dev`。

4. 本次只给已有 settings.private.json 的 site 增加 Git 中的 `galleryDismissControls`。先在内存比较旧 settings 的 scope、queueScope、site 其他字段与 Git；若不一致，报告具体非敏感差异，不猜测覆盖。新增值应是 `["#productModal > span.close"]`。保持其余配置、路径、Chrome instanceId、凭据完全不变，以备份后原子写入的方式保存，保持 NTFS 访问限制，不输出配置正文。若该字段已经与 Git 相同，不重复改写。本次无需重新运行首次安装用的 prepare-windows.mjs。

5. private 使用新建的空目录，由既有 settings 重新生成；不能向旧 private 覆盖写入。执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

核对 release 的 18 个 JS、Activity/Workflow build ID、三个 runtime.expectedBuildId 与 Git 全部匹配，private/dtc.json 的 site.galleryDismissControls 已生效。Workflow build ID 是全部 JS 加 product-workflows.cjs 的组合标识，不是单个 cjs 文件的 SHA-256。Mini 已同步相同构建；不得跳过校验。Windows 配置不能引入 database、resourceDatabase 或 baseLabel。

6. doctor 通过后，在本次独立日志目录中用 Start-Process 后台启动：

```powershell
$dtcLog = Join-Path $dtcRoot ('logs\gallery-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dtcLog | Out-Null
Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput (Join-Path $dtcLog 'stdout.log') `
  -RedirectStandardError (Join-Path $dtcLog 'stderr.log') `
  -PassThru
```

连续观察至少四个新健康采样：healthy=true，三个角色 ready，实际 PID 对应新 release，无重启循环，心跳持续更新。复查 CDP 仍仅监听 127.0.0.1，实例与配置匹配。

最后报告实际 Git commit、两个 build ID、配置更新及 routing/doctor 结果、三个 Worker 与 supervisor 的 PID、sessionId 和日志路径。凭据不输出、不上传 Git。节点保持后台运行，由主会话从正常 Brand 入口发起新的商品请求，验证两张标签图片下载、OCR 和页面关闭。不要声称尚未运行的业务验收已经通过。
