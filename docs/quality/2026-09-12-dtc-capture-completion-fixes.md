# Innerbody 采集与收尾修复

源代码提交：21e828a。部署标识以 apps/v3-workers/deploy/innerbody/deployment.json 为准。

上一轮 request e5986151-021c-4ed5-a1cb-7e87e66cca98 已结算，7 个商品中 4 个收集成功、3 个终态待审；另外 4 条是网页文本解释产生的辅助待审。原始证据、Review 和关页账本全部保留。本次没有重发真实采集。

## 已实现

1. runHarvest 在 worker_cdp 下固定使用任务浏览器取得 HTML，避免 Shopify 默认主机请求钩子覆盖。普通空响应/传输失败允许一次有界 DOM 补采，核对实际 URL、响应状态、HTML 类型与长度。访问拒绝、权限或用户接管不触发补采。失败保存阶段和具体错误，空值也有明确统计。
2. bundle_or_pack 和既有排除 reason 均进入相同的原始证据验证；必须有对应 URL 的唯一排除记录、空 records 和无失败项，才能记为 skip。
3. 去掉要求代理重复完整补丁的诊断指令。实际脚本先检查语法，再按文件执行。宿主分别保存真实 CLI stdout、stderr、进程退出记录及根目录脚本，并保留原合并日志。底层 CLI 没有输出的补丁参数、Win32 错误仍未知；本次没有宣称修复 Codex 沙箱内部缺陷。
4. /5 标签策略确认一张完整图片后，HTML 留在原始证据里，网页文本模型不再执行；无完整图片才运行原有文本流程。全部原图仍须交付，缺图不能收集。新增 Workflow patch 保留历史命令顺序。
5. 正常返回的商品采集待审，只有在进程正常结束、精确页面关闭、部分证据和宿主 stop proof 上传完成后，才生成独立 capture_review 返回值。Mini 在释放之前核对任务、runId、原始结果和文件哈希；再经既有精确关页复查，释放 browser permit，写 DTC.CAPTURE_INCOMPLETE。超时、取消、用户接管、权限边界或证明失败仍隔离。没有改写通用资源 gate，也不把任意 Review 当作停止证明。
6. 针对当前未筛选的 Shopify /collections/all，宿主在原任务页面关闭前读取目录 DOM，并验证公开 products.json 第 1、2 页。只有完整商品集合与 DOM、目录结果一致且得到真实空末页，才能生成完成证明；原始响应随 projection 保留并在 Mini 重新核验。当前上限 100 商品；分页超限、筛选目录、其他平台及旧证据仍保持 unknown，不推断全站结束。

## 验证

- 本机仅执行 TypeScript 检查和构建，build:dtc 成功；22 个 JS。浏览器/流程测试均在 Mini。
- Mini 隔离目录 dtc-six-fixes-tests：9 组、147 项测试通过。包含真实 Temporal 商品流、取消、重启、关页和普通待审释放验证。
- 新增正常待审测试验证：核对失败保留两个 permit；二次关页未确认保留 browser permit；成功时 verify → model release → exact close → browser release。新历史离线回放通过。
- 上一轮 13 条业务/标签 Workflow 与当前节点会话，共 14 份真实历史回放通过。
- 旧目录截断测试原本未模拟 HTML 请求，导致真实网络超时；改成显式模拟返回值后通过，未放宽超时阈值。
- Mini 测试使用模拟商品和本地 Temporal 测试服务，无真实浏览器或模型调用，不改变原有业务事实。

## 部署和待现场验证

Mini 已于 2026-09-12 09:54 UTC 更新，DTC supervisor PID 4914，26 个配套进程 ready；原 90 个进程保持 ready、PID 56831 未变。连续四个采样 held=0、source guards=0，四项非 Windows 浏览器资源健康。Windows 浏览器资源报告 dtc_node_stopped，尚未升级或重新验收。部署和健康记录位于同机 dtc-innerbody-v2-20260911/six-fixes-roll.json 与 six-fixes-health.json。Windows 由用户侧 Codex 使用 WINDOWS_CAPTURE_COMPLETION_PROMPT.md 拉取 main、重建、校验并后台启动，复用原凭据。

仍需新一轮真实全站验收：Focus HTML 补采；Astaxanthin 根目录脚本实际创建和执行；Bundle 跳过；图片识别成功后无重复文本解释；普通待审自动释放；真实目录完成证明；全部任务精确关页。147 项测试和历史回放不能代替这些现场结果。
