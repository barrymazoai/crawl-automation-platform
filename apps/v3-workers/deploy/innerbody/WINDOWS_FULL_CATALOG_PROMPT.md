# Innerbody 全目录测试：仅更新范围配置并重启

> 历史步骤：后续整站测试发现了商品范围问题，更新部署请使用同目录 `WINDOWS_FULL_CATALOG_FIX_PROMPT.md`，不要再按本文件复用旧 release。

用户已授权测试整个 Innerbody 官网目录。上次单商品成功请求为 31fc31f2-75a8-43f9-b72e-4b932ce23039，已正常结束、关页、释放占用。现在只取消 Windows 本地的单商品白名单，不改采集器、不换模型、不换 release、不重新上传凭据。

1. 在 D:\crawl-automation 检查工作区，保留用户文件和未跟踪证据，执行 `git pull --ff-only origin main`。读取 `apps/v3-workers/deploy/innerbody/deployment.json`，确认 `site.selectedUrls === null`。现有 release 应仍是 20 个根目录 JS，Activity build 为 `63ad1c890b96df25cc25050ec86b8e9e98b0cd9cbef874668c381999f9524f72`，Workflow build 为 `54cdbea7f81421e897c378993a257c6c785f7e766214d9a9c30cedf60f26a72e`；按现有构建算法核对，不能改预期值。本次无需 pnpm install/build、替换 release 或重装依赖。

2. 根目录是 `D:\crawlv3-dtc-v2`。确认没有正在执行的采集任务、没有待清理页面或 USER-CONTROL。记录 supervisor/三个 Worker 的精确 PID 和 session。用现有 Node 正常停止：

```powershell
$dtcRoot = 'D:\crawlv3-dtc-v2'
$dtcNodeExe = 'D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe'
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" stop "$dtcRoot\private\node.json"
```

等待这四个旧 PID 完全退出，确认正常停止已移除 node-session.json 和 supervisor.lock；再次检查页面账本没有 pending。STOP 已存在时先核对是否正在停止，不重复 stop。不要强杀 Node/Chrome，也不要删除未知会话或锁。仅在本次停止已完成后移除对应 STOP 文件。

3. 在权限受限且带时间戳的本地目录备份 `settings.private.json` 和整个 `private`。在内存检查旧 settings.site 与 Git site：忽略 selectedUrls 后必须完全一致；scope、queueScope、evidencePrefix 也必须一致。只允许把旧单商品白名单或已经是 null 的 `settings.site.selectedUrls` 改成 JSON null，不能改成字符串 `"null"` 或空数组。所有其他设置原样保留，包括 Codex executable/codexHome/model/reasoning、timeoutMs、浏览器 instanceId、inputs、证书与存储配置。用保留 NTFS 权限的原子写入保存，不打印配置正文。

4. 将旧 private 移到上述备份中，生成新的空 private，执行：

```powershell
& $dtcNodeExe "$dtcRoot\release\dtc-prepare.js" "$dtcRoot\settings.private.json"
& $dtcNodeExe "$dtcRoot\release\dtc-node.js" doctor "$dtcRoot\private\node.json"
```

必须核对生成的 private/dtc.json 中 `site.selectedUrls === null`，site 与 Git 完全一致；三个 runtime、routing 和原有 build ID 仍匹配。不要重跑首次安装的 prepare-windows.mjs。凭据、inputs、source-journal、browser-pages、source-cache、browser-model、Chrome Profile 和所有历史证据都保留。

5. 沿用之前已成功的后台启动方式，给本次创建独立日志目录，用 `Start-Process` 启动现有 release/dtc-node.js start private/node.json，并重定向 stdout/stderr。Chrome 保持原实例、仅监听 127.0.0.1:9222。等待三个角色 ready，连续四个采样周期 healthy=true 且心跳更新；如冷启动失败，按既有安全停止/恢复流程保留证据，不盲目循环启动。

6. 回报 Git commit、selectedUrls=null（仅此非敏感字段）、不变的两个 build ID、三个角色 PID/ready、supervisor PID、sessionId、四次健康采样以及日志路径。不要自行提交品牌采集请求；Mini 在确认两端范围一致后从正常 Brand 入口提交唯一的新请求。

本次是全目录商品覆盖测试，不把数量上限或目录 completion=unknown 当作全站耗尽证明。上轮目录发现 7 个商品链接，其中 Focus & Restore Stack 为组合装；本轮需要分别核对单品、组合装范围判定、全部画廊和目录是否还有分页/隐藏商品，不能把一个商品成功或所有已发现商品结束称为全站完成。
