# Windows Codex：部署健康更新恢复、采集结果分类及收尾核验修复

连续完成此次部署，不只给计划。沿用 D:\crawl-automation 仓库、D:\crawlv3-dtc-v2 部署和当前专用 Chrome。代码从 Git main 获取，复用本机已有凭据，不需要新附件，不向 Git 提交私有配置。

本次版本与 build ID 以同目录 deployment.json 为唯一依据。核对 HEAD 包含该文件 commit 指定的源码提交，不手改 build ID。此文件随 Mini 配套进程更新并通过验收后发布。先前全站轮次 5c5bf085-e9a8-46ee-861a-b0827be3005c 已结束：4 个成功、3 个待审，遗留许可和提交锁均为 0。历史 Review 保留。

## 本次改动

本次修复以下问题，模型和采集方法保持原样：

- Supervisor 的健康更新遇到超时、连接暂不可用或回执丢失时，先绑定原 Workflow runId，用相同 updateId 核对服务端结果；确认未找到该更新时才原样补发一次。核对成功继续工作。恢复有次数和时间上限，明确拒绝、用户取消或最终仍无法确认时继续正常停机，不隐藏故障。
- 新增部署根目录 node-events.jsonl：记录健康更新 sequence、updateId、runId、耗时、原始异常类型/错误码/堆栈、恢复结果及停机触发阶段；记录 Worker 的实际退出码和 signal。Supervisor stderr 也保留结构化异常及进程退出码，敏感值会脱敏。
- 套装是否跳过由原始 harvest 的当前 URL / bundle_or_pack 排除记录、空 records 和空 failed 共同决定。模型换用 scope_conflict_bundle_target 等原因名称，不再漏判。缺少原始排除证据或有混合/失败记录时，不记为跳过。
- Mini 比较停止证明时只核对 workflowId/runId，避免 Temporal SDK 的对象类型与 JSON 对象不同导致误拒绝。运行编号、任务编号、关页目标和 R2 内容哈希仍严格核对。

以下是上一版已包含并继续保留的采集规则：

- Worker 的 HTML 获取固定走当前任务 Chrome；普通空响应/网络失败时最多导航回正确商品页一次，保存 DOM。明确访问拒绝或用户接管仍停止。
- 原始 harvest 明确排除 bundle_or_pack 且 records 为空时，记为跳过。
- 主脚本仍位于各任务 cwd 的 run-catalog.mjs / run-capture.mjs；capture 只放证据。简化写入诊断，实际文件先 node --check 再执行。保留原脚本、分别记录的 CLI stdout、stderr、进程退出信息；没有取得的底层错误码不编造。
- Mini 确认一张完整标签图后，不再调用网页文本模型；全部图片和 HTML 仍保留，没有完整图时才走文本兜底。
- 正常结束、完成关页并留有可验证证明的商品待审，由 Mini 自动核对并释放占用。超时、取消、用户接管、执行状态不明仍保持隔离。
- 全目录的结束证明会核对 DOM 商品链接、官网公开商品接口和空的末页；证据不匹配仍记为未确认。

模型仍为原有 gpt-5.6-luna / medium。保持 Codex CLI、审批模式、沙箱、ACL、Profile、site-profiles 和目录布局。不要为部署运行真实采集。

## 执行步骤

1. 查看工作区和当前节点状态，保留所有用户修改、untracked 文件、历史任务、R2 证据、页面账本和诊断。本机上次报告已有 .gitattributes 修改，必须保留。先 git fetch origin main；tracked 干净且可快进时执行 git pull --ff-only origin main。有 tracked 修改则在带时间戳的新目录建立 origin/main 的 detached worktree，用该目录构建（不创建业务分支），不 stash/reset/clean 或覆盖用户文件。记录实际源码目录和 HEAD。确认使用仓库 LF 规则，避免旧 CRLF 工作区造成 build ID 不一致。下文仓库相对命令均在该实际源码目录执行。

2. 使用现有 Node 22 和 pnpm 执行 pnpm install --frozen-lockfile，再运行 pnpm --filter @crawl-automation/v3-workers build:dtc。按 deployment.json 验证 JS 数量、activityBuild、workflowBuild、Skill 完整性。本版应有 23 个顶层 JS，源码必须包含 9f1ecd993776a37c53e7b2a59df86c3666e40574（git merge-base --is-ancestor 验证）；后续只修改说明的提交不影响构建 ID。任何不匹配先报告实际值，不能绕过或手改预期值。

3. 本轮已结束并完成占用结算，Mini 已按本版配套更新，可以继续部署。上次 Supervisor 5024 和三个 Worker 16348/8116/20384 均已退出；仍须只读核对当前 PID、status.json、node-session.json、supervisor.lock、STOP、USER-CONTROL 和页面账本，确认没有新在途任务或未核实关页。若现场已有新任务，保留并报告，不中途打断。若当前仍有空闲的旧节点，正常停止：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

