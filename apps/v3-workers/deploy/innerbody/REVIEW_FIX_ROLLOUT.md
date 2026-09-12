# Innerbody 待审修复：统一部署记录

用户于 2026-09-12 明确要求：先完成代码修改，再由 Windows Codex 检查写入问题；主会话根据诊断结果继续修复，最后统一部署并开始下一轮。Windows 更新完成并核对就绪后，才开始下一轮真实业务采集。

当前实现：

- Channel label `label-image-first/5`：逐图执行 OCR/识别，首张完整且通过证据校验的标签成为唯一图片来源，停止其后 OCR/模型调用。原图仍全部交付并验证，页面关闭与流封闭仍是最终交付条件。
- 原图 URL 中的平面标签/成分表名称只用于尝试顺序，不能作为“识别成功”的证明；缺少名称提示时保留原图顺序。完整性由留存的识别结果校验决定。
- 在确定完整图片标签的情况下，已执行并核实身份的 `TEXT.CITATION_INVALID` 只留下警告；丢失回执、证据或身份异常仍阻止入库。若一次 Review 没有可核实的停止证明，不会继续占用另一份模型资源尝试下一张。
- `label-vision/5` 明确同义名称、商标和来源说明的换行仍属于同一成分，不能仅凭换行推断 blend_total/blend_component。模型和推理档位保持原值。
- `bundle_or_pack` 经原始 harvest 排除记录、空 records、准确 URL、R2 哈希以及正常关页验证后，写入 `catalog_product_skip`，显示“按规则跳过”，不写入 Review 或 collected_product。历史 Review 保留。

已验证：Mini 隔离回归 122 项通过；14 份真实历史（上一批完整父子链及 Windows 节点会话）回放通过；Worker/API/Web TypeScript 检查、build:dtc 通过。测试提供方为模拟或无网络子进程；数据库验证使用独立临时 PostgreSQL 容器，测试后删除该容器。未修改运行中 release，未执行真实补采。

Windows 写入诊断已完成：旧任务确实尝试创建 capture/run-capture.mjs，工具只报 Failed to write file，没有明确权限错误；同一 Runner 最小写入、读回、删除成功。根因仍未复现，不能归因为全盘只读。源码 072a916 增加任务路径核对与有边界的写入失败处理指令：只读核对已写文件，确认路径问题才能纠正后重试一次；明确拒绝立即停止；未证实的失败单独报告。没有改模型、审批参数或 ACL，也没有自动重跑整个采集。该指令的现场效果仍待下一轮真实任务验证。

本次追加验证：Mini 上采集宿主、节点控制和目录 Workflow 共 29 项通过；build:dtc 与前端构建通过。最终 Workflow 可执行文件与已通过 14 份回放的候选文件逐字节一致。本次 build ID、源码祖先和策略字段见 deployment.json。

Mini 部署包含：

- 使用现有 migrate 事务/迁移账本实现，先保存数据库快照备份，再应用 017_catalog_product_skip.sql；仍是原有业务库。
- DTC 从共享的 Swanson 基础配置复制出自己的私有输入，只更新 evidencePolicy、visionConfigFingerprint、sourceVisionConfigFingerprint，Swanson 原文件保留。实际 CodexVisionProvider.describe 指纹已与公开值核对。
- Brand API 与新前端独立部署；没有覆盖 Amazon 共用的构建目录。
- 首次两组进程并发启动触发 PostgreSQL “too many clients already”，9 个基础角色启动失败。随后正常停机，改为基础 90 个角色先就绪，等待空闲连接回收，再启动 DTC 26 个角色。没有修改连接上限。
- Windows 旧节点在 Mini 维护期间报告 dtc_node_stopped；不得将它算作新版本已就绪。Windows 部署说明要求本机先核对精确 PID、会话、锁和页面账本，再更新启动。

最终核验通过：基础 90/90、DTC 26/26 连续四周期就绪，其余四项配套资源健康；零占用、零来源锁。数据库原有 17 条 collected_product、47 条 review_record、121 条 processing_result 的数量和内容摘要逐项一致。新 Dashboard 跳过统计及前端资源均可读取；Windows 旧会话以 stopped 结果正常结束。

Mini 最终核验记录保存在本机部署目录的 review-fix-20260912.json；数据库备份在 backup-review-fix-20260912/database。真实凭据、数据库备份和执行原始日志不进入 Git。

下一步：将 [WINDOWS_REVIEW_FIX_DEPLOY_PROMPT.md](WINDOWS_REVIEW_FIX_DEPLOY_PROMPT.md) 完整交给 Windows Codex，从 main 构建并更新，复用现有凭据。除了换 release，还须复制基础配置并同步三个公开策略字段，生成新的 private，核对 routing、doctor、Skill 和四个健康周期。本轮尚未提交新采集；历史待审不自动改成通过。
