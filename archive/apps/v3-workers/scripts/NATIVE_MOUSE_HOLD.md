# macOS 原生鼠标长按工具（本机测试版）

2026-09-09 11:11：按用户要求直接使用现有已授权版本，新Texas任务完成真实113个移动事件和10001.67ms长按，窗口检查本次通过；最终仍GNC挑战页。**没有安装下面的暂存修正版，没有要求重新授权**。新版三项权限检查false、已安装版true，仅说明两个应用版本运行态不同；暂存版不影响已安装版继续使用。

2026-09-09 更新：GNC Adapter 已按用户要求直接调用该应用（不经 Codex），见 [接线说明](../GNC_NATIVE_MOUSE.md)。已安装版实测在 AX 窗口匹配时拒绝，未发送输入。新源码保留精确 PID/windowId/title/bounds 和地址栏校验，按 AX 几何匹配目标并记录匹配数量；Mini 独立构建与 14 项无输入自测通过。修正版位于 `/Users/barry/apps/crawler-mouse-window-update.fVeXjN/Crawler Mouse.app`，尚未覆盖 `/Applications` 已授权版，可能需用户重新授权。以下“尚未接入 Temporal”是旧状态，不代表新 Adapter 未接线；整条验证码实机成功仍未验收。

用户明确要求自定义原生鼠标工具后实现。它独立于 `cua_repl`，不是给现有 CUA 的 `click` 加一个不存在的参数，也没有修改 Codex。

默认仅允许 Google Chrome 中标题精确为 `CUA Pointer Lab — 本机鼠标测试` 的自建测试窗口。后续按用户对具体 GNC 会话的当次确认新增了严格目标入口：请求必须显式提供 `expectedTitle: "Access to this page has been denied"` 与 `expectedUrl: "https://www.gnc.com/energy/613701.html"`，按住上限 10000ms，并在执行前通过原生 AX 核对地址栏。其他目标拒绝执行。不要通过改网页标题冒充测试页。尚未接入人工确认恢复或 Temporal，也没有完成 GNC 长按验收。

## 独立应用与人工授权

2026-09-08 已新增 `build-crawler-mouse.mjs` 与权限引导 UI，Mini 当前安装路径为 `/Applications/Crawler Mouse.app`，bundle ID `net.supplysmart.crawler-mouse`。最初安装在用户的 `~/Applications`，用户在标准应用程序目录找不到，后已完整移动到 `/Applications` 并用 Finder 显示；此次仅移动路径，未修改二进制或签名。通过 LaunchServices（Finder 或 `open`）启动，无参数只显示权限状态，不发送鼠标事件、不自动请求权限。

用户点击“申请辅助功能”“申请屏幕录制”，再在系统设置中亲自授权 Crawler Mouse。窗口定时刷新权限，必要时按系统提示退出并重新打开。不需要完全磁盘访问。该应用允许看到屏幕和控制鼠标，权限由系统按应用管理，不是仅对 Chrome 生效；代码当前仍仅允许自建测试窗口。

应用自身只将权限布尔值、时间、bundle ID、路径和 PID 写入私有 `~/Library/Application Support/Crawler Mouse/permissions.json`。远程检查优先读取该文件并核对进程/时间；不要用 SSH 直接执行裸程序的权限结果推断 LaunchServices 启动的应用身份。构建器拒绝覆盖现有应用；当前使用 ad-hoc 签名，后续更换二进制可能需要重新授权，不能保证跨更新保留 TCC 许可。

**已实证的更新限制**：接入精确 GNC 目标后，旧版的 cdhash 指定要求发生变化，Mini 更新版的三项权限全部回到 false。原授权没有被代码清除，程序也没有修改 TCC；需要用户给更新版重新授权。旧 app 完整保留于 Mini `/Users/barry/apps/crawler-mouse-update.Sl4vFF/previous.app`。当前安装版本已包含上述 GNC 目标字段，后续测试先检查权限和会话，不把之前的一次确认用于变化后的挑战。

```sh
node apps/v3-workers/scripts/build-crawler-mouse.mjs "/absolute/path/Crawler Mouse.app"
open "/absolute/path/Crawler Mouse.app"
```

## 构建与只读检查

需要 macOS 的 Swift 编译器及 SDK；编译后的工具使用系统框架，无 npm/Python 运行依赖。运行时必须已有辅助功能/事件发送权限；读取窗口标题还需要录屏权限。工具仅检查权限，不申请或修改系统权限。

```sh
mkdir -p /tmp/crawlv3-native-mouse-build
swiftc -module-cache-path /tmp/crawlv3-native-mouse-build/module-cache \
  apps/v3-workers/scripts/native-mouse-hold.swift \
  -o /tmp/crawlv3-native-mouse-build/native-mouse-hold
/tmp/crawlv3-native-mouse-build/native-mouse-hold --self-test
/tmp/crawlv3-native-mouse-build/native-mouse-hold --inspect
```

