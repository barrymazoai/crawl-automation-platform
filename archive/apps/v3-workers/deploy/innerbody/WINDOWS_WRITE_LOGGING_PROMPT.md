> 已由 [任务根目录脚本部署说明](WINDOWS_TASK_ROOT_SCRIPT_PROMPT.md) 取代；本文件保留历史记录。

# Windows Codex：归档已结束任务并部署真实采集写入日志

把本文完整交给 Windows Codex 执行。代码从 main 获取，不需要新的凭据附件。

本次源码祖先：`3498f6a07b8c9c126ba5e996f01e7a7f97e284fc`。

- JS：22 个。
- Activity build：`fe726626967508cf576b052b0b6d17d35988091d73d69fe39391e167340643a0`。
- Workflow build：`ff0e0428fb331d66986f74e1bb7d7c76c00c2f45f1ea125a084fc2ce046f2c72`。

以上用于识别本次版本；以最新 main 的 deployment.json 为校验真源，不可绕过不匹配。

连续完成这次更新。代码从现有 Git 仓库 main 拉取，复用现有凭据、专用 Chrome 和 `D:\crawlv3-dtc-v2`。不用新版凭据包，不重新部署数据库，不由 Windows 连接 Mini 业务库。禁止提交真实采集请求；启动后由主会话从 Brand 入口发新单。

本次包含单张完整标签优先、同义成分归组、组合装单独跳过，以及泛化写入错误的诊断指令。仍使用旧版完整采集器和 gpt-5.6-luna / medium；采集范围为整个目录（site.selectedUrls=null），每个商品任务只处理当前商品并保存全部图库和规格。识别在 Mini 完成。写入失败根因尚未确定。本次增加真实任务中的 DTC_WRITE_INTENT / DTC_WRITE_RESULT、子会话只读路径检查，以及宿主 write-diagnostic.json；不改 ACL、模型或审批模式，不另跑诊断矩阵。

主会话已核对请求 a6927780-fee0-41ae-ac68-11425be391b6 的关页证据并正常释放对应占用；父任务已正常结算为目录未完成、发现 0 个商品，零占用、零来源锁。历史失败事实保留。若本机出现新的在途任务，先等其正常结束再切换。

1. 检查现有仓库状态，确认 main；保留 tracked 修改和全部 untracked 文件。没有 tracked 修改时执行 `git pull --ff-only origin main`。仓库已有 .gitattributes 保证构建源码 LF；确认 tracked 干净后执行 `git -c core.autocrlf=false checkout-index --all --force`，重新写出同一 HEAD 的受跟踪源码，让已有 Windows checkout 也应用 LF。这个操作不得用在有用户 tracked 修改的工作区；此时使用新的独立本地 checkout 构建。不要 reset/clean。

2. `pnpm install --frozen-lockfile`，然后 `pnpm --filter @crawl-automation/v3-workers build:dtc`。读取 Git 中 `apps/v3-workers/deploy/innerbody/deployment.json`，核对源码包含 DtcLegacyCapture、DtcLegacyFileTransport 和 dtc-skill-integrity.js 的生成逻辑。按该 JSON 核对 JS 数量、Activity/Workflow build；不要沿用旧的“18 JS”或旧 build ID，也不要自行改预期 ID。Workflow build 是全部根目录 JS 加 product-workflows.cjs 的组合标识。

3. Mini 配套已更新，旧 Windows 节点是否退出以本机实际状态为准。先在本机核实 supervisor/三个 Worker 的精确 PID 是否已退出、session 和锁是否清除，以及没有 pending 页面账本和 USER-CONTROL。若已正常停止，不再创建 STOP 文件；若仍运行且没有在途任务，用旧 release 正常 stop：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

核对 supervisor 和三个 Worker 的精确 PID 退出、会话与锁清除，才处理本次完成的 STOP。不能删锁绕过检查。不要重启/杀 Chrome，不碰个人标签页。用户接管时报告 pending，不能接管浏览器清页。旧试单及 Review 不重放、不修改。

停机核实后，仅归档下面这个已结束任务的本地工作目录：

- 原目录：`D:\crawlv3-dtc-v2\browser-model\legacy\663a7d600de2dd270819171cbe194d8426a414907ce91988a35402723483cff7`
- 对应 taskId：`dtc-catalog-5488809754890176eca730ea286c33836564a8c654f2a60e3fd9dacffd425713`
- 目标：`D:\crawlv3-dtc-v2\archive\write-logging-<时间戳>\663a7d600de2dd270819171cbe194d8426a414907ce91988a35402723483cff7`

