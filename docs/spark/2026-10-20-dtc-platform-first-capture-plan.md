# DTC 第 1 步计划：Shopify 等平台站走固定读取器，agent 只做后备

> 2026-10-20。只是计划，未写代码、未部署。依据：[DTC 流程分析](../plans/2026-10-20-dtc-flow-analysis.md) 第 5 节第 1 条。
> 决策归属：10-03 用户定下"复用旧的、模型驾驭 Ego 的采集流程"（`docs/quality/2026-10-03-dtc-acceptance-status.md`），本计划不推翻它，而是把"成熟平台的明确协议映射"（10-02 边界文档第二节明确允许，`AGENTS.md` 也写明禁的是通用关键词提取器，不是平台协议）作为平台站的默认路径，agent 退为非平台站和平台读取失败时的后备。这一点需要你确认。

## 1. 目标与成功标准

- 对 Shopify / WooCommerce 站的 DTC 单品，不再每件商品起一次 Codex agent 探索；用 Ego 读一页，用已有平台读取器出身份、成分表块、原图、规格清单，进入和 GNC/Swanson 一样的共享规划与标签流程。
- 生产库现有 17 个 DTC 站：Shopify 15（含 1 个多品牌）、WooCommerce 1、自建 JSON-LD 1（PureTrim）。前 16 个归本路径。
- 成功标准（都在生产库可查，和分析文档同口径）：
  - `captureBrowserProduct` 的 Shopify 站采集成功率从 86.9% 到 ≥ 97%（Swanson 99%、GNC 97.5%）；中位耗时从 132 s 到 ≤ 15 s。
  - `DTC.CAPTURE_REVIEW`、`CHANNEL.CAPTURE_MODE_UNSUPPORTED`、`TEXT.CODEX_EXITED/TIMEOUT`、`DTC.PRODUCT_SCOPE_UNRESOLVED` 在平台站上归零（它们都是 agent 路径的产物）。
  - 同一组商品的标签结果不比 agent 路径差：以留存页面重放对比"有无 facts 块、原图张数、规格数"，以及一个真实站的端到端收录数。
- 不在本步范围：多规格展开方式（第 2 步）、label core 与包装校验范围统一（第 3 步）、站点分析和目录发现换路径（第 1b 步，见第 7 节）。

## 2. 复用什么（都已存在，当前只是没被接上）

| 能力 | 位置 | 现状 |
|---|---|---|
| 浏览器读一页、先归档再解析的共享采集 | `packages/channels/core/src/pipeline/browser-product-capture.ts` → `ProductCapture`（mode browser） → `HttpCapture(BrowserPages(EgoPages))` | 已在 `apps/worker/src/browser/browser-parts.ts` 里构造（`capture`），但 `selectCapture` 把所有 `dtc` 请求都转给了 agent 的 `DtcAgentProductCapture` |
| Ego 页面准备脚本：展开 accordion/details、滚到底、等懒加载，8 秒内 | `packages/channels/dtc/src/page-preparation.ts`，`DTC_BROWSER_POLICY.preparationScript` | 已挂在 `BrowserPages` 的 dtc 策略上 |
| Shopify / WooCommerce / JSON-LD 读取器：产品 JSON、规格、价格库存、原图、成分表块 | `packages/channels/core/src/platforms/{shopify,woocommerce,jsonld,read-content,content,shopify-data}.ts` | 站点分析和老的 R20 适配器在用；`readShopifyProduct` 从内嵌 `application/json` 产品记录取 `variants`/`images`/`vendor`，`factsSection` 在商品根节点的 table/details/facts/ingredients/accordion/description 里找含 "Supplement Facts / Nutrition Facts / Serving Size" 的块，并优先选 `completeFacts` 通过的 |
| DTC 适配器（非 agent）：地址、页面身份、品牌证据、`parseProduct`、`planning` | `packages/channels/dtc/src/{adapter,product,evidence,projection,brand-evidence}.ts` | 已注册 `captureModes: ["browser"]`，`planning.corePolicy = dtc-label-core/1`（今天 `a4bda1b` 接上的） |
| 站点策略与持久化站点设置 | `site-policy.ts`、`settings.ts`、`stored-settings.ts`、库表 `dtc_source_settings`（jsonb） | 站点分析 apply 时写入 platform/kind/catalogUrl；worker 每次扫描前 `refreshStoredSites` 合并 |
| 原始 HTML 归档、7 天复用、R2 回读 | `channels/core/src/capture/original-html-archive.ts` | 两条路径共用 |
| 规划器与标签流程 | `channels/core/src/planning`、`processing/src/label`、`workflows/src/label` | 不改 |
| 留存页面：Server 二 `~/apps/crawler-dtc/browser-model/dtc-native/*/capture/materials/page-initial.html` | 1,976 份完整渲染 HTML（Solaray 154、Nature's Truth 100、Jarrow 27、Energinut 23、Natrol 20、PureTrim 16、Lovewellness 16、Womaness 11、bloodsugarfriendly 9、Blueshift 6…） | 作为离线重放集 |

