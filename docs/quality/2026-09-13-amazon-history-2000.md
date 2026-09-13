# Amazon 2000 条旧链接完整复采

CRAWLV3-60，2026-09-13。用户指定优先 Amazon 2000 个商品，并要求查看价格变化。随后明确将配送地区从日本改为美国纽约 10001。

## 当前范围：先测试 10 个，全量停止

用户随后明确要求“先测 10 个，别跑所有的”。12:48 UTC 已向原 Temporal 批次发送 pause；确认只受理了 8 个不同商品、含补跑共 12 次尝试。12:54:37 UTC 原 2000 条外层 `AmazonHistoryBatchWorkflow` 已正常取消，状态 CANCELLED；没有取消任何已提交的商品工作流。取消前当前批次已完成，原游标为 3。

12:55:23 UTC 已启动独立有限测试 `amazon-history-10-us-10001-20260913`（run `01a09ad6-2ecf-7231-bebc-5bd7afe4d4d1`），接回已受理请求、完成原范围内的补跑，再添加 2 个商品；总共仅 10 个不同 ASIN。固定名单为 B0013LAQS6、B0G963NB8Q、B00IG0MJKA、B0FRWTLCMP、B0FZWXNP6V、B0DZYR8KPS、B0CZM6718H、B0C4Z2HLKL、B0GBX7416D、B0FLRRQ5KR。

10 条清单 SHA-256 `a669063211c96b201a065651a45f22707e8b4bd632ebda4d6c8675e810fe1b70`，只有 6 个固定请求，含此前修复补跑共 16 次尝试；已受理请求只核对而不重复创建。名单不含剩余 1990 个商品，处理完自然结束，不能自动切回全量。Mini 私有目录 `amazon-10-us-20260913` 保留独立清单、基线副本和报告；原清单、历史与 Review 不变。

本次新增部署 `/Users/barry/apps/crawlv3-batch-a.UiA4dx/amazon-pilot-10-20260913`，Supervisor 55448；workflow/control Worker 55461/55463 均核对 ready、实际进程与入口，build `b0ed29dbe426cffa94398020746ba80a1a455f7c9583dcd7e5604274654b03a2`。主 90 个商品处理角色不需要改配置或重启，既有 2 条商品批次已在授权清单内。类型检查和 Mini 3 项控制器回归通过，包含 10 条有限计划和越界输入拒绝；Workflow bundle 未改。

已出现可比较的页面报价观测：B00IG0MJKA 从 2026-08-18 的 19.57 USD 变为本次 16.99 USD，差额 -2.58（-13.18%）。旧购买条件不完整，保留为页面报价变化，不能称为同条件成交价格变化。

以下保留全量准备与早期试跑经过，不代表当前仍在运行 2000 条。

## 范围与准备

- Mini 已导入候选中固定 2000 个唯一 ASIN；选择有旧配方、单一可信历史挂牌身份且能追溯旧来源的记录。按旧库的 8 个公司分组组织 503 个提交，每次 1–4 款。这些是历史分组，不能据此声明本次已验证商品品牌或完成公司匹配。
- 2000 个商品均完整重新抓取和解析。既有配方不作为本次结果复用；旧记录和旧 Review 保留。
- 私有清单 `amazon-2000-us-20260913/selection.json` 保留候选 ID、挂牌 ID、旧来源记录 ID、固定 ASIN 与每个 requestId。候选文件 SHA-256 为 `a50c60608d1b7fbf83bba2df78125cad7c5b4301553ee745a64ab7c460de776d`。已保存 3864 条旧价格观测作为基线。
- 通过已有 Brand/source API 创建来源并提交，工作流类型、顺序、模型、OCR、资源额度不变。增加显式请求白名单及正向链接证据，不把导入列表当成完整网站目录，关闭范围始终 unknown，不触发下架判断。

## 美国配送地区

Mini 专用任务空间 1 实际切换为 New York 10001，重新加载后仍成立。验收 ASIN B000REPUY0：日本地区无法配送；切换美国后有货，单次购买 $41.50，订阅 $37.35。该检查仅用于地区核验，不作为新业务采集入库。

核验任务 `amazon-us-region-c5525cfa-12a9-4770-8c54-916c1d19939a`，target `E9F9B4791A42E71CE72FFDA71E67EA9D` 已关闭且复查不存在，许可已正常释放。证据在 Mini `amazon-us-region/`。原日本地区历史保持原始含义，当前来源更新为 US。捕获页开始和结束均检查配送上下文；配置指定邮编 10001。

