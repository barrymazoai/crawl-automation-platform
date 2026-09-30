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


## 2026-09-12：真实采集写入日志

Windows c81fe79 的新目录任务仍在 file_change/add 创建 capture/run-catalog.mjs 时失败，尚未进入采集；原始工具未保留补丁输入，也没有明确权限拒绝信息。同工具在另一个诊断目录创建文本成功，不能据此判断任务目录的失败原因。

上次请求 a6927780-fee0-41ae-ac68-11425be391b6 的精确关页记录由用户转交 Windows 核验结果；Mini 核对任务身份、终态和对应占用后留存恢复证据并正常释放，父任务结算为目录未完成、发现 0 个商品。没有修改历史 Review，没有将失败算作采集通过。

源码 3498f6a 增加真实执行前后路径状态，以及 Windows 只读身份/ACL 检查；代理写入前记录 DTC_WRITE_INTENT，写入后记录 DTC_WRITE_RESULT，失败后再只读检查一次。宿主单独保留 write-diagnostic.json 并尝试发布 R2。实际补丁输入的收集依赖代理执行指令，尚未现场验收；没有认定或修复某个未经证实的权限根因。

Mini 上 30 项采集宿主、节点控制和目录 Workflow 回归通过；build:dtc 通过，22 个 JS。Workflow bundle 与此前 14 份历史回放通过的文件逐字节一致。2026-09-12 06:54 UTC 仅切换 DTC 26 个角色到日志版本；基础 90 个角色保持原进程。随后四个周期均 90/90、26/26 ready，5 项资源心跳健康，零占用、零来源锁。Mini 部署证据为私有部署目录的 write-logging-roll.json、write-logging-health.json。

Windows 尚未更新本次日志版本，也未发新任务。下一步执行 [WINDOWS_WRITE_LOGGING_PROMPT.md](WINDOWS_WRITE_LOGGING_PROMPT.md)：正常停机，精确归档已结束任务的本地工作目录，保留关页账本原路径和所有原始证据，更新 release 后核对并后台启动。Windows 报告新版本 ready 后，由主会话通过 Brand 创建新的全目录请求。用户已改用真实任务日志方案，不执行之前建议的写入矩阵诊断。


## 2026-09-12：主采集脚本固定到任务根目录

用户转交 Windows Codex 0.153.4 的局部复现：同一无害 .mjs 经 file_change/add 在任务根目录成功，在已有 capture 子目录失败，相对路径也失败；三次自动审批均 allow。日志没有底层 Win32 错误，尚未确定具体 CLI 缺陷。该复现使用保留会话的诊断执行，不能冒充完整生产重放。

用户同意先采用任务根目录方案。源码 0178961 统一 cwd、Prompt 的任务目录、CRAWL_WORKER_SCRIPT_PATH 和宿主前后诊断目标；主程序固定为根目录 run-catalog.mjs / run-capture.mjs，旧采集器的 outDir 仍为 capture，HTML/图片/商品证据保持原交付路径。没有更改模型、审批参数、ACL 或 CLI 版本，也没有迁移 Worker 或新建 D 盘顶层目录。原始工具输入的留存问题仍单独保留，不能将代理复述当成原始补丁。

build:dtc（含 TypeScript 检查）通过，22 个 JS。Mini 上 32 项隔离回归通过，涵盖目录/商品脚本位置与实际前后诊断、原始证据交付、失败/取消/用户接管关页边界及节点控制。首次运行缺测试夹具环境参数，补充现有 V3_CHANNEL_FIXTURE_ROOT 后全通过。Workflow bundle 与已通过 14 份历史回放的版本逐字节一致。

d58c30f6 本轮 Windows 关页证明经身份核对留存 R2 后，仅释放对应许可；父任务正常结算，目录未完成、发现 0 商品。没有重发旧任务或修改历史 Review。Mini 07:59 UTC 正常切换 DTC 26 个角色至新构建，基础 90 个角色保持原进程。部署证明在私有目录 root-script-roll.json，连续健康核验在 root-script-health.json。

Windows 尚未更新本次版本。执行 [WINDOWS_TASK_ROOT_SCRIPT_PROMPT.md](WINDOWS_TASK_ROOT_SCRIPT_PROMPT.md)，就绪后再由主会话从正常 Brand 入口发新的全目录请求，验证真实程序创建、执行、证据写入和关页。不能把根目录最小写入成功或 Mini 隔离回归当成 Windows 整条业务链通过。

最终四周期：基础 90/90、DTC 26/26 ready，其余四项配套资源健康，held=0、source guard=0；Windows 旧会话在 Mini 维护期间报告 dtc_node_stopped，待本机核对进程并更新启动，不能算作新 Windows 版本已就绪。