若已经停止，核对原 supervisor 和三个 Worker PID 确实退出、session 和锁已按正常流程清理，不重复创建 STOP。只在完整停机核实后处理该次已完成的 STOP，不删锁绕过检查。不要关闭 Chrome 进程、用户页面、清 cookies 或重置 Profile。

4. 在现有部署目录内建带时间戳的受限备份，备份 release、private、settings.private.json。完整替换 release 为仓库 apps/v3-workers/dist/dtc-windows，不能仅覆盖几个 JS 而留下旧共享模块。包含 crawl-products、dtc-skill-integrity.js、dtc-write-context.js、product-workflows.cjs 和所有共享 JS chunk。运行 npm --prefix "$dtcRoot\release" install --omit=dev，在 Windows 本机安装运行依赖；核对 Temporal 原生模块与 playwright-core 能加载，不下载新浏览器。

5. 沿用已有 settings 和 inputs，保留证书、executable、codexHome、workRoot。内存核对 scope、queueScope、site、模型和公开标签策略与 deployment.json 一致，site.selectedUrls=null。不要显示配置正文或凭据，不往 Windows 配置添加 database、resourceDatabase 或 baseLabel。CRAWL_WORKER_SCRIPT_PATH 由宿主每次注入，不设置全局值。

6. 旧 private 已备份后，新建 private 配置目录生成本版配置。若证书或密钥实际位于旧 private 内，先保留到新目录的相同路径并保持原 NTFS 限制；不要删除凭据或让 settings 引用失效。仅重新生成部署配置文件，不覆盖证书、密钥。执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

核对 Windows 三个 runtime、routing、两个 build ID、Skill 和 doctor 全部通过。Chrome 继续使用原实例，仅监听 127.0.0.1:9222。

7. 用 Start-Process 后台启动，stdout/stderr 分开保存，不依赖当前 shell 存活。例如：

```powershell
$dtcLogDir = Join-Path $dtcRoot ('logs/health-update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $dtcLogDir -ErrorAction Stop | Out-Null
$dtcProcess = Start-Process -FilePath $dtcNodeExe `
  -ArgumentList @("$dtcRoot\release\dtc-node.js", 'start', "$dtcRoot\private\node.json") `
  -WorkingDirectory $dtcRoot `
  -RedirectStandardOutput (Join-Path $dtcLogDir 'supervisor.stdout.log') `
  -RedirectStandardError (Join-Path $dtcLogDir 'supervisor.stderr.log') `
  -WindowStyle Hidden -PassThru
```

至少观察 2 分钟且覆盖四个健康更新周期。核对 healthy=true、三个角色 ready、PID 属于新 release、心跳更新、session 不变且没有重启循环。读取 $dtcRoot\node-events.jsonl，按本次 Supervisor PID 筛选，确认健康更新 sequence 持续增长且 DTC_NODE_HEALTH_ACKNOWLEDGED 成功。没有发生瞬时错误时不必人为触发网络故障。doctor/stop 正常退出现在也可能打印 DTC_NODE_PROCESS_EXIT；按退出码和事件判断，不能以 stderr 必须为空作为验收标准。若启动失败，保留原始异常和停止事件，不连续盲目重启。

8. 报告 Git commit、实际源码目录和 release、两个 build ID、JS 数量、Skill/routing/doctor、supervisor 和三个 Worker PID、sessionId、四次健康采样及日志目录。说明原 .gitattributes 修改是否保留，报告新 node-events.jsonl 的路径和本次健康更新摘要；若有恢复或停机，给出 sequence、updateId、耗时、脱敏错误码和触发阶段。不要输出私有配置、证书、密钥或凭据。保持后台运行，由主会话通过正常 Brand 入口提交新一轮全站任务。

## 下一轮日志与验收

本轮部署本身不代表真实采集已验收。收到新任务后保留：

- 本轮 Supervisor 的 node-events.jsonl、stdout/stderr，以及三个 Worker 日志，保留 UTC 时间与 PID。
- 每个任务实际根目录脚本、node --check 和执行工具的原始输出。
- capture 内 HTML、全部图库原图、records / harvest / catalog 及目录结束证据。
- 本地 events.jsonl.stdout、events.jsonl.stderr、events.jsonl.process.json；R2 对应 v3/dtc-legacy/<operationId>/diagnostics/ 下的文件。
- 若未产生脚本或日志不可用，明确报告缺失，不用代理总结冒充原始调用。
- 正常待审的 capture-stop.json 和 Mini 核验结果。不要自行释放 Mini 许可或改写历史账本。
- 每项任务的 taskId、精确 targetId、closed 记录和目标消失复查。用户接管时保持 pending，不擅自清理。

采集器只有在全部任务证据和结束状态实际核验后，才能宣布本轮通过。不要因暂时没有页面就提前声称所有关页路径通过。
