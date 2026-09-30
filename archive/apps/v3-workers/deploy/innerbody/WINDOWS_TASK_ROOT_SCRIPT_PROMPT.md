# Windows Codex：采集程序放在各自任务根目录

连续完成本次更新。沿用 D:\crawl-automation 仓库、D:\crawlv3-dtc-v2 部署、现有凭据和专用 Chrome。不新建 D 盘顶层工作目录，不迁移整个 Worker。

本次只调整任务内部的程序位置：

```text
browser-model/legacy/<本次任务标识>/
  run-catalog.mjs 或 run-capture.mjs  ← 主采集程序
  capture/                          ← 网页、图片和商品数据
```

宿主使用同一 scriptPath 注入 Prompt、CRAWL_WORKER_SCRIPT_PATH 和诊断。目录与商品任务均使用固定文件名；辅助脚本也放任务根目录。旧 Skill 的 outDir 仍指向 capture，模型、采集方法、审批设置和页面生命周期沿用现有实现。新请求自然获得新任务目录，不重用旧目录、旧脚本或旧 taskId。

本方案已有历史成功和 Windows 局部对照证据支持，但没有修复 Codex 的子目录写入缺陷，也不表示 Windows 真实采集已通过。当前 CLI 不升级、不降级，不改 ACL 或沙箱。

## 版本

- 源码至少包含：0178961cb25bf979cd07ee0695f2745704c8f85f。
- JS：22 个。
- Activity：6e1887d5b90d436c1a6f134b79331e63d76ec58269e26745d18747db886f7758。
- Workflow：9ea228b294186f11a3037811a467269b022bed92a8cbd0850d67967ab3f50520。

最新 main 的 deployment.json 是最终校验依据，不手工更改预期 build ID。

## 执行步骤

1. 核对 Git 状态，保留已有 tracked 修改和全部 untracked 文件；可快进时 git pull --ff-only origin main。不 reset/clean。有用户 tracked 修改时采用独立 checkout 构建。tracked 干净时可执行 git -c core.autocrlf=false checkout-index --all --force，让旧 Windows checkout 应用仓库 LF 规则。

2. pnpm install --frozen-lockfile；pnpm --filter @crawl-automation/v3-workers build:dtc。按 deployment.json 核对 JS 数量、两个 build ID 和 Skill 文件完整性。核对构建中存在 CRAWL_WORKER_SCRIPT_PATH，且主脚本路径位于 cwd 下，而非 capture 下。

3. 主会话已核对 d58c30f6-2dee-4e68-a27d-774b9f1a282e 的本次 Windows 关页证明并释放对应占用，父任务正常结算为目录未完成、发现 0 商品。历史失败事实及原始证明保留。本机仍须确认没有新在途任务、pending 页面账本或 USER-CONTROL，再正常停止旧节点：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

Mini 维护期间已观察到旧节点报告 dtc_node_stopped。若本机也确认节点已经正常停止，只核实精确 PID、session 和锁的状态，不再创建 STOP。核对旧 supervisor 与三个 Worker 均退出、会话和锁正常清除后，才能处理本次已完成的 STOP。不删锁绕过检查，不杀 Chrome，不清 cookies/Profile，不操作无关页面。

4. 在现有部署目录内建立带时间戳、权限受限的备份，保存 release、private 和 settings.private.json。完整替换 release 为 apps/v3-workers/dist/dtc-windows，必须包含 crawl-products、dtc-skill-integrity.js、dtc-write-context.js 及全部共享 JS。运行 npm --prefix "$dtcRoot\release" install --omit=dev，在 Windows 本机安装运行依赖；检查 playwright-core 和 Temporal 原生模块能加载，不下载额外浏览器。

5. 保留现有 settings、inputs、证书、所有 browser-model 历史任务、site-profiles、browser-pages、source-journal、诊断及日志。无需清空或再次归档任务。复用现有 executable、codexHome、workRoot、模型和审批设置；CRAWL_WORKER_SCRIPT_PATH 由宿主按任务注入，不手工设置全局值。

6. 在内存核对 settings 的 scope、queueScope、site 与 deployment.json 一致，site.selectedUrls=null；现有基础输入的 evidencePolicy、visionConfigFingerprint、sourceVisionConfigFingerprint 与 Git 一致。本次不更改这些公开策略；不一致时报告非敏感差异。settings.codex 保持 runtimeProfileVersion=dtc-legacy-agent/1、timeoutMs=900000。

7. 旧 private 已备份后，用新空 private 目录重新生成构建配置并执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe .\apps\v3-workers\deploy\innerbody\verify-routing.mjs $dtcRoot
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

三个 runtime、routing、两个 build ID、Skill 完整性和 doctor 全通过才启动。Windows 配置仍不能含 database、resourceDatabase 或 baseLabel。不需要新凭据附件，不连接 Mini 业务库，不输出配置正文或凭据。

8. 通过 Start-Process 后台启动，将 stdout/stderr 分别写到现有部署目录 logs/root-script-<时间戳> 下。使用上述 Node 执行 release/dtc-node.js start private/node.json，WorkingDirectory 为 $dtcRoot。连续至少四个健康周期，核对 healthy=true、三个角色 ready、PID 属于新 release、心跳持续且无重启循环。专用 Chrome 仍仅监听 127.0.0.1:9222，实例与配置一致。

不要在本机重复最小写入诊断或自行发采集请求。保持节点后台运行，报告 Git commit、构建标识、Skill/routing/doctor、supervisor 和三个 Worker PID、sessionId、健康采样及日志目录。更新完成后，由主会话从正常 Brand 入口发新的全目录任务。

## 下一轮验收

必须逐项确认：固定根目录脚本创建成功 → 实际运行 → capture 内有可核对的 HTML、图片/目录数据 → 原始证据交付 → 精确任务页面关闭且目标不存在。根目录能写入不等于 capture 证据已保存；没有实测的环节不能声称通过。

宿主 write-diagnostic.json 现在检查约定的根目录脚本。现有 events.jsonl 仍保留工具结果与子会话输出；代理复述补丁不等于原始工具输入，原始审批/调用留存缺口没有在本次通过更换 CLI 模式解决。若下一轮有错误，保留本机实际可用原始日志并报告，勿以代理总结代替原始证据。
