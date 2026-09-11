# Windows Codex：保留首次试单证据并更新页面归属修复

请连续完成本次 Windows DTC 修复部署。代码从现有仓库 main 拉取，使用已有凭据和专用 Chrome，不索要新版部署包。不重新提交采集任务。

首次试单 requestId 为 `45d1252f-a103-4bd0-bfcb-fa30f94386c4`；目录 Workflow 为 `v3-collection-45d1252f-a103-4bd0-bfcb-fa30f94386c4-catalog`，runId 为 `01a08fa4-8776-70c6-a617-3432b33a725e`。Windows catalog-source 已实际接单，但以 `DTC.PAGE_EXECUTION_CONFLICT` 失败，没有发现商品。Mini 已结束失败的父流程，原许可继续隔离，等待页面关闭证明。不要删除日志、页面账本、R2 对象或手工释放许可。

## 1. 核查这次任务的页面清理

部署根为 `D:\crawlv3-dtc-v2`。读取现有 `private\dtc.json`，只在内存使用配置，不输出凭据。检查 `pageJournalRoot\v3\dtc-page-executions` 下的绑定，精确匹配上述 Workflow ID 和 runId，记录 taskId；不能按域名或浏览器窗口猜测归属。

在 `pageJournalRoot\v3\cdp-pages` 中查找同一 taskId 的 opened、close-intent、closed 记录，核对 browser/config 与本次专用 Chrome 实例一致。先检查 USER-CONTROL/配置中的 pauseFile；用户接管时停止操作并报告 pending。

从配置的 loopback CDP 只读核对 `/json/version` 和页面清单，确认 closed 记录中全部 targets 已消失，进行有限次数只读复查。保存一份不含凭据的 `trial-45d1252f-cleanup.json`，包括时间、Workflow ID/runId、taskId、targetId、closed 记录路径及 SHA-256、targetsAbsent 的实际结果。不把 close 请求成功当作目标消失证明。

若页面仍在或只有未完成的打开记录，保持 pending，先正常停机，再按下述恢复命令处理精确目标。不要关闭其他标签页，不杀 Chrome，不清 Profile，不删账本掩盖未完成清理。若绑定无法唯一确认，报告具体缺项，不猜测。

## 2. 正常停止旧节点

使用当前有效 Node 原生 exe 和旧 release：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

核实 supervisor 和三个 Worker 的精确 PID 均退出、node-session 和锁已正常清除。已存在 STOP 时先核实是否正在停止，不重复创建或直接删除。停机异常时保留锁及会话；只有确认全部旧进程退出后，才能使用旧 release 的 `dtc-recover.js private\node.json`。它会核对终态 Workflow、关闭精确任务页面并保存恢复证据，仍不释放隔离许可。恢复后的 targetsAbsent 也需记录。所有停止/恢复完成后，才移除已完成的本次 STOP 请求。

## 3. 拉取修复并重新部署

保留现有 tracked 修改和 untracked 文件，不 reset/clean。在现有仓库 main 执行：

```powershell
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm --filter @crawl-automation/v3-workers build:dtc
```

确认源码包含 `apps/v3-workers/src/dtc-execution.ts`，浏览器 Worker 使用该函数把 Temporal 身份转成仅含 workflowId/runId 的普通对象。保留所有构建校验；预期值以 Git 的 deployment.json 为准。

旧节点完全停止后，备份根下 release 和 private，完整复制新构建到原根的 release。保留 source-journal、browser-pages、source-cache、inputs、browser-model、所有日志及既有 settings.private.json；本次不改变 Chrome instanceId、queueScope 或凭据。不得将新旧 JS 混合。

```powershell
npm --prefix "$dtcRoot\release" install --omit=dev
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

新 private 由原 settings 重新生成；不向旧 private 直接覆盖配置。核对 18 个 JS、Activity/Workflow build ID 和三个 runtime 的 expectedBuildId 全部与 Git 匹配。Mini 已同步相同构建标识。doctor 必须通过。

## 4. 后台启动与报告

沿 `WINDOWS_CODEX_PROMPT.md` 的 Start-Process 方式启动，保持日志重定向，核验至少四个采样周期 healthy=true，三个实际 PID 全部 ready，无重启循环。

回报 Git commit、两个 build ID、doctor、三个 PID/ready、sessionId、首次试单 taskId/targetId/targetsAbsent 及清理证据路径；如运行过恢复，附其 R2 proof key。凭据不输出、不上传 Git。节点恢复后交回主会话，由 Mini 核验并释放首次试单的精确隔离许可，再从 Brand 入口提交新的请求；不要自行重放、重置或再次采集旧请求。
