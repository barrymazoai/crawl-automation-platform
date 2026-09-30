# GNC 营养核心准备：独立 Worker 与逐来源接线

2026-09-09 12:47：[Ego采集Worker](GNC_EGO.md)已真实完成447285字节HTML和4图候选的R2保存及独立回执核验。没有重新导航/点击；当前新证据prefix为`crawlv3-acceptance/ego-1b5c6c59-9e96-49f5-a185-41ffa9d5a5d8`。下一步从该新证据生成逐来源计划，接Ego host图片获取及既有核心/OCR/模型链；不是已入库，不重抓或复用旧代理身份。

2026-09-09 11:51：用户改用 Ego Lite，Mini 同一会话的一次移动/10秒长按已进入613701详情；OCR、Docker、Temporal预检通过。[证据](../../docs/quality/2026-09-09-gnc-ego-access.md)。尚未从该Ego会话提交采集Workflow，真实网络/采集绑定待接，不能当新页面全链完成。现有 `--authorized-pool-core-one` 仍配置旧原生鼠标，不作为新Ego路径直接启动；下面为历史接线记录。

2026-09-09 11:11：用户要求用现有授权先测，新Texas任务未更新app即完成真实约10秒原生长按，窗口保护本次未拒绝。最终站点仍挑战Review，核心/OCR/模型未调度。此前等待更新app不是必要前提，详见[实测后续](../../docs/quality/2026-09-09-gnc-native-mouse.md)。

2026-09-09 最新：核心单品入口已改可见浏览器并接入 [GNC 原生鼠标处理](GNC_NATIVE_MOUSE.md)，不调用 Codex 解决挑战。当前实机调用被旧 app 窗口匹配检查拦住，新 app 仅独立构建未安装；真实新页面全链仍待验收。下文更早的 headless/入口尚未执行为历史记录。

2026-09-09 10:09 后续：OCR 恢复后首次新浏览器核心入口已运行，Washington 固定 Profile 遇 `GNC.ACCESS_CHALLENGE`，1 Review/0入库，核心准备与 OCR/Codex 未调度。原页哈希、Review 保存、历史重放与资源释放通过；成功全链及常驻配置仍待验证。[实跑报告](../../docs/quality/2026-09-09-gnc-core-live.md)。下文“尚未执行”是此前阶段记录。

2026-09-09 09:48 后续：新入口全链预检中，Mini/Docker、默认 Clash 四端口、Temporal 两类实际连接正常，但 OCR `192.168.0.6:8081` 的 TCP 与健康检查超时，未提交新 Workflow，常驻配置未发布。[预检记录](../../docs/quality/2026-09-09-gnc-core-live-preflight.md)。

2026-09-09。新任务显式启用；旧 Workflow 输入、旧 Review 和旧队列保持原语义。当前已完成代码接线、Mini 模块/流程回归和真实核心 Activity 验收，**尚未发布常驻服务或执行新入口的真实浏览器全链**。

## 职责

完整页面准备完成后，文字分支调用 `prepareLabelCore`。输入为 `LabelCoreInputSchema`：产品 `owner` 和已持久化的 `fullDocument` 引用；输出为 `LabelCoreOutcomeSchema`：归属绑定的输入、核心文档引用和文本范围，**不把整段正文放进 Workflow 回执**。

`PrepareLabelCore` 读取完整文档、核对身份、解析其原始 HTML 引用，交给既有纯 `LabelCorePreparation`。后者保留原始证据，按确定性键发布核心文档并回读核验。成功即释放 Activity；下游消费者缺席不会占用它。一个请求处理一个产品页面，不是批次。

GNC 来源/最终清单模块只调用 `inspect`：重新核验原始 HTML 与已有核心文档，**没有发布核心文档的权限路径**。缺失不补造，不触发 OCR/模型。完整页面文档另存到 `manifest.admission.documents`，继续供包装解析使用。

图片下载 → OCR → 关键词 → 视觉分支不等待核心准备。最终汇合依旧等待各来源终态。失败回执、未知状态和缺失证据不能变成“没有成分”；在 GNC 清单/汇合环节保留分类 Review，不自动重试。

## 启动与路由

| role | capability | compatibility | 进程入口 |
| --- | --- | --- | --- |
| label-core-prepare | label.core.prepare | label-core-v1 | acquisition-worker.js |
| gnc-core-plan | gnc.label-plan | gnc-core-v1 | product-worker.js |
| gnc-core-source | gnc.label-source | gnc-core-v1 | product-worker.js |
| gnc-core-input | gnc.label-input | gnc-core-v1 | product-worker.js |
| product-core-assembly | product.label.assembly | label-core-v1 | product-worker.js |
| product-core-collect | product.label.collect | label-core-v1 | product-worker.js |
| gnc-core-stream-workflow | gnc.stream-label.workflow | gnc-core-v1 | product-workflow-worker.js |

均使用通用 `V3_WORKER_ENABLED=true` / `V3_WORKER_CONFIG`，由 `taskQueueFor` 生成队列。各角色可以独立启动与部署；不要把多个角色塞进同一个 Worker 配置。构建产物用既有 `scripts/build-gnc-live.ts` 生成（工作目录 apps/v3-workers），部署整个构建目录。

核心准备另需 `V3_ACQUISITION_LIVE_ENABLED=true` / `V3_ACQUISITION_CONFIG`，复用 acquisition 私有配置的 R2、当前主机缓存/日志目录和 Review 库连接；不需要浏览器、Clash、OCR 地址、Python 或 Codex 凭据。其他角色沿用各自现有配置；模型配置仍在对应模型 Worker 内。

`GncStreamingLabelWorkflow` 新输入必须同时提供：

- `input.corePolicy = "gnc-label-core/1"`；
- `queues.core` 指向独立核心准备队列；
- plan/source/manifest 指向 `gnc-core-*` 角色；
- assembly/collection 指向 `product-core-*` 角色。

核心标记与队列不配对时，Workflow 在派发前拒绝。GNC core 与旧 label 角色双向拒绝错误策略路由。最终清单显式保存 `label-packaging/1` + `label-typography/2`，不能遗漏后按旧比较策略处理。

Mini 单品拥有者脚本新增 `--authorized-pool-core-one <新建的 crawlv3-gnc-pool.*/live>`，负责上述角色接线、既有默认 Clash 会话和资源释放；本轮仅构建，**没有执行这个浏览器入口**。不自动修改网页/API配置或替换常驻 Worker。

## 验证入口

`--authorized-core-activity <新建的 crawlv3-gnc-saved.*/live>` 只启动编排与核心准备两个 Worker，经真实 Railway Temporal 读取已授权保存单品证据。独立 `LabelCoreWorkflow` 只调度一次核心 Activity；没有 OCR/模型/浏览器任务。核验脚本 `mini-gnc-live-verify.mjs ... --summary` 只输出计数与状态，完整证据留 Mini。

本轮结果和具体证据见 [验收报告](../../docs/quality/2026-09-09-gnc-core-worker.md)。下一步是受限新入口全链验证与常驻配置接入；这不等于 Brand 批量稳定性或其他 Adapter 已通过。
