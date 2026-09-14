# 其他 Worker 同类问题检查与本轮 10 个商品限制

## 批次数量

用户确认：在当前 100 个 Amazon 商品批次里再跑 10 个，完成后暂停。以开始核对时已收尾的 14 个为基准，本轮范围是第 15–24 个；不增加新商品，不改原来的 manifest、美国站或纽约 10001 条件。

新增 Temporal `runUntil` 信号及 `stopAfter` 游标。达到截止点后不再提交下一件；已启动商品完成收尾。截止点写入 Workflow 历史，并随 ContinueAsNew 传递，Worker 重启不丢失。`resume` 可清除截止点继续原批次，`pause` 仍保留原有暂停语义。

检查期间让第 16 个完成并暂时暂停，部署后向原 Workflow 发送一次 `runUntil(24)`。信号后的首次查询因旧批次大历史重新加载超时；随后只读核对确认 `stopAfter=24` 已生效，没有重复发采集任务。

北京时间 10:40 快照：游标 17，已提交 18 个，第 18 个 `B0FM63VY63` 执行中；`stopAfter=24`、无批次错误。该快照不代表这轮 10 个已经全部完成。届时暂停由 Temporal 执行，不依赖临时轮询脚本。

## 检查范围与发现

检查 Mini 的主部署 90 个运行单元、DTC 配套 26 个、批次 2 个，共 118 个；其中 117 个有 Worker runtime build ID，另一个是 `brand-web`，核对其进程入口及文件哈希。未发现运行进程与配置不一致。

必须区分“Worker 配置了旧代码”和“运行进程没更新”：此次发现的是前者。也按角色实际调用链分类，未将同一目录里打包但该角色不执行的函数当成缺陷。

1. Swanson 和 DTC 的文字、视觉、资源核验共 6 个角色仍使用旧停止证明发布器：claim 已存在但证明缺失时不能继续发布。已换成上一轮验证过的、仅针对已结束模型调用的不可变证明恢复发布器。
2. GNC、通用目录、Swanson、DTC 的 8 个实际使用资源 Gate 的 Workflow 角色仍缺少总体等待预算和同商品隔离状态传播。已换成含 `resource-recovery-bounds-v1` 的 bundle。
3. 两个 Amazon 批次角色增加持久截止点，保证本轮第 24 个收尾后暂停。

本轮逐个更新和重启了以上 16 个角色。其他 Worker 的 PID 未变，三个独立监控进程的 PID 未变。连续三次复查分别为 90/90、26/26、2/2 ready，所有适用角色的 build ID 匹配；此前发现的 6 个旧发布器和 8 个旧 Gate 均已替换。

Swanson、Amazon、DTC 的标签资源配置均确认 `reviewStopCheck=true`；未修改模型、标签质量规则、历史 Review 或资源许可记录。

## 兼容性与 Windows

- 新限量逻辑在 Mini 的真实 Temporal 中通过测试：达到截止点、跨 ContinueAsNew、Worker 冷重启、恢复后继续，以及异常恢复无法核实即阻塞。未执行真实网站或模型调用。
- 使用新 bundle 重放原批次 26,765 个事件，并重放 GNC leased、Swanson、共享标签、DTC 商品和目录共 5 份已完成历史，全部通过。GNC 独立 streaming 类型没有已完成样本；其组合执行由 leased 样本覆盖。
- 本轮没有在 Swanson、GNC 或 DTC 新发业务采集，验证的是历史兼容性和实际部署。Amazon 在原批次继续执行。
- Windows 本机文件和日志没有远程直接检查；从 Temporal 核对了正在运行的 DTC 节点会话，浏览器资源心跳 fresh/healthy，capture、catalog-source、file 三条 Activity 队列各有一个近期 poller。Windows 本轮未重启。
- DTC 更新的是 Mini 上的独立角色入口及各自 runtime 绑定，没有重新生成整套 Windows 部署包或改其凭据。实际选择性部署状态以 `private/deployment.json` 中的逐角色入口和 runtime 为准。

## 保护边界

未知或仍可能运行的外部调用仍保留许可，不能凭超时或 Review 自动释放。GNC 较旧入口没有启用同一套自动质量停止证明接口，本轮补齐其等待保护，保留既有证据恢复规则；没有将它描述成已具备 Amazon 的专用子流程恢复器。

普通业务产物仍使用原有不可变发布规则，本次没有放宽全局 claim 保护。标签内容待审与运行故障分开处理，未将 Review 改成成功。

## 证据

- [角色分类、前后 PID 和 build ID](evidence/2026-09-14-worker-resource-audit/audit-summary.json)
- [6 份真实历史重放](evidence/2026-09-14-worker-resource-audit/replay-results.json)
- [16 个角色部署及截止点回读](evidence/2026-09-14-worker-resource-audit/deployment.json)
- [Windows 节点和队列](evidence/2026-09-14-worker-resource-audit/windows-queues.json)
- [批次进度快照](evidence/2026-09-14-worker-resource-audit/batch-progress-summary.json)

私有配置、完整历史和原始运行日志保存在 Mini；本目录仅保留脱敏摘要。批次限量源码提交为 `5e51437`。