## 部署与目前验收

- 链接入口与邮编保护先通过 28 项 Mini 隔离回归。首次整体冷启动为 81/90，就绪失败的 9 个角色均非本次改动；数据库日志未发现同时间错误，原日志未保留底层启动异常，不宣称已确定根因。
- Supervisor 增加可选 `startupIntervalMs`，本部署使用 500ms 错峰启动；不增加执行并发。重启后 90/90 就绪。Windows 和 Workflow 发布未改。
- 首批 requestId：`27aea2bb-a40a-4a53-90a6-e32709bce175`。正常入口于 11:22:56 UTC 受理 4 款：B0013LAQS6、B0G963NB8Q、B00IG0MJKA、B0FRWTLCMP。
- 首款报通用浏览器错误，随后加入白名单浏览器错误码保留；另发现旧产品捕获类要求所有输入来自店铺目录，已明确区分已授权链接请求和店铺采集，原目录身份检查继续保留。此项是补齐新入口兼容性，不是已确定首款浏览器错误的原因。
- 修复版通过 49 项 Mini 回归，Activity build `891308f85bae6f137d4e3f79a997e08c79e7d7edf67d9b7910c929cdc912c391`；部署目录 `release-amazon-links-20260913-v2`，主 Supervisor PID 38496，90/90 ready。
- 首款 Workflow 已结束、无子流程或待运行 Activity、close Activity 成功；准确页面账本一致，三次只读核验不存在。R2 留存 proof/history 后释放该唯一许可，保留 Review，让原批次剩余任务继续。
- 首批最终为 0 捕获 / 0 保存 / 4 Review。四个产品 Workflow 均完成、无子流程和待运行 Activity、准确 close 事件与账本一致；逐个经过三次页面缺席核验及 R2 proof/history 留存后，释放对应许可。父批次于 11:39 UTC 完成；旧 Review 全部保留。
- 实际诊断四个 ASIN 页面均可正常打开，US 10001 均正确。B0013LAQS6、B0G963NB8Q、B00IG0MJKA 的购买表单存在两个相同 #ASIN；旧规则要求只能有一个。B0FRWTLCMP 的 canonical 带商品标题路径，旧解析仅支持根目录 dp。未观察到真实 ASIN 跳转。
- 修改为同一商品区域内重复 ASIN 值必须全部一致，允许合法的单段标题 /dp/ASIN 路径；保留不同 ASIN、外部域名、多段非法路径的拒绝。
- B00IG0MJKA 诊断采集完整读取 6 张轮播图。价格诊断进一步确认单次价与订阅价重复、隐藏节点和空 a-offscreen。当前只取可见主报价，缺少主价才读取明确选中的购买方案；不把单位价格、隐藏订阅价合并。保留原文购买条件和页面显式 USD。
- 新 60 项 Mini 回归全部通过，TypeScript 校验通过。实际页面读取单次报价 $16.99、USD、In Stock，保留商家和配送条件；这是诊断结果，不计入业务保存。
- 诊断 task `amazon-us-region-e5af7777-d2f2-46c0-b93c-c42c1abe71e1` / target `711BC557ED95D01ABB83DB2DEB8108ED` 已关闭并核验不存在，诊断许可已释放。四页及报价证据在 Mini `amazon-pilot-inspect/`。
- Activity build `c458582a4e0d9dcc2d36b5cb5dd165668b2a649b9507fce58bb213d2aec5ea82` 已部署 `release-amazon-links-20260913-v4`。7 个角色单独预检正常启停，主 Supervisor PID 42783，90/90 ready。Windows、Workflow 未改。
- 正常入口继续第二批 4 款，总受理 8/2000。尚未放开剩余批次；等待这批真实图片、配方及历史保存结果。首批 4 个修复前失败仍需要后续独立新请求补跑，不能把诊断采集计作完整业务。

## 运行与价格报告

Mini 私有根目录 `/Users/barry/apps/crawlv3-history-20260913/amazon-2000-us-20260913`。

外部循环协调器已于 12:17 UTC 停止，代码禁止再使用 `pilot` / `run`，仅保留 `status` 只读汇总。正式执行已交给下述 Temporal 批次；暂停通过 Workflow 的 `pause` Signal，继续通过 `resume` Signal，状态通过 `progress` Query。暂停停止后续投放，当前商品继续收尾。

