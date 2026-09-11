# Swanson Brand 主流程接线

2026-09-11：[覆盖发布与入口收尾](../../docs/quality/2026-09-11-swanson-closeout.md)。OCR恢复4/4，Healthy Origins两规格均已保存；180粒经已验证来源的独立汇合恢复保存，原Review保留。9个Swanson覆盖角色已发布，46份既有历史回放、61角色连续就绪通过；实际A.C. Grace网页请求新增2保存、0Review，8条新真实历史全部完成并回放通过，31份R2引用校验通过。商品族覆盖2/2封闭，12个任务页已关闭、资源许可与来源占用均0。昨日等待OCR及尚未发布的记录见[历史覆盖报告](../../docs/quality/2026-09-10-swanson-coverage.md)。

2026-09-10 最新：[双通道常驻与架构修正报告](../../docs/quality/2026-09-10-channel-resident.md)。GNC/Swanson 共61角色在 Mini 常驻，4188 Web 按来源路由；三笔新请求新增5条保存观察、0新增 Review。55角色依赖隔离、56正常容量等待、57逐文件流水均已验收部署；新流水两款均在其它图片获取时启动OCR，并在关页后保存，6条新真实历史回放和31份R2引用通过。Swanson来源启用 revision 4，现有计划仍暂停。此前30角色有限验收及32角色Web恢复见[历史报告](../../docs/quality/2026-09-10-swanson-brand-live.md)。

本入口是新系统的独立模块组合，不复用旧爬虫批次状态。完整分页/变体仍未穷尽，不将有限Brand结果当成全站覆盖。

## 职责与启动

全套相关入口构建：`pnpm --filter @crawl-automation/v3-workers exec node --import tsx scripts/build-channel-resident.ts`。逐文件流水增量构建与验证包：`scripts/build-channel-stream.ts`。构建不等于部署；部署脚本先核对实际指纹、回放、排空及配置，再按已授权范围切换。

每个角色单独启动 `swanson-live-worker.js`，沿用 runtime 的私有配置、构建指纹、队列与并发准入。业务配置需显式 `V3_SWANSON_LIVE_ENABLED=true` 和 `V3_SWANSON_LIVE_CONFIG`，格式见 `src/swanson-live-config.ts`。不是启动一个循环执行所有功能。

|角色|职责|
|---|---|
|swanson-control|核对持久化 Brand/source 快照，生成目录计划，检查目录与产品是否收尾|
|swanson-catalog-source|单页目录公开 DOM、R2 证据、任务页关闭|
|swanson-catalog-ledger|验证目录证据、登记发现/派发、封闭目录|
|swanson-product-input|从真实发现生成不可变产品任务；核对保存证据后生成 label 下游参数|
|swanson-capture|读取当前选中产品/变体；另一个 Activity 负责精确关页|
|swanson-file|一个文件一次；通过同一页面会话取得原始图片并保存 R2|
|swanson-review|登记浏览器阶段未知结果与具体 causeCode，不自动重投|

产品计划模块仍使用已有 `channel-product-input` Worker；OCR、关键词、文字、视觉、汇合、入库仍走各自队列。编排入口 `product-workflow-worker.js` 增加 `swanson-brand-workflow`、`swanson-product-workflow`、`channel-label-workflow`；目录继续复用 `CatalogWorkflow`。

配置绑定一个显式 source revision。业务入口必须先在 `collection_submission` 持久化，不能仅凭队列 payload 执行任意 URL。所有配置切换都生成新任务，不覆盖原操作。

## 交接与生命周期

1. Brand Workflow 启动目录；每页登记即启动产品，不等产品处理结束。
2. 目录发现是 `family`：handle 不是 SKU。详情表单唯一确认 productId/variantId 后才生成 observation 和逐图任务。
3. 产品 Browser phase 持有一个共享浏览器许可。capture、plan、逐文件 transfer、close 是独立 Activity。
4. `swanson-file-stream-v1` 新历史在留存页面计划后启动独立 `ChannelStreamingLabelWorkflow`：文字立即推进，每张原图可靠保存后发送文件引用通知，下游复验该文件再进入 OCR/关键词/视觉。页面访问和下载仍串行，文件完成即通知，不等其余图片；最终入库必须等所有必需来源汇合、精确关页及浏览器许可释放。旧历史保留全文件保存后启动 `ChannelSavedLabelWorkflow` 的分支。
5. 失败/未知交接保留意向和证据，不再次导航。用户接管不发送后续关闭动作；未知执行/关闭保持许可隔离，不能仅因已经登记 Review 就释放。
6. 目录先保存投影再关页；关页失败保留投影但不发布 ready 回执。验证目录不需要浏览器或某台机器的文件路径。

