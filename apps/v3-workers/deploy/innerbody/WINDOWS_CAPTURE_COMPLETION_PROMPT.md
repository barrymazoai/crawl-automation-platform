# Windows Codex：更新 Innerbody 采集、日志和收尾流程

连续完成此次部署，不只给计划。沿用 D:\crawl-automation 仓库、D:\crawlv3-dtc-v2 部署和当前专用 Chrome。代码从 Git main 获取，复用本机已有凭据，不需要新附件，不向 Git 提交私有配置。

本次版本与 build ID 以同目录 deployment.json 为唯一依据。核对 HEAD 包含该文件 commit 指定的源码提交，不手改 build ID。主会话会先更新 Mini 配套进程，再交给你执行本文。

## 本次改动

- Worker 的 HTML 获取固定走当前任务 Chrome；普通空响应/网络失败时最多导航回正确商品页一次，保存 DOM。明确访问拒绝或用户接管仍停止。
- 原始 harvest 明确排除 bundle_or_pack 且 records 为空时，记为跳过。
- 主脚本仍位于各任务 cwd 的 run-catalog.mjs / run-capture.mjs；capture 只放证据。简化写入诊断，实际文件先 node --check 再执行。保留原脚本、分别记录的 CLI stdout、stderr、进程退出信息；没有取得的底层错误码不编造。
- Mini 确認一张完整标签图后，不再调用网页文本模型；全部图片和 HTML 仍保留，没有完整图时才走文本兜底。
- 正常结束、完成关页并留有可验证证明的商品待审，由 Mini 自动核对并释放占用。超时、取消、用户接管、执行状态不明仍保持隔离。
- 全目录的结束证明会核对 DOM 商品链接、官网公开商品接口和空的末页；证据不匹配仍记为未确认。

模型仍为原有 gpt-5.6-luna / medium。保持 Codex CLI、审批模式、沙箱、ACL、Profile、site-profiles 和目录布局。不要为部署运行真实采集。

## 执行步骤

1. 查看工作区和当前节点状态，保留所有用户修改、untracked 文件、历史任务、R2 证据、页面账本和诊断。tracked 干净且可快进时执行 git pull --ff-only origin main；不要 reset 或 clean。有 tracked 修改则使用独立 checkout 构建，保留原仓库。确认使用仓库 LF 规则，避免旧 CRLF 工作区造成 build ID 不一致。

2. 使用现有 Node 22 和 pnpm 执行 pnpm install --frozen-lockfile，再运行 pnpm --filter @crawl-automation/v3-workers build:dtc。按 deployment.json 验证 JS 数量、activityBuild、workflowBuild、Skill 完整性。任何不匹配先报告实际值，不能绕过或手改预期值。

3. 主会话已完成上一轮采集结算和占用恢复。Mini 更新后，旧 Windows 节点已报告 dtc_node_stopped；这不代替本机 PID、session 和锁检查。本机仍须核实此刻没有新在途任务、待清理页面或 USER-CONTROL。正常停止现有节点：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

若已经停止，核对原 supervisor 和三个 Worker PID 确实退出、session 和锁已按正常流程清理，不重复创建 STOP。只在完整停机核实后处理该次已完成的 STOP，不删锁绕过检查。不要关闭 Chrome 进程、用户页面、清 cookies 或重置 Profile。

4. 在现有部署目录内建带时间戳的受限备份，备份 release、private、settings.private.json。完整替换 release 为仓库 apps/v3-workers/dist/dtc-windows，不能仅覆盖几个 JS 而留下旧共享模块。包含 crawl-products、dtc-skill-integrity.js、dtc-write-context.js 和 product-workflows.cjs。运行 npm --prefix "$dtcRoot\release" install --omit=dev，在 Windows 本机安装运行依赖；核对 Temporal 原生模块与 playwright-core 能加载，不下载新浏览器。

5. 沿用已有 settings 和 inputs，保留证书、executable、codexHome、workRoot。内存核对 scope、queueScope、site、模型和公开标签策略与 deployment.json 一致，site.selectedUrls=null。不要显示配置正文或凭据，不往 Windows 配置添加 database、resourceDatabase 或 baseLabel。CRAWL_WORKER_SCRIPT_PATH 由宿主每次注入，不设置全局值。

6. 旧 private 已备份后，用新的空 private 目录生成配置，并执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

核对 Windows 三个 runtime、routing、两个 build ID、Skill 和 doctor 全部通过。Chrome 继续使用原实例，仅监听 127.0.0.1:9222。

7. 用 Start-Process 后台启动，WorkingDirectory=$dtcRoot，stdout/stderr 分别重定向到 logs/capture-completion-<时间戳>。命令为现有 Node 执行 release/dtc-node.js start private/node.json。连续观察至少四个健康周期，核对 healthy=true、三个角色 ready、PID 属于新 release、心跳更新且没有重启循环。

8. 报告 Git commit、实际 release、两个 build ID、JS 数量、Skill/routing/doctor、supervisor 和三个 Worker PID、sessionId、健康采样及日志目录。保持后台运行，由主会话通过正常 Brand 入口提交新一轮全站任务。

## 下一轮日志与验收

本轮部署本身不代表真实采集已验收。收到新任务后保留：

- 每个任务实际根目录脚本、node --check 和执行工具的原始输出。
- capture 内 HTML、全部图库原图、records / harvest / catalog 及目录结束证据。
- 本地 events.jsonl.stdout、events.jsonl.stderr、events.jsonl.process.json；R2 对应 v3/dtc-legacy/<operationId>/diagnostics/ 下的文件。
- 若未产生脚本或日志不可用，明确报告缺失，不用代理总结冒充原始调用。
- 正常待审的 capture-stop.json 和 Mini 核验结果。不要自行释放 Mini 许可或改写历史账本。
- 每项任务的 taskId、精确 targetId、closed 记录和目标消失复查。用户接管时保持 pending，不擅自清理。

采集器只有在全部任务证据和结束状态实际核验后，才能宣布本轮通过。不要因暂时没有页面就提前声称所有关页路径通过。