先核对路径没有 junction/symlink、没有运行进程引用该目录，且原任务 closed.json 和 proof.json 仍存在。为归档目录设置与原私有工作目录同等的受限 NTFS 权限，保存文件相对路径、大小和 SHA-256 清单，再移动这个精确目录，复核清单一致及原目录不再存在。原目录已经不在时报告实际归档位置，不扩大清理范围。归档含原始日志，不能上传 Git。

保留 `browser-pages` 的 closed.json、`diagnostics` 的 proof.json 及其原路径，不清空整个 browser-model、source-journal、日志、资源账本或历史任务。下一轮由主会话通过 Brand 创建新请求，自然获得新的空任务目录；不复制旧脚本进去，不复用旧 taskId。

4. 在带时间戳且权限受限的备份目录保存 release、private、settings.private.json。新 release 必须完整替换为 `apps/v3-workers/dist/dtc-windows`，包括 **crawl-products 目录和 dtc-skill-integrity.js**；不要混用新旧文件。执行 `npm --prefix "$dtcRoot\release" install --omit=dev`，核对 playwright-core 可加载；不下载 Playwright 浏览器，使用已有专用 Chrome。Temporal 原生依赖在 Windows 本机安装。

5. 保留 inputs、证书、Chrome Profile、source-journal、browser-pages、source-cache、其他 browser-model 目录、日志及全部历史证据。上述唯一旧任务目录以归档形式保留。先在内存核对现有 settings 的 scope、queueScope、site 与 Git 一致；不一致则报告非敏感差异。确认现有 settings.codex 的 `runtimeProfileVersion="dtc-legacy-agent/1"`、`timeoutMs=900000`，保持原值。确认 `settings.site.selectedUrls === null`。保留 executable、codexHome、workRoot、disabledMcpServers、模型设置及所有凭据。无需重跑首次安装的 prepare-windows.mjs。

   核对三个公开策略字段：读取 settings.baseLive 指向的 JSON，若已与 Git 一致则保留原文件和 settings；只有字段不一致时，复制为 inputs 下本次部署专用的新文件（如 channel.browser.review-日期时间.json），仅将 evidencePolicy、visionConfigFingerprint、sourceVisionConfigFingerprint 更新为 Git deployment.json.channelDefaults 中对应值。将 settings.baseLive 改为该新文件路径，备份后原子写入 settings；保留其他字段原值和原文件。新私有文件继承现有 inputs 的受限 NTFS 权限。预期 evidencePolicy=label-image-first/5，两个 vision 指纹均为 623632994ec3090b741c8e67fc1abb9962bcb8d38b04dc371ec4798075bedaba；最终以 Git 为准。不要输出配置正文或凭据。

6. private 改用新空目录，由现有 settings 生成，不覆盖旧文件：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

确认生成的 private/dtc.json 三个策略字段与 Git 一致。三个 runtime、两个 build ID、routing 及 Skill 文件完整性全部通过后才启动。Windows private/dtc.json 不能含 database、resourceDatabase、baseLabel。不要把 Codex 再改成 DOM-only 决策器或使用 bypass-approvals-and-sandbox。完整执行器沿用旧版 approve-for-me；遇到权限拒绝保留证据并报告。

7. 在新的日志目录以 Start-Process 后台启动：

```powershell
$dtcLog = Join-Path $dtcRoot ('logs\write-logging-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
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

源码至少包含 deployment.json 中 commit 指定的祖先；使用最新 main 构建。以 deployment.json 的两个 build ID、22 个 JS 和 Skill 完整性为准。不要手动添加全局 CRAWL_WORKER_PRODUCT_URL；它由每个任务的宿主单独注入。不要自行重跑历史失败任务或释放 Mini 的隔离许可。

本次额外核验：release 包含 dtc-write-context.js；采集源码包含 DTC_WRITE_INTENT、DTC_WRITE_RESULT 和 write-diagnostic.json。不要为了测试它而提前运行真实采集或创建文件探针。日志目录及归档清单路径要列入最终报告。

下一轮真实任务的日志约定：宿主自动在任务目录保存 write-diagnostic.json 并尝试发布到 v3/dtc-legacy/<operationId>/write-diagnostic.json；现有 events.jsonl 保存模型的写入意图、结果以及子会话只读检查输出。实际补丁内容的记录依赖执行代理遵循指令，不能在尚未运行时声称已收集。宿主检查成功也不等于子会话具备写权限。失败保留原始错误，不能擅自改成“整个文件系统只读”。正常、失败和取消仍按现有任务页面生命周期收尾，核验精确目标不存在。