## 3. 网上搜到的库（按规则先搜，结论是不引入）

- 解析 Shopify 公开产品 JSON：没有找到合适的 npm 包。`shop-search` 需要 access token；`preamble-utils` 面向主题内 `{{ product | json }}`；其余是 Apify 托管脚本。本仓库已有的 `shopify-data.ts` 就是这一层，继续用。
- 判别电商平台：没有维护中的 npm 包（结果都是托管服务、浏览器插件；`wappalyzer` 指纹库体量大且不再维护开源版）。本仓库 `analysis/data.ts` 的 `platformHint` 已按 `cdn.shopify.com` / `Shopify.shop` / `woocommerce` 判别，站点分析已在用，继续用。
- 来源：[shop-search](https://npmjs.com/package/shop-search)、[preamble-utils](https://www.npmjs.com/package/preamble-utils)、[Apify Shopify Product Scraper](https://apify.com/linen_snack/shopify-product-scraper-extract-product-data-via-json-api)、[Apify E-commerce Theme Detector](https://apify.com/trovevault/ecommerce-theme-detector)、[Detecto](https://peerpush.com/p/detecto)。

## 4. 要改的地方（按层）

### 4.1 `apps/worker/src/browser/browser-parts.ts`：按站点路由，不再按渠道一刀切

- `selectCapture` 改为：请求的 DTC 站点策略 `capture === "platform"` → 走 `BrowserProductCapture`；否则 → agent（现状）。
- 平台路径返回的失败属于以下**确定性读取失败**时，转交 agent 再采一次，并在归档的 `fetchedVia.provider` 里留下两条记录：`DTC.PLATFORM_UNVERIFIED`、`DTC.PRODUCT_MISSING`、`DTC.IDENTITY_UNVERIFIED`（内嵌数据缺失或对不上）。其余失败（页面挑战、超时、归档失败）照旧进 Review，不转 agent（agent 也过不去，只会多花 15 分钟）。
- 不改 Temporal 命令序列：两条路径对 workflow 来说都是同一个 `captureBrowserProduct` 活动，返回同一个 `BrowserCaptureResult`。

### 4.2 `packages/channels/dtc/src/site-policy.ts`、`settings.ts`、`stored-settings.ts`：站点级 `capture` 开关

- `DtcSitePolicy` 增加 `capture: "platform" | "agent"`。默认规则：`platform ∈ {shopify, woocommerce}` → `platform`；`jsonld` / `unverified` → `agent`。
- `DtcSiteSettingsSchema` 增加可选 `capture` 字段，私有配置和 `dtc_source_settings` 都能按站覆盖（回滚手段就是把一个站写成 `agent`）。jsonb 列不需要迁移。
- 多品牌站（zahlers.com/mantra-labs）沿用现有 `brandEvidence` 校验：vendor 与来源品牌不一致 → `DTC.BRAND_MISMATCH` 照旧。

### 4.3 `packages/channels/dtc/src/page-preparation.ts`：把平台产品 JSON 带进归档页面

- 现状：`readShopifyProduct` 只认页面内嵌的 `application/json` 产品记录；主题不内嵌时退到 JSON-LD（规格、原图可能不全）。
- 改法：准备脚本在页面上下文里同源 `fetch(location.pathname + ".js")`（Shopify 公开接口，同站同源，不走 ScraperAPI、不走 Node HTTP，符合"DTC 只用浏览器"），把响应原文作为 `<script type="application/json" data-crawl-source="shopify-product-js">` 追加到 `body` 末尾，再截取 HTML。归档的就是带数据的页面，R2 原件可完整重放。失败不抛错，只在 `preparation` 回执里记 `productJson: "missing"`。
- 边界：`shopify-data.ts` 的 `shopifyRecords` 已经能从任何 `application/json` 脚本里按 `handle` 找记录，不需要新解析器。

### 4.4 `packages/channels/dtc/src/evidence.ts`：多规格产品的图片归属（本步最小改）

- 现状：规格 > 1 时，图库全部 `variantId: null`，成分表 scope 为 `product-unassigned-variant`；而规划器要求每张图的 `variantId` 等于任务 owner，否则 `CHANNEL.VARIANT_CONFLICT`。即平台路径对多规格产品现在必然在规划阶段失败。
- 本步做法：**多规格产品先不走平台路径**。`parseProduct` 读出规格 > 1 时，由 4.1 的路由转交 agent（页面已读过一次，多花约 5 秒）。这样第 1 步只改变单规格产品的命运，结果可单独度量；多规格整体放到第 2 步（一规格一 URL）。
- 第 2 步到来前，不在这里做任何"共用图库"的假设。

### 4.5 `packages/channels/dtc/src/adapter.ts`：补上和成熟渠道一样的两个小钩子

- `nonSupplementCategories`：用 Shopify `product_type` / tags（礼品卡、精油、器械、服饰），让没有成分表的非补剂以"不是补剂"结束，而不是 `CHANNEL.LABEL_NO_SOURCE` Review（分析文档 3.4）。先只配白名单明确的几类，其他照旧。
- `externalId` 已有；`discoversVariants` 留给第 2 步。

### 4.6 不改的东西

- 规划器、label core、标签 workflow、组装、enrichment、送 Supply Smart。
- agent 路径的代码、prompt、skill、方法 profile 全部保留，只是不再默认命中 Shopify 站。
- 已采集成功的商品不重采（配方只提取一次）。

## 5. 自己写的部分及理由

| 新写 | 为什么不是复用 |
|---|---|
| 路由判断（约 30 行）与站点 `capture` 字段 | 现在是写死按渠道，没有按站点选择的开关 |
| 准备脚本里同源取 `.js` 并内嵌（约 40 行脚本字符串） | 现有读取器只读内嵌数据，不请求 URL；在浏览器页面里取是唯一不违反"只用浏览器、读取器不发请求"两条规则的做法 |
| 平台读取失败转 agent 的小块逻辑 | 两条路径现在互不知道对方存在 |
| `nonSupplementCategories` 的 Shopify 类目清单 | 其他渠道各有自己的清单，DTC 没有 |

没有新依赖。

## 6. 验证（Mini 直接验证，不加单元测试，按 10-03/10-04 的要求）

### 6.1 离线重放（Server 二，不开浏览器、不调模型）

- 用 Server 二 `dtc-native/*/capture/materials/page-initial.html` 的 1,976 份留存页跑 `readDtcProduct` + `dtcEvidence`，按站统计：
  - 能读出产品记录的比例（内嵌 JSON 命中 / 退到 JSON-LD / 失败码）；
  - `factsHtml` 非空比例、`completeFacts` 通过比例；
  - 原图张数 vs agent 当时 `records.json` 的 `gallery` 张数（允许平台图库 ≥ agent 观察数；少于时列出差异站）；
  - 规格数 vs agent `variants` 数（必须相等，否则列出）；
  - 单规格 / 多规格的比例（决定第 1 步能覆盖多少商品）。
- 输出一张按站点的表，附到本文档。阈值：Shopify 站产品记录命中 ≥ 95%，规格数一致 ≥ 98%，否则先修读取器再上线。
- 注意：留存页是 agent 的"初始状态"快照，没有 `.js` 内嵌，所以重放里 JSON-LD 退路的比例会偏高，这个差异要单独标出来。

### 6.2 真实站点对照（Server 二，DTC 批量保持 paused，一次一个站）

- 挑一个 Shopify 单品牌小站，产品 ≤ 10，且当前库里没有收录过（候选从品牌补全队列或 `tryauri.com` 未完成的 2 件、`tallyhealth.com` 之外选；最终由你定），按新路径跑完；记录每件的采集时长、`fetchedVia.provider`、facts 块是否找到、标签结果、enrichment、送达。
- 同站再用 agent 路径跑 1 到 2 件做对照（不重复已成功商品，用新 ID），比较图库张数和标签结果。
- 全部任务页精确关闭、许可释放有停止证明，按既有清理规则。

### 6.3 部署与回滚

- 代码走 main，Server 二 browser-worker 和 Server 一 API/pipeline（settings schema 改动）按"停任务→部署→恢复→重排"的流程部署。
- 回滚：把站点 `capture` 写成 `agent`，不需要回退代码。

## 7. 顺带与后续

- **1b（建议紧接着做）**：目录发现用已有 `DtcBrandScan` + `DtcCatalogPages`（Shopify `/collections/all` 分页 + 滚动）替代 agent 目录发现，路由同样按站点 `capture`；站点分析对 Shopify 用 `products.json`（站点分析已经在浏览器里读 JSON 端点）确认平台和商品数，不起 agent。这会把品牌补全前面两道 15 分钟级的 agent 步骤去掉。放到第 1 步验收之后单独立票。
- 第 2 步（规格）、第 3 步（范围统一）按分析文档顺序。

## 8. 工单拆分建议（Plane）

1. 路由与站点 `capture` 开关（4.1、4.2）。
2. 准备脚本内嵌产品 JSON（4.3）。
3. `nonSupplementCategories` for Shopify（4.5）。
4. 离线重放报告（6.1）与真实站对照（6.2）；验收通过后再立 1b。

## 9. 需要你确认的点

1. 同意"平台站默认固定读取器、agent 做后备"这一方向（与 10-03 的决定相对）。
2. 多规格产品第 1 步继续走 agent（4.4），还是也先用"共用图库给选中规格"的临时规则。我建议前者，度量干净。
3. 6.2 的对照站点由你指定，或授权我从未收录的 Shopify 小站里挑。

## 10. 离线重放结果（2026-10-20，Server 二，commit eb20c49）

输入 dtc-native 1,976 份留存页（Shopify 1,931），用 `--embed-platform-json` 把 agent 当时取回的 `<product>.json` 内嵌进页面，等价于上线后准备脚本的效果。结果目录 Server 二 `manual-releases/dtc-platform-replay-20261020/replay-embedded-3`。

| 指标 | 结果 | 阈值 |
|---|---|---|
| Shopify 产品记录命中 | 1,925 / 1,931 = 99.7% | ≥ 95% |
| 规格数与 agent 一致 | 1,925 / 1,925 = 100% | ≥ 98% |
| 单规格（第 1 步走平台路径） | 约 1,598（83%） | 其余转 agent，等第 2 步 |
| 剩余失败 | Solaray 1（handle 含 ® 编码不一致）、Jarrow 3、Sambucol 2（页面 > 6 MB） | |

重放前的读取器在这些页面上几乎全败（Nature's Truth 0/514、Jarrow 0/141、Natrol 2/136），暴露并修了三类缺陷：一个坏 JSON-LD 块让整页报 `DTC.JSON_INVALID`（`0a7565b`）；其他商品的快速加购表单让选中规格判定失败（`f91fcb9`）；多规格基础页没有单一选中时整页拒绝（`4ba88ac`、`eb20c49`，现读作基础商品、规格 null，与 agent 口径一致；`adapter.test.ts` 对应断言改为新契约）。

两个口径说明：成分表文字只在 Natrol（136，其中 33 完整）、bloodsugarfriendly（27）、Blueshift（20）、Zahlers（5）的页面上存在，其余站的 Facts 全在图里，所以平台路径的价值在身份、规格和原图，不在文字；表里 "images ≥ agent" 偏低主要因为平台图库用 `cdn.shopify.com` 路径而 agent 记的是站内 `/cdn/shop/files` 路径，同一批文件比较不上，真实缺口只是详情区的配料宣传图，不是 Facts 图。

WooCommerce（biomatrix）读取器读到 52 张图而 agent 收 4 张，规格 1/21 一致，证实它还不能默认启用，维持 agent。
