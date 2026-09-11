# GNC Adapter 原生鼠标接线

> 2026-09-09 11:51：用户后续决定改用 Ego Lite，已完成一次真实 GNC 访问验证。[当前规程](GNC_ACCESS_RUNBOOK.md)覆盖本文默认原生路径；代码仍保留、未卸载已授权 app，不作为 Ego 的自动后备。下文为此前实现历史。

此前漏传轨迹的单页验证也已实际完成：`crawlv3-gnc-review-browser.PmPyLU/path-attempt-EEBDI4` 记录同 Washington 会话的三个中间点、116次移动、约918px、长按10001.789ms，随后进入613701详情。不是完整Workflow验收。11:51轮检查旧Chrome端点时标签列表已为空，不能继续声称该旧产品标签仍可复用；当前保留的是Ego产品页。

2026-09-09 用户明确要求：是 **GNC**，不是 GenAI；访问挑战直接调用已有鼠标工具，不用 Codex/CUA 模型处理。

## 当前流程

**2026-09-09 11:20 后续修正**：此前 Adapter 漏传 `movePath`，原生工具的轨迹功能没有被删除或覆盖。现在 `holdRequest` 显式生成三个基于当前按钮/视口的中间点，限定在已安装原生工具的坐标范围内，移动时长和长按时长不变。不是照搬昨日窗口的固定坐标；不代表本站新轨迹已经实测通过。

用户要求失败时保留现场：Mini 核心入口现在设置 `nativeMouse.keepChallengeOpen=true`。挑战页不会被 CDP Reader 关闭；Review 后停止采集 Worker/其他业务进程、保存数据库快照并停止测试库，只留轻量拥有者与浏览器、Profile/Lane 独占。`report.browserReview.status=waiting-for-user`，没有超时关闭。直到用户明确要求关闭，在运行目录 `release-browser.json` 写入 `{ "sessionId": "本次sessionId", "release": true }`，才关闭原浏览器并释放 Lane。此前关闭/释放断言核验脚本应在显式释放后运行，不把现场保留误报为泄漏。

最终未通过时新增 `after.html`、`after-dom.json`（包含 iframe 文本）与 `after.png` 留证，避免只有按下前截图、无法判断“再试一次”。当前只是代码/隔离验证，尚未用新多段轨迹再点 GNC；不改用户正在看的页面。

现场查看入口 `scripts/mini-gnc-review-browser.ts` 不提交 Workflow、不调鼠标/OCR/模型，也不自动关闭。当前 Mini 会话 `/Users/barry/apps/crawlv3-gnc-review-browser.PmPyLU`，Washington 固定 Profile、Chrome PID 22009、拥有者 PID 21996。只读核对页面为挑战页，保持给用户查看。这是新会话，无法恢复上一轮已经关闭的动态“再试一次”提示。关闭它须用户明确要求后向该目录 `release.json` 写入匹配的 sessionId/release；不要混用业务入口的 release-browser.json。

`captureGncProduct → 当前可见 Chrome 页面 → 检测挑战 → 定位按钮 → Crawler Mouse.app 单次尝试 → 核验真实产品页 → 正常采集或 Review`

- `gnc-product` 私有配置可选 `nativeMouse: { browserPid, profilePath }`，必须匹配当前拥有的可见 Chrome 进程、持久 Profile 和单品授权。其他 Adapter/角色不受影响。
- Mini `--authorized-pool-core-one` 新测试入口默认开启；仍使用默认 Clash、四 Lane 正常分配、运行中固定出口和 Profile。旧 `--operator-ready` 仅作人工调试入口。
- 当前受限目标只有 `https://www.gnc.com/energy/613701.html`。**尚未泛化到任意 GNC 产品或 Brand**。
- 在同一个已有标签页通过 CDP DOM 读取 iframe/shadow DOM 的 `Press & Hold` / `Press and Hold` / `按住` 按钮，核对实际命中元素；使用协议窗口/视口尺寸，不硬编码页面坐标。最多等待当前页面按钮 30 秒，不刷新重试。
- 通过 LaunchServices 启动已安装的 `/Applications/Crawler Mouse.app`。不使用 `open -W`：实机曾出现应用已输出有效结果但 `kevent` 等待失败。只接受本次新建私有文件中的完整工具回执。
- 发送参数为移动 2200ms、停留 300ms、长按上限 10000ms；没有随机轨迹或无限重试。鼠标独占、窗口/地址核验、用户接管及紧急释放仍由原生工具负责。
- R2 保存挑战原页、定位结果、截图、目标、单次执行意向和结果，旧证据不删除。不确定是否执行时不再次输入。`attempts=1` 仅表示调用过工具，实际按下/释放必须看 `DOWN_POSTED` / `UP_POSTED`。
- Codex 调用数为 0。按钮进度/鼠标回执不是通过证明；仍由 GNC 解析器核对目标 SKU、页面内容和 HTTP 状态。未通过维持 `GNC.ACCESS_CHALLENGE` Review，详细鼠标原因另存 `v3/gnc-mouse/<operationId>/result.json`，不误报缺成分。

## 当前验收状态

**11:11 后续实测覆盖下方“等待更新”结论**：用户要求先用已有授权继续，已安装版三项权限 true；不替换应用的新 Texas 任务成功完成移动与 DOWN/UP（长按 10001.67ms），未重现窗口匹配失败。但最终仍是挑战页，1 Review/0入库。因此更新应用不是继续测试的必要前提；暂存几何修正版保持未安装。旧窗口失败原因仍未确定，不能据一次通过宣称稳定。详见报告末尾本轮记录。

详见[真实记录](../../docs/quality/2026-09-09-gnc-native-mouse.md)。29 项 Mini TS 回归通过；新原生源码 14 项无输入自测通过。最新真实任务已找到中文按钮并直接调用工具，但已安装旧版在 AX 窗口匹配阶段返回 `AMBIGUOUS_LAB_WINDOW`，**没有按下鼠标，尚未证明新入口可通过验证码或成功入库**。

原生匹配修正版仅构建在 Mini `/Users/barry/apps/crawler-mouse-window-update.fVeXjN/Crawler Mouse.app`，未替换已授权版本。它以已核验的 WindowServer PID/windowId/title/bounds 匹配 AX 窗口几何，随后仍核验地址栏；没有移除目标保护。安装更新可能改变 ad-hoc 签名并要求重新授权，当前等待用户选择。

下一步：保留已授权 app，按实际页面与回执区分访问失败和工具失败；后续需要继续验证站点通过率与新页面全链。不要把升级/重新授权作为默认前提；未通过保留分类 Review，不改旧任务、不发布常驻配置。当前默认移动为直线平滑移动，未复用昨天具体截图会话的多段 movePath，不能把两次操作声称为完全相同条件。