价格报告包含同一 ASIN 的旧/新时间、报价、币种、购买上下文及证据。旧基线使用采集时间之前最近一次实际含报价的观测，后续空报价记录不覆盖此前有效价格。只有存在明确一致币种及有效数值才计算差额；旧购买条件缺失时，说明这是页面报价差异，不能称为同条件成交价格变化。Temporal 生成 `temporal-progress.json` 和 `temporal-prices.json`，数据库中的新旧观测仍为真源。

## 12:24 UTC 完整重启与 12:42 UTC Temporal 接管

- 排查确认旧的 3 个标签角色仍会调用旧 Amazon canonical 解析器，不能只重启 capture。现在 7 个 Amazon live 角色和 `amazon-channel-label-plan/source/manifest` 都已部署并逐个预检、重启，实际 PID 的入口已核对。主 Supervisor 49319，90/90 ready。
- Amazon Activity build `5680e0f7f6ba9b44c59a16f43f52686a299bd423bc4e074ea490d95c753feee8`；3 个 label 角色 build `053db7c4a34eb5b5fe0b4c78377614b63de8e20587c6e4ff25db490840219179`。已更新的 channel-product-input build 仍为 `6194ea7df4c1ab097f08ccdb1b8186bba5c8ca64387baaf90bb3b27731afd4c4`。
- FAILED 产品只有在独立恢复器核对准确 Workflow/run、Review 归属、子任务、页面账本、三次页面不存在，并留存 R2 proof/history、释放准确许可后，Brand 检查才能把它视为结束；不计作保存成功。未知子任务和仍持有的许可继续阻止推进。
- 新增独立 `AmazonHistoryBatchWorkflow`，正常 Brand 入口和商品工作流不变。固定 2000 个唯一 ASIN、506 个请求：原始 503 批，加 3 个修复后的补跑请求，共 2006 次产品尝试。清单 SHA-256 `9f81631f056ff51a966fe359933dbbfbf76714085cca79b7a7ab85d622da53e6`。
- Workflow ID `amazon-history-2000-us-10001-20260913`，初始 run `01a09aca-1fe4-72d4-b68a-40f5c837cd96`。专用 Supervisor 52657；workflow Worker 52660、control Worker 52663 已 ready 并核对实际入口。build `0a99caa5a087d723383e06e99bd4ff984acc075e71612890141f9a151abcb0d6`。新增部署未再次重启主服务或 Windows。
- Temporal 保存游标，每 20 批 ContinueAsNew；等待、恢复和投放均由 Activity/Timer 驱动。所有请求用固定 requestId 先查再提交，不确定的回执不创建新 ID。证明不足时批次保留当前位置并暂停，不能跨过异常任务。
- Mini 新增 10 项验证通过：真实 Temporal 的 Worker 重启、暂停/继续、未知恢复阻止后续投放、22 批跨 ContinueAsNew、两段历史 replay；另含回执丢失后的幂等核对、权限范围/清单与资源许可负向测试。此前 67 项回归通过，TypeScript 通过。
- 12:42 UTC 已核对 Temporal 历史实际包含 load、submit、inspect、report、recover Activity，状态 RUNNING，游标 1/506，接回第二批原请求。当前已提交 8 个唯一商品，保存 3 份新捕获/价格观测，完整产品 0，模块 Review 11；这不是 2000 个已完成。
- 12:44 UTC 进一步确认恢复 Activity 已核验并释放第二批第四款的准确许可，原批次完成；游标推进到 2/506，自动受理补跑 request `73016c93-9ed6-40d3-a0c4-efd689204a2b`，无批次错误。累计 12 次尝试、8 个唯一商品受理、4 个商品新捕获、完整产品 0、模块 Review 12。
- 初始价格观测 B0FZWXNP6V：9.99 → 9.99 USD；B0CZM6718H：13.99 → 13.99 USD。尚无已验证的涨跌例子，不能把新观测数量当成涨价/降价数量。

Mini 证据：`amazon-2000-us-20260913/deployment-complete-result.json`、`temporal-deployment.json`、`temporal-events.jsonl`；隔离测试 `amazon-2000-tools/batch-tests.json`。批次专用部署 `/Users/barry/apps/crawlv3-batch-a.UiA4dx/amazon-batch-20260913`，launchd 服务 `com.crawlv3.amazon-history-batch`。

完整原始清单、API 回执、私有配置、价格基线、运行日志及恢复证据不进 Git。代码和有限诊断材料留在仓库；最终产品库未写入。
