# GNC 当前访问验证处理规程

## 2026-09-09 12:47 Ego 只读采集 Worker 已接通

[Ego运行配置](GNC_EGO.md)已接现有 `gnc-product` 角色。真实Railway→Mini三个独立Worker完成当前标签页采集、R2保存及回执核验，4图候选与Facts DOM保留；不是只有Agent访问成功。此入口不导航/点击/接管/关闭，用户控制或页面不匹配直接停止，不自动回退。旧核心 `--authorized-pool-core-one` 仍是原生入口，不用它启动Ego主线。图片host会话获取及完整处理仍待后续。下方“Worker尚未接入”已被本节覆盖。

## 2026-09-09 11:51 最新决定：优先 Ego Lite

用户已安装 Ego Lite，要求下一次访问验证用它操作，不再默认回退原生鼠标或 Codex。Mini 已用 Ego 实际通过一次 GNC 613701 验证，详见[证据与边界](../../docs/quality/2026-09-09-gnc-ego-access.md)。task space 1 的产品页已保留。

这次为 Agent 经 Ego CLI 操作，不是 Worker 自动恢复已上线。`mini-gnc-live-run.ts --authorized-pool-core-one` 目前仍自动配置 `nativeMouse`；接线更新前，不直接运行它作为新 Ego 主线。Ego 默认网络未与四 Lane 建立证据绑定，不复制旧 Chrome 的 laneId/Profile 声称等价，也不同时启动旧工具。

Mini 与 MacBook 的 Ego SDK 版本不同：Mini 使用 `useOrCreateTaskSpace` / `cliLog` / `cdp`，等待单位秒；MacBook 使用 `taskSpace` / `page`，单位毫秒。每台按安装的 Skill 操作。同一任务复用 task space；用户接管、权限拒绝时停止，失败保留现场，不无限重试。此节覆盖下方原生鼠标默认路径；下方内容仅为历史。

## 2026-09-09 当前主线（覆盖下方历史规程）

11:11 实测：现有已授权 app 在新Texas单品任务成功发送移动与10秒长按，未更新应用、不需本轮重新授权；最终仍挑战页进入Review。窗口匹配失败本次未重现，原因未确定，不能把暂存修正版当已部署。继续按已授权版本工作，不把升级/重新授权设为默认前置门槛。

用户明确：**GNC Adapter 直接调用已有原生鼠标工具，不调用 Codex/CUA 处理挑战**。当前受限核心单品入口已接线：可见 Chrome、固定出口/Profile、实时定位按钮、一次鼠标工具调用，之后按真实产品页判定继续或 Review。无需经过旧模型确认桥接；不修改系统权限。具体范围、配置、失败分类与当前阻塞见 [GNC_NATIVE_MOUSE.md](GNC_NATIVE_MOUSE.md)。最新旧app窗口保护拒绝输入，新app仅构建未安装；不是验证码成功验收。

下文保留为 2026-09-08 历史，旧 `--captcha-current` / 人工回复通道不是当前 GNC Adapter 默认路径，不据此重新接入 Codex。

2026-09-08 用户确认采用。保留已有效的操作方式，继续单品链路；本轮不继续扩展反爬调优。

2026-09-08 21:08 当前交接：用户明确暂时固定访问处理方式，转回其他步骤。[原生路径/长按及 Virginia 单次产品页证据](../../docs/quality/2026-09-08-native-prepress-path.md)已补充；下方“未测精确时长”等是更早阶段记录。新的 Texas headless 采集遇挑战按 Review 停止；随后完成[保存证据下游并发与登记验证](../../docs/quality/2026-09-08-saved-label-workers.md)。当前下一步不是继续调验证码或复用已过期确认，不重启第二个 Clash，不重装已授权应用。

## 采用方式

2026-09-08 后续：用户选择 Railway 人工回复通道，详见[确认服务](../../infra/confirmations/README.md)。这替代旧的入口内部自动续答：`--captcha-current` 遇到确认请求后保存 thread、提交待确认记录并退出；认证网页上的真实回复才能由独立 dispatcher 领取并恢复。网页不会自动批准，工具/系统仍拒绝时停止。

2026-09-08 14:22更新：[正确代理实测](../../docs/quality/2026-09-08-gnc-local-cua-fixed-proxy.md)。Chrome应用授权已由用户完成，本机Codex/CUA可实际导航。旧PID21509连接已停55134代理，正常退出且Profile保留；新Redmond17893浏览器访问example.com成功，GNC仍返回人机验证。多Chrome实例共用bundle ID会选错窗口，不能凭应用名称就认定操作了某个lane；需先核对目标窗口，未知实例不接管、不随意关闭。

2026-09-08后续核实：用户要求转为Mini本机Codex操作、不把逐次向当前助手确认作为无人值守主线。已启动本机Codex调用CUA，但Chrome应用许可被拒；工具自身另要求验证码行动时确认，CLI的`never`不覆盖它。详见[真实检查](../../docs/quality/2026-09-08-gnc-local-codex-cua.md)。下列现场规程仅为有人值守处理方式，不是已实现的全自动模块；`--operator-ready`也仅保留作调试入口。