## 诚实的覆盖范围

新覆盖发布使用 `scripts/build-swanson-coverage.ts`，支持同品牌 `rel=next` 或明确的 aria 下一页链接，后页游标须与上一页持久证据一致，上限10页。版本2投影提供商品族总数和末页证明；账本只有连续页、各页总数一致、唯一族数吻合、派发收尾才封闭。历史投影保持原unknown语义。即使商品族范围complete，也不能据此宣告未出现的SKU下架。

`swanson-family-variants-v1` 为新历史增加一次商品族枚举，留证据并关页后准备独立 `SwansonVariantProductWorkflow`。公开单组规格链接按真实variantId生成任务，并重新核对产品表单身份；重叠商品族复用同目录全局SKU绑定，取消单个商品族不取消共享SKU。无控件仅为selected-only，多轴/不明控件保守Review，不推测隐藏组合。SKU继续使用已有逐文件流水及下游独立角色。该覆盖版本已于2026-09-11激活，实测边界以当日收尾报告为准。

新视觉 `label-extraction/2` 未默认开启，本轮未改模型/质量策略，沿用 extraction/1 指纹。测试库迁移016及兼容Web已在此前授权批次部署，旧R2和被动Review继续保留。

## 2026-09-10：来源路由与独立 label Worker

`channel-label-worker.js` 新增17个独立 Activity 角色。`V3_CHANNEL_LABEL_ENABLED=true`、`V3_CHANNEL_LABEL_CONFIG` 指向私有业务配置；`V3_WORKER_ENABLED=true`、`V3_WORKER_CONFIG` 指向运行配置。用 `--list` 读取角色、能力与实际构建指纹，不手写 buildId。每个角色一个进程，仅暴露自己的 Activity；非模型角色只读取模型契约元数据，不打开 Codex 程序或账号目录。

角色后缀：`plan`、`page`、`page-text`、`image-prepare`、`ocr`、`ocr-receipts`、`keywords`、`source`、`manifest`、`text`、`text-receipts`、`vision`、`core`、`assembly`、`collection`、`review`、`resources`。role 为 `channel-label-<后缀>`；capability 为 `channel.label.<后缀>`，compatibility 为 `channel-label-v1`，contractVersion 为1。

业务配置见 `src/channel-label-worker.ts`：提供R2、业务数据库、可选独立resourceDatabase和缓存根；只有ocr角色要求OCR服务配置，text/vision要求Codex配置，其余角色不要求这两类提供商配置。`channel-label-role.ts`按角色创建所需模块，hostId来自运行配置。不把密钥放入任务或网页。每个角色缓存独立，通过R2/登记记录交接。生产路径开启持久化模型退出证明；只有匹配原操作/输入/Workflow Run的质量Review才能释放许可，未知执行仍隔离。健康容量暂满由Temporal等待，不误报产品Review；Activity带心跳、取消和禁止业务自动重试，不限制Codex内部模型请求次数。

入口增加可选 `delivery.channelTargets`，例如 `{gnc: <GNC目标>, swanson: <Swanson目标>}`。新任务按来源选择目标；旧投递意向始终核对已保存目标。已启用路由时，未配置渠道不会回退到GNC。所有路由必须同集群、同namespace、同Workflow契约。未配置该字段仍兼容现有单渠道部署。只读投递检查也读取已保存目标。

运行配置可显式设置 `queueScope` 隔离验收队列，生成规则交给 `taskQueueFor()`；不是修改现有队列。业务数据库与共享资源数据库可分离，不能因为测试库隔离就额外制造一套相同硬件的额度。

全套构建同时携带Web所需迁移SQL，只打包而不执行迁移。当前常驻Web是Mini loopback4188；先前4189验收进程已停止。不得把历史验收端口当作当前在线入口。

## 保留的验收边界

- 完整分页和所有变体仍需明确范围内的真实覆盖证据；当前不宣称全站全SKU穷尽。
- Windows/Linux及其它渠道的整项部署验收不由本次Mini双通道结果替代。
- 视觉质量问题仍归54，本轮不调整模型策略。
