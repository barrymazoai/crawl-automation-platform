# Windows Codex：切换到 Bella Grace wellness 目录

请实际完成这次更新、换站配置和后台启动，持续执行到验收完成。复用当前节点 D:\crawlv3-dtc-v2、已有凭据、现有专用 Chrome 和模型。代码从 Git main 获取，不需要新的私有附件。不要自行提交或重发采集任务。

本次目标入口是 https://shopbellagrace.com/collections/wellness，只处理这个目录，不扩大到 beauty 或全站其他分类。主会话已完成 Mini 配套切换及健康检查。上一轮 Innerbody 已终态，历史 Review、采集文件、R2 证据和页面账本全部保留。

本版新增分类目录结束校验：使用 wellness 自己的商品接口，与实际 DOM 链接及空末页核对；不拿全店接口冒充分类结束。此前的健康回执恢复、根目录采集脚本、套装排除、单张完整标签停止继续识别及精确关页规则全部保留。模型继续 gpt-5.6-luna / medium。

版本与公开配置只以本文件同目录 deployment.json 为准。源码必须包含 b1b7f865df14b50b7cd059f430ddb8aea5210ccd，使用 git merge-base --is-ancestor 核验。当前预期 23 个顶层 JS：

- Activity：3b705195988155f01befac765ec9708ba236d30c3dce88827cd0477aca017371
- Workflow：22f5c2817fa37833cbd7cb7fe60687d8eef9fe35240a95b0acc1e7cabbcd4644

这次必须使用 bellagrace 目录的配置和校验脚本，不再使用 innerbody 目录的历史部署配置。queueScope 和 nodeId 中保留 innerbody 字样是沿用既有节点编号；实际品牌、来源 URL 和证据前缀以新的 scope/site/evidencePrefix 为准，不自行改节点编号或创建另一套 Worker。

## 1. 获取并构建代码

仓库仍为 D:\crawl-automation。保留原 .gitattributes 修改、所有 untracked 文件和既有构建目录。先 git fetch origin main。

可复用上次干净的独立构建工作区 D:\crawl-automation\health-update-build-20260912-081858；若其 tracked 干净，更新到 origin/main。原仓库或构建区有用户修改时，保留原状，从 origin/main 建立新的 detached worktree 构建。不 reset/clean/stash，不覆盖用户文件，也不创建新业务分支。

将实际源码目录记为 $dtcSourceRoot，在该目录使用现有 Node 22 和 pnpm：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @crawl-automation/v3-workers build:dtc
```

按 bellagrace/deployment.json 核对 JS 数量、两个 build ID、32 个 Skill 文件的完整性。任何不匹配先保留实际输出并停止，不修改预期值或绕过校验。

## 2. 正常停止旧节点并备份

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
```

先只读核对 status.json、Supervisor/三个 Worker PID、node-session.json、supervisor.lock、STOP、USER-CONTROL 和页面账本。上次部署报告 Supervisor=13820、capture=1624、catalog-source=16656、file=11432、session=9f5e0b44-14ca-4f86-aa48-b88af031a73b，但必须核实此刻实际状态，不凭旧 PID 操作进程。

当前没有主会话提交的新任务。如现场发现新任务、未核实的任务页面或用户接管，保留并报告，不中途打断。

节点仍运行且空闲时，用旧 release 正常停止：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

等待 Supervisor 和三个 Worker 实际退出，status=stopped，node-session.json 和 supervisor.lock 正常清理。保留此次 node-events.jsonl 的停止记录。不删除锁绕过检查，不按模糊名称杀进程。

正常 stop 留下的 STOP 标记，只在全部停机核验通过后移入本次备份；不带着旧 STOP 启动。若节点已停止，不重复创建 STOP。

在 $dtcRoot 内建立带时间戳的备份目录 $dtcBackup，完整备份 release、private、settings.private.json，并核对备份文件可读、与原件字节一致，保持原 NTFS 限制。保留输入凭据和历史证据。不要关闭 Chrome、用户页面、清 cookies 或重置 Profile。

## 3. 替换 release 并更新站点设置

完整替换 release 为实际源码目录 apps/v3-workers/dist/dtc-windows，包含全部共享 JS、product-workflows.cjs、crawl-products；不留旧共享 chunk。

```powershell
npm --prefix "$dtcRoot\release" install --omit=dev
```

核对 Temporal 原生模块、playwright-core 可加载，不下载新浏览器。

这次只需要从已发布的公开配置更新 scope、site、evidencePrefix 和相同的节点/资源编号。现有 baseRuntime、baseLive、browser、codex、证书路径、executable、codexHome、workRoot、审批/沙箱模式必须保留。不把私有配置或凭据打印到日志或提交 Git。

