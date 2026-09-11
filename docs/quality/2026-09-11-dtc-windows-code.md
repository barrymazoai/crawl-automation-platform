# Windows DTC 代码交付 · 2026-09-11

用户最终指定：停止 UU 远程操作，完成 Windows DTC 节点代码后交用户自行部署。本轮已完成这一代码交付范围；没有操作或部署远端 Windows，没有把 Windows SDK/CDP/登录/桌面服务模式标为通过。

交付包：[crawlv3-dtc-windows-20260911.zip](../../exports/crawlv3-dtc-windows-20260911.zip)；[校验值](../../exports/crawlv3-dtc-windows-20260911.zip.sha256)；[部署说明](../../apps/v3-workers/DTC_WINDOWS.md)；[配置模板](../../apps/v3-workers/dtc-settings.example.json)。包内没有凭据、node_modules 或私有部署配置。

## 实现

- 独立 `dtc-catalog-source`、`dtc-capture`、`dtc-file` 三个 Windows 浏览器角色，以及 Mini 26 个配套控制/Workflow/计划/标签角色的配置生成。共享资源许可继续走现有全局数据库，Windows 仅新建自己的浏览器容量，不复制模型账号额度。
- DTC 契约、稳定 selected URL 身份、目录派发与不可变证据、公共 ChannelProductPlans、逐原图下游输入、最终标签流封闭接线。目录下一页须有公开导航证据；不称目录或变体覆盖完整。
- Codex 只对公开 DOM 快照做有界节点选择；模型不获得脚本或浏览器工具。截图先保存，但当前不作为模型视觉输入。图库操作需配置允许的控件；挑战/用户接管立即停止。
- 通过固定实例、仅回环 CDP 创建任务页，持久化 intent/opened/close-intent/closed；弹窗归属由 `Target.getTargets` openerId 链识别。关闭前重新读取精确目标，关闭后有界只读复查消失。失去打开回执只按随机标记恢复，不重新打开或按域名扫关。
- 目录取证后关闭再 ready；产品保留到其原图浏览器阶段结束再关，OCR/模型仅使用已保存材料。成功、Review、失败、取消覆盖关闭路径；用户控制边界保留 pending。错误/取消的未知许可保留隔离。
- 异常退出恢复命令检查旧 Worker 退出、精确绑定的 Temporal run 已终止、实例未变、无用户接管，再执行原目标清理并保存证明；不自动释放模型等隔离许可。
- Windows 专用 supervisor、只读 doctor、STOP/IPC 优雅停止、配置与构建匹配检查。拒绝存在未清理意图时启动；异常保留锁和证据，无自动重拉起、无浏览器整进程终止。

具体入口：`apps/v3-workers/src/dtc-{live-worker,node,prepare,recover}.ts`；CDP 在 `packages/v3-acquisition/src/cdp-*.ts`；渠道模块在 `packages/v3-channels/src/dtc-*.ts`；产品工作流在 `packages/v3-product/src/dtc-catalog-workflow.ts`。

## 验证

- MacBook 仅执行 TypeScript 检查与构建，通过。
- Mini 独立测试目录 `windows-dtc-tests-final-20260911`：13 个文件、109/109 测试通过，其中 DTC 44 项、旧渠道 65 项。[机器可读结果](evidence/2026-09-11-dtc-windows/results.json)。
- 实际 HTTP/WebSocket 协议 fixture 验证 Chrome browser Target.getTargets 路由与 opener 链、固定实例及暂停；VM 执行实际生成的 DOM 与原图读取表达式，验证字节保真及拒绝跨界/无证据选择。此项不是 Windows Chrome 实测。
- Mini 真正启动隔离的本地 Temporal 测试服务，DTC 与原渠道均运行成功/失败/取消、延迟文件、标签 Worker 重启及历史回放，各 6 份，共 12 份。DTC 成功时页面 closed、浏览器许可 released；失败/取消页面 closed、许可继续 quarantined。[DTC 流水证明](evidence/2026-09-11-dtc-windows/dtc-stream-proof.json)、[旧渠道流水证明](evidence/2026-09-11-dtc-windows/channel-stream-proof.json)。
- 最终部署包在 Mini 使用虚拟凭据：三个 CLI 缺参数拒绝正常；配置重复生成幂等；26 个 Mini 角色的注册能力和构建 ID 与生成配置一致。[部署包证明](evidence/2026-09-11-dtc-windows/packaging-proof.json)。没有启动这些业务角色。
- 所有测试真实站点/模型/OCR/业务库调用为 0。测试证明中的 capture/download/OCR/text/vision 计数是 synthetic fixture 活动计数，不能解释为付费执行。

## 部署与剩余验收

用户在两端安装各自原生依赖，填写实际 source revision、站点策略、私有配置和本地路径，再运行 prepare；Mini 26 配套角色先就绪，Windows doctor/start 后检查三个角色就绪，最后把正常 Brand 入口 DTC 路由绑定到生成队列后试单。完整命令见部署说明。

Windows 原生 Temporal SDK、Codex 登录/模型目录、Chrome CDP 实例、现场网络/CORS、真实品牌选择器、交互桌面或服务账号模式尚未现场验证。首版是配置范围内的 selected URL 采集，不是通用所有 DTC 站点/全变体适配。

Plane #35/#39 保留 In Progress。本轮完成后向 Plane 追加交付摘要的命令被自动审批拒绝（认为内部路径/构建/测试信息向外部实例披露需要明确授权），没有写入；代码与本地交付不受影响。真实 Windows 部署由用户进行，不能把代码完成冒充整项实机验收。现有 Mini 常驻 manifest、业务数据库、R2 和旧 Review 未修改；没有新业务提交；源端验收后已整理 Git 发布，代码版本以仓库提交记录为准。

## 构建标识

- activityBuild：`74624415ece58a36583fb04a45cc7522b0b63940ea8fdeb6dab4d9ee6a9adbe9`
- workflowBuild：`dc7704c256905656f5140c0f2af7cc055cbb0fb6a825fe1b503a358b3f573e79`
- ZIP SHA-256：`7b835feadfe728cf317c149fc241c2e0735172103f633e15629be4f06cce6bab`

## Git 交付补充

用户明确指定发布到 `main`，并确认提交已核实不含真实密钥的凭据处理源码和测试假值。必要的 V3 基础代码与依赖一并交付；实际私有配置、运行日志、node_modules、构建 ZIP 与抓取产物不进入 Git。

推送前完成干净源码导出、完整工作区 frozen-lockfile 安装、`build:dtc` 及 `build:v3:live` 验证。核心实现提交为 `5b9071d`，界面提交为 `e4f08b6`；后续文档/执行规则提交与远端最终状态以 Git 历史为准。上文 ZIP 是本地交付记录，Git 用户从源码构建即可。
