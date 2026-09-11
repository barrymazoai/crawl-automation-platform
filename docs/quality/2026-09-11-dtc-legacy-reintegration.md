# DTC 旧版完整采集器接入 V3

2026-09-11，按用户要求保留旧版采集能力，替换 DOM-only DtcCodexDecider 主入口。实现源码提交：`938479988adfcf7959809cae7776d26fa7880bf0`。

## 实际改动

从 `packages/runtime/src/index.ts` 提取原有 `buildBrowserCapturePrompt` 和 `CodexProcessRunner`，原导出保持兼容。Windows 的目录/商品 Activity 调用完整 Codex exec，读取随 release 固定的 crawl-products Skill，执行原有 Shopify 探测、runHarvest、浏览器补采、原图/HTML/variants 收割。模型保持 `gpt-5.6-luna / medium`；没有修改收割引擎的提取算法。

V3 继续负责任务/资源授权、目录分页与商品分派、R2、文件处理、OCR/标签和业务结果。旧 Browser Node 的 Railway 领取任务、整 Lane 清页和 Chrome 重启逻辑不带入 V3。

对接层保留完整旧 capture 目录和 manifest，校验路径、文件哈希、来源 URL 与指定变体。projection 附带原始 fields、所有 variants、选中 variant 和 HTML；完整原始 records/coverage/flags 仍在 R2。V3 当前仍处理目录指定的商品 URL，保存所有变体不等于自动提交所有变体。

原图保存完成、Codex 执行结束后，由宿主关闭精确任务 target 并复查，再执行离线证据交付。文件 Activity 从 retained original 读取，不再使用浏览器。旧 worker_cdp 增加任务 target 限定、pause/instance/有效期检查，tabs.new/list 不触碰其他页面；异常退出后现有页面账本仍可恢复。用户接管保持 pending。

Skill 文件以 LF 固定，哈希写入参与 build ID 的根 JS；Windows 更新同时应用 .gitattributes，避免既有 CRLF checkout 造成再次校验不一致。完整模型采集允许 15 分钟；对应 DTC Activity 使用有历史兼容标记的 20 分钟上限，其他渠道不变。

## Mini 实测

真实 Codex 商品运行：`dtc-legacy-fea57556-3368-4ea9-ad02-3585e601a52c`。

- 商品：`https://shop.innerbody.com/products/astaxanthin?variant=44807968882774`。
- 原版 runHarvest：1 条基础商品、3 个真实 variants，选中 SKU `IL01005-3`，HTML 已保存。
- 图库：正面、Supplement Facts、另一侧背标，3/3 原图；标签原图 1600×1600，人工查看留存图确认可读。
- 原图字节经 V3 retained-file transport 冷读，三个 SHA-256 与 manifest 一致；不访问网站。
- task target `C2F321B3207E4F4946559DCAC50AB427` 已关闭并复查；模型许可已释放。
- R2 相对键：`v3/dtc-legacy/dtc-legacy-fea57556-3368-4ea9-ad02-3585e601a52c/manifest.json`。

真实 Codex 目录运行：`dtc-legacy-4392ea8b-61b6-4b51-bed6-ddc5537c134a`，读取 `/collections/all`、保存目录 HTML/截图和实际观察到的商品链接，通过 V3 catalog projection，先关页再交付。target `2AF3853E8F54A12ECD9CDF7532FA2569` 已关闭并复查，许可已释放。测试专用 Chrome 初始空白页也精确关闭并复查，没有停止 Chrome 进程。

Mini 测试：79 passed / 0 failed，涵盖旧证据字段及大图、失败/取消/接管边界、页面隔离、V3 文件流和 Temporal replay/restart。初次测试缺少现有 fixture 环境变量，以及大图 transport 使用过大的读取上限，均已修正并重跑。5 份生产历史只读回放通过：节点会话、第三次商品试单、三次目录试单。回放脚本首次漏传真实 workflowId 的错误也已修正；没有修改生产历史。

证据位于 Mini `/Users/barry/apps/crawlv3-batch-a.UiA4dx/` 下同名 `dtc-legacy-*` 目录；回放报告 `dtc-legacy-replay.json`，最终测试 `dtc-legacy-tests/final-result.json`。

## 部署与边界

Mini 已完成滚动更新：supervisor `18339`，26/26 ready；原有 supervisor `80452`，90/90 ready；真实 Mini doctor preflight 通过。备份 `release-before-legacy-capture`、`private-before-legacy-capture` 保留。

- Activity build：`63ad1c890b96df25cc25050ec86b8e9e98b0cd9cbef874668c381999f9524f72`
- Workflow build：`54cdbea7f81421e897c378993a257c6c785f7e766214d9a9c30cedf60f26a72e`
- 根 JS：20 个（包含 Skill integrity manifest）。

Windows 旧节点会话已正常停止，当前没有业务任务/隔离许可占用。本次没有直接操作 Windows。下一步由 Windows Codex 按 Git 中 `WINDOWS_LEGACY_CAPTURE_PROMPT.md` 拉 main、复用现有配置并启动。无需新凭据附件，Windows 不访问业务数据库。

尚未通过更新后的 Windows 节点执行新的 Brand → OCR/标签 → 入库整链；也未声称 Windows 实机取消/冷启动已验收。新产品试单必须在 Windows 更新就绪后另发新请求，历史三次 Review/R2 证据保持不变。