在备份已核实、旧节点完全停止后执行如下等效操作：

```powershell
$dtcPublicPath = Join-Path $dtcSourceRoot 'apps\v3-workers\deploy\bellagrace\deployment.json'
$dtcPublic = Get-Content -LiteralPath $dtcPublicPath -Raw | ConvertFrom-Json
$dtcSettingsPath = Join-Path $dtcRoot 'settings.private.json'
$dtcSettings = Get-Content -LiteralPath $dtcSettingsPath -Raw | ConvertFrom-Json
if ($dtcSettings.target -ne 'windows') { throw 'DTC_SETTINGS_TARGET_MISMATCH' }
if ($dtcSettings.queueScope -ne $dtcPublic.queueScope) { throw 'DTC_NODE_IDENTITY_MISMATCH' }
$dtcSettings.scope = $dtcPublic.scope
$dtcSettings.site = $dtcPublic.site
$dtcSettings.evidencePrefix = $dtcPublic.evidencePrefix
$dtcSettings.browserResource = $dtcPublic.browserResource
$dtcSettings.browserModelResource = $dtcPublic.browserModelResource
$dtcSettingsNext = Join-Path $dtcRoot ('settings.bellagrace-next-' + [guid]::NewGuid().ToString() + '.json')
[System.IO.File]::WriteAllText($dtcSettingsNext, ($dtcSettings | ConvertTo-Json -Depth 100), [System.Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $dtcSettingsNext -Destination $dtcSettingsPath -Force
```

内存中核对 site.selectedUrls=null、catalogPages 只有 wellness URL。证据前缀应为 crawlv3-acceptance/dtc-bellagrace-wellness-20260912，避免与 Innerbody 混淆。

旧 private 已完整备份后，将当前 private 内下面六个生成文件移入 $dtcBackup 下单独的 retired-configs 子目录，以便重新生成；保留证书、密钥和其他文件原路径。不要删除整个 private 或复制旧六个文件回来覆盖新配置：

- dtc.json
- node.json
- dtc-capture.runtime.json
- dtc-catalog-source.runtime.json
- dtc-file.runtime.json
- routing.json

## 4. 生成配置、doctor 和后台启动

在实际源码目录执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\bellagrace\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

要求三个 runtime、两个 build ID、Skill、routing 和 doctor 全部通过。内存核对 private/dtc.json 的 scope/site 与公开配置一致，R2 prefix 为本次 Bella Grace 前缀。Windows 配置不含 database、resourceDatabase 或 baseLabel。

继续使用现有 Chrome instance，CDP 仅监听 127.0.0.1:9222，不重启浏览器。

用 Start-Process 后台启动，stdout/stderr 分开记录：

```powershell
$dtcLogDir = Join-Path $dtcRoot ('logs/bellagrace-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dtcLogDir -ErrorAction Stop | Out-Null
$dtcProcess = Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput (Join-Path $dtcLogDir 'supervisor.stdout.log') `
  -RedirectStandardError (Join-Path $dtcLogDir 'supervisor.stderr.log') `
  -WindowStyle Hidden -PassThru
```

至少观察 120 秒、覆盖四个健康更新周期。要求 healthy=true、三个角色 ready、PID 属于新 release、session 稳定、sequence 增长、DTC_NODE_HEALTH_ACKNOWLEDGED 持续成功且没有重启循环。正常 CLI 退出现在也可能在 stderr 打印 DTC_NODE_PROCESS_EXIT，以退出码和事件判断，不要求 stderr 必须为空。

失败时保存完整脱敏异常、停机触发阶段和退出码，不反复盲目启动，也不关闭沙箱、改 ACL 或添加 bypass。

## 5. 返回结果并保持运行

报告实际源码目录、HEAD、23 JS 和两个 build ID、Skill/routing/doctor、品牌名称及 wellness URL、证据前缀、Supervisor 和三个 Worker PID、sessionId、四次健康采样及日志/备份路径。说明原 .gitattributes 修改和凭据保留情况，不输出凭据正文。

成功后保持后台运行，等待主会话从正常 Brand 入口提交 Bella Grace wellness 目录任务；本次不要自行提交采集，不释放 Mini 许可，不把预检 7 个链接当作 7 个完整采集结果。

正式任务继续要求：全部原图和 HTML 留存、完整标签识别、组合装证据化排除、精确任务页面关闭并复核消失。预检只核对了目录结构和两款商品的页面根节点/图片域名，没有替代 Windows 的完整图库与商品验收。