`--inspect` 不发送鼠标事件，只列出测试窗口和权限状态。

## 调用协议

通过 `--hold '<JSON>'` 传入：

```json
{
  "pid": 12345,
  "windowId": 678,
  "bounds": [0, 30, 1920, 996],
  "xRatio": 0.5,
  "yRatio": 0.35,
  "moveMs": 1200,
  "settleMs": 300,
  "holdMs": 10000
}
```

这是字段示例，不能直接复用 PID、窗口 ID 或坐标。必须先通过最新截图定位按钮，再用 `--inspect` 返回的系统窗口信息填写请求。比例坐标相对于整个窗口，不是网页内容区域。`bounds` 用于拒绝执行前或执行中已移动/缩放的窗口。macOS 全局坐标以主屏左上角为原点，支持目标位于其他屏幕。

### 按下前路径（源码新增，Mini 已授权应用尚未更新）

可选字段 `movePath` 是至多六个 `[xRatio,yRatio]` 中间点；只允许窗口内 x=0.05–0.95、y=0.15–0.9，必须根据当次截图选择安全的页面区域。工具从当前鼠标位置逐段移动，最后到原 `xRatio/yRatio` 指定的按下位置。`moveMs` 仍是全路径总时长，不是每一段时长，沿各段按距离分配时间并使用确定性的 smoothstep 插值。省略字段保持原直线路径；路径和目标都与当前位置相同时，不再发送无意义的同坐标移动事件。

自建测试页的请求可以加 `"movePath": [[0.3, 0.45], [0.4, 0.4]]`，但这些只是语法示例，不是任何实际网页的操作坐标。按住期间不移动，没有随机轨迹、事件来源伪装、自动确认或自动重试。

新增 `MOVE_COMPLETED` 记录系统事件的发送数量与路径长度；这不是页面接收证明。测试页独立记录按下前五秒的 `pointermove` 事件数、路径长度、`isTrusted` 和限量采样点；同点事件、旧轨迹、上一轮轨迹不算本轮移动证据。只保留最近十轮，避免超过本机服务的请求大小限制。

`node --test apps/v3-workers/scripts/pointer-evidence.test.mjs apps/v3-workers/scripts/pointer-lab-events.test.mjs` 验证页面测量逻辑，其中 VM 输入是假事件，仅用于单元测试，不能算真实鼠标验收。原生 `--self-test` 验证路径插值和输入边界，不发送输入。

**部署边界**：此修改尚未覆盖 Mac mini 的 `/Applications/Crawler Mouse.app`，避免静默更换签名导致刚授予的权限失效。新增路径尚无 Mini 原生输入验收，不能声称已经解决第三方验证。正式安装新二进制后可能需要用户重新授权。

流程：校验 → 独占锁 → 激活并核对窗口 → 用 smoothstep 插值平滑移动 → 停留 → 左键按下 → 单调时钟计时 → 左键松开。

- 移动时长 200–3000ms，停留 0–1000ms，按住 100–15000ms。
- 移动路径是确定性的，不含随机轨迹、指纹伪装、验证码逻辑或自动确认。
- 同一用户的该工具实例通过 POSIX 锁串行；**这个锁不会限制其他 CUA 实例或用户的鼠标**，业务编排以后仍需统一占用桌面。
- 错误、SIGINT、SIGTERM、SIGHUP 在正常可执行清理的情况下会发送松开事件。切换前台窗口、移动/缩放目标窗口、鼠标偏离预期位置也会取消。
- 多屏遮挡判断针对目标坐标，不要求目标窗口排在整个桌面的窗口列表第一位。
- **SIGKILL、进程崩溃、系统冻结不能保证执行清理；当前没有独立 watchdog。** 不应把本版本当作已完成无人值守的生产级输入服务。
- 工具输出 `DOWN_POSTED` / `UP_POSTED` 仅说明已发送系统事件，必须另以目标页面证据验收。

## 当前电脑真实验收（2026-09-08）

编译及无输入自测通过。已有权限为 accessibility/postEventAccess/screenRecording 均 true，没有修改权限。

1. 平滑移动 1200ms，停留 300ms，要求按住 10000ms：工具计时 10004.37ms；页面实际 `pointerdown` → `pointerup` **10003ms**，`trusted: true`，最终 `down: false`。
2. 再次按下后约 1500ms 对本次工具进程发送 SIGTERM：工具输出 `EMERGENCY_RELEASE_POSTED` / `CANCELLED`，退出 1；页面记录 **1545ms**，最终 `down: false`。

页面上第一条长按通过；第二条是取消回归，不算第二次十秒成功。按住期间未移动，`moves: 0` 是预期；当前页面尚未统计按下前的移动轨迹，因此平滑移动的页面轨迹验收不在本次证据中。

自建页面原始证据摘录见 `docs/quality/2026-09-08-native-mouse-hold.json`。当前仅验证当前电脑，不声称 Mac mini、Windows 或任何第三方人机验证已通过。