1. 使用 Mac mini 默认 Clash，不另起代理核心。GNC 页面必须由真实 Chrome 访问，不以 fetch/curl 替代。
2. 每个出口使用自己的持久 Profile：`/Users/barry/apps/crawlv3-browser-profiles/gnc/<laneId>/profile`。任务结束关闭浏览器，保留 Profile；同一 Profile 同时只能有一个拥有者。
3. 从运行记录的 `laneId`、核验 IP、固定监听器和 `profilePath` 判断线路，不以 Clash 界面选择器高亮推断。
4. 遇验证保持出口、Profile、浏览器会话不变。Mini 入口 `mini-codex-browser-check.mjs --captcha-current <live目录>` 遇行动时提示后停止，保存 `CONFIRMATION_PENDING`；配置 `APPROVAL_CONFIG_PATH` 时提交 Railway 待确认记录。用户在认证网页读清操作并回复，独立 dispatcher 才领取该次回复、恢复原 thread。未回复、拒绝、过期、页面变化或工具仍拒绝都不自动继续。用户和 Agent 不同时使用鼠标。
5. 按当前页面提示交互并等待结果。进度条满、三点动画、工具调用成功均不是通过；必须实际进入目标 SKU 产品页并核对身份和内容。
6. 成功记录时间、出口、Profile、SKU、结果，再继续授权范围内采集。失败、超时、状态不明保留证据和分类，不无限尝试，不把访问问题记成产品缺 Formula/Ingredients。
7. 旧业务 Review 不因后来验证通过自动重跑。下一次采集使用显式新 observation/operation；已完成证据只做独立核验，不重复昂贵处理。

| Lane | 本机入口 | 已配置并核验的出口 IP |
| --- | --- | --- |
| gnc-texas | 127.0.0.1:17891 | 149.119.185.14 |
| gnc-washington | 127.0.0.1:17892 | 205.214.52.48 |
| gnc-redmond | 127.0.0.1:17893 | 209.227.31.143 |
| gnc-virginia | 127.0.0.1:17894 | 23.134.60.214 |

每次分配仍由 LanePool 核验实际出口；上表不是跳过验证的许可。正常分配继续四出口轮动，运行中不切换。

## 已实现与操作边界

- 已实现 `NodeSourceProcesses.profilesRoot`、每 Lane 固定目录、绑定检查、独占锁、确认退出后释放、拒绝接管旧浏览器端点。Mini 查看和 pooled 单品入口均已接入。
- 先前 Computer Use 由 Agent 通过屏幕共享操作；现已验证由 Mini 本机 Codex/CUA 导航。当前挑战入口遇确认后退出，网页回复由独立 `mini-watch-human-confirmation.mjs --report <report.json>` 领取并恢复。**该桥接不等于 Worker 自动检测挑战、恢复同一 Temporal Activity 已实现，也不代表真实验证码通过已验收**。
- 查看入口 `mini-gnc-interactive-check` 十分钟后自动关闭浏览器并保留 Profile；新发布包见[验证记录](../../docs/quality/2026-09-08-gnc-persistent-profiles.md)，不再用旧的一次性 Profile 包。
- 实测为按钮内拖动、观察进度、结束可能残留的鼠标状态。未测得精确按住时长，不把固定坐标或等待秒数写成通用解法。
- 13:26 Virginia 上一次 Agent 操作后进入 SKU 613701 产品页；Redmond 前一例含用户再次手动操作，不能归为 Agent 独立成功。
- 固定 Profile 不保证验证码永不过期；GNC Cookie 跨重启留存和长期通过率未验收。Chrome 钥匙串/加密警告未解决，本轮不改系统安全设置。
- Profile/Cookie 不发布到 R2、日志或 Temporal 历史；后续图片下载只消费已有精确、私有、限时授权。
- 本轮不扩展反爬调优、验证服务或自动全局换网；以后有新失败再单独按证据处理。

## 下一步

在 Mini 新发布目录配置私有 Worker 凭据，再跑当前挑战入口：

```sh
export APPROVAL_CONFIG_PATH=/Users/barry/apps/crawlv3-human-confirm.55tlTJ/worker.json
node /Users/barry/apps/crawlv3-human-confirm.55tlTJ/mini-codex-browser-check.mjs --captcha-current <当前live目录>
```

`<当前live目录>` 取已就绪、`accessPreparation.status=waiting` 的 `/Users/barry/apps/crawlv3-gnc-pool.*/live`，不要使用已超时旧会话。提交确认记录后入口会自动启动独立 dispatcher；若启动失败才手动运行 `mini-watch-human-confirmation.mjs --report <本次CUA报告绝对路径>`。等待最长十分钟，浏览器原有生命周期不会被延长。真实回复之后若浏览器/上下文失效则停止，不能把旧确认用于新挑战。父会话根据真实产品页证据继续 CRAWLV3-33；通信成功不代表抓取成功。

仅 Mini 执行；Luna/medium，Codex 内部请求次数由 Codex 管理；PDF 暂停，不扩 Brand、不写旧正式库。访问验证成功与整条业务链成功分别记录。
