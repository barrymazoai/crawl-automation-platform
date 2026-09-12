# Innerbody 待审修复：检查后再部署

用户于 2026-09-12 明确要求：先完成代码修改，再由 Windows Codex 检查写入问题；主会话根据诊断结果继续修复，最后统一部署并开始下一轮。当前没有授权立即提交新一轮业务采集。

当前实现：

- Channel label `label-image-first/5`：逐图执行 OCR/识别，首张完整且通过证据校验的标签成为唯一图片来源，停止其后 OCR/模型调用。原图仍全部交付并验证，页面关闭与流封闭仍是最终交付条件。
- 原图 URL 中的平面标签/成分表名称只用于尝试顺序，不能作为“识别成功”的证明；缺少名称提示时保留原图顺序。完整性由留存的识别结果校验决定。
- 在确定完整图片标签的情况下，已执行并核实身份的 `TEXT.CITATION_INVALID` 只留下警告；丢失回执、证据或身份异常仍阻止入库。若一次 Review 没有可核实的停止证明，不会继续占用另一份模型资源尝试下一张。
- `label-vision/5` 明确同义名称、商标和来源说明的换行仍属于同一成分，不能仅凭换行推断 blend_total/blend_component。模型和推理档位保持原值。
- `bundle_or_pack` 经原始 harvest 排除记录、空 records、准确 URL、R2 哈希以及正常关页验证后，写入 `catalog_product_skip`，显示“按规则跳过”，不写入 Review 或 collected_product。历史 Review 保留。

已验证：Mini 隔离回归 122 项通过；14 份真实历史（上一批完整父子链及 Windows 节点会话）回放通过；Worker/API/Web TypeScript 检查、build:dtc 通过。测试提供方为模拟或无网络子进程；数据库验证使用独立临时 PostgreSQL 容器，测试后删除该容器。未修改运行中 release，未执行真实补采。

下一步：把 `WINDOWS_WRITE_DIAGNOSTIC_PROMPT.md` 交给 Windows Codex，只检查旧任务及同环境最小写入，不部署、不改权限、不发单。取得结果后，由主会话判断是否需要修改启动方式或采集指令。

最终部署必须一起处理：

1. 以最终 main 构建，两端核对 deployment.json 的两个 build ID、JS 数量与识别指纹。
2. Mini 通过原有迁移工具备份并应用 `017_catalog_product_skip.sql`。仅是同一个业务库增加跳过结果表；Windows 不连接该库。Brand API/Web 的跳过统计同时更新，Brand 入口独立部署，不能覆盖其他 Worker 的共用构建目录。
3. Mini 和 Windows 各自 settings 指向的 baseLive 中，将 `evidencePolicy`、`visionConfigFingerprint`、`sourceVisionConfigFingerprint` 同步为 deployment.json.channelDefaults 的新值。只原子更新这三个公开策略字段，备份原文件，其他路径、模型配置和凭据原样复用。Mini 的实际 CodexVisionProvider.describe 指纹必须再次与公开值一致；不凭手填指纹绕过校验。
4. 按正常流程停止旧节点、确认精确 PID 退出及无 pending 页面；完整替换 release，生成新 private，完成 routing/doctor、健康采样。全部条件齐备后，再从正常 Brand 入口提交新任务。

本轮候选代码的部署标识记录于 deployment.json；若诊断后再改代码，必须重新构建、验证并更新标识。当前主会话的旧部署回执不能证明本候选版已经上线。
