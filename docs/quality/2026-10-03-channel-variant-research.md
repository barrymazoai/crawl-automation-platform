# Whole Foods / Costco 变体调研 — 2026-10-03

关联：CRAWLV3-180（统一变体漏项）、95 / 135（Whole Foods）、94（Costco）、178（DTC）。

用户安排：先调查尚未处理变体的 channel，明确如何补齐，再返回 DTC。本轮完成证据调查与实现方案；没有改生产代码、发付费抓取请求、重排历史 Review 或启动商品队列。当前代码仍为 `4db6d4a`。

## 方法与范围

- Server 一数据库只读：每个 listing 选最新的成功原始 HTML，读取 R2 后逐件校验 byteSize / SHA-256，再分析商品自己的数据。
- Whole Foods：780 条成功捕获历史，对应 **193 个不同 ASIN**；全部 193 件原件完整性与选中 ASIN 核验通过。
- Costco：182 条成功捕获历史，对应 **60 个不同在线商品 ID**；全部 60 件原件完整性核验通过，均找到自己主商品的数据。
- 队列数字不能当商品数：Whole Foods 777 completed + 1 Review 对应 193 个不同 ASIN；Costco 46 completed + 48 Review 对应 62 个不同在线商品 ID，其中 60 个有成功 HTML。
- 在 Server 二原生 Ego space 6 做有界新观察。Whole Foods 浏览器当时为 store 10523 / ZIP 76051，生产存档配置是 10259；本轮新观察验证切换机制，不据此替换生产店铺的价格、库存或历史判断。

存档证据：[原件盘点与队列对照](evidence/2026-10-03-channel-variant-audit.json)、[浏览器观察与文件哈希](evidence/2026-10-03-channel-variant-browser.json)。新观察的 HTML / snapshots 保留在 Server 二 `/Users/server2/apps/crawler-dtc/evidence/variant-research-20261003/`，不伪装成历史 HTTP 原件。

## Whole Foods：缺变体发现闭环，不能直接宣布漏了 20 个在售商品

### 留存原件的事实

`props.pageProps.aapiData.asin` 是当前选中商品；其 `variationsList[].variationNodeList[]` 保存规格候选。193 页中：

| 检查 | 结果 |
| --- | ---: |
| 有规格组 | 77 页 |
| 含其他明确 ASIN 的规格 | 56 页 |
| 规格节点中不同的明确 ASIN（包含当前项） | 97 |
| 这些 ASIN 已有独立 HTML / 已进入 WF 队列 | 77 |
| 未进入 WF 队列，也没有独立 HTML | 20 |

20 个未覆盖的明确 ASIN，所有观察均没有价格及库存值。还存在 17 个不同的 `closestAsin` 候选，其中 6 个既不在明确 ASIN 集合，也不在已采集集合。`closestAsin` 不是当前规格组合的确切身份，不能直接当作该选项的 ASIN。

这些数据证明 **变体发现、分类和覆盖检查没有接上**，不能证明有 20 个在售规格漏采。历史页可能给出较大的 Amazon 商品族；应把可售、售罄、当前门店不供应、身份未证实分开。不能将 null 库存当售罄，也不能把族候选直接当该店可售目录。

具体对照：留存 Amazing Herbs 4 fl oz（B0001CNL08）页包含 1/4/8/16/32 fl oz、多包装等候选；本轮另一店铺的新页面只展示 4 fl oz、8 fl oz 两个明确可选规格。因此必须保留捕获时间和店铺上下文，不能把跨店或跨时点差异都归为漏采。

### 实站切换验证及一个重要边界

MegaFood Blood Builder：

- [30 片 B00014ECYU](https://www.wholefoodsmarket.com/grocery/product/30-count-pack-of-1-b00014ecyu)。
- 页面真实规格链接指向 [90 片 B000F4ZRCC](https://www.wholefoodsmarket.com/grocery/product/90-count-pack-of-1-b000f4zrcc)。
- 点击 90 片后，地址、可见标题、选中 Size 均变为 90 片，但 `__NEXT_DATA__.props.pageProps.aapiData` 仍保留原来的 **B00014ECYU / 3 张图片**。
- 对 90 片真实地址执行一次完整导航后，初始化数据成为 **B000F4ZRCC / 8 张图片**，与选中身份一致。

因此应复用原方案：**发现真实变体地址 → 独立获取该地址的 HTML → 核验页面自身 ASIN → 该规格处理**。不能仅保存客户端切换后的 DOM，再信任可能过时的初始化 JSON。当前生产产品路径是独立 HTTP 抓取，这个观察是新增验收边界，不是已确认的生产串用事故。

### 最小修改方案

1. 保留现有品牌 JSON 搜索，按 ASIN 收集初始清单。
2. 读取留存商品 HTML 中自己的规格组及实际选项链接，建立 ASIN、规格轴、选项值、地址、店铺、捕获时间的证据。去重后把未覆盖项交回既有队列做独立页面验证；已采原件按现有复用规则使用。
3. 仅将真实出现的选项组合纳入清单，不生成 size × flavor 的笛卡尔积。`closestAsin` 单独记为候选，须以目标页实际选中属性核实，不擅自贴上原选项的规格。
4. 每个目标页重新验证自身 ASIN 和店铺，读取自己的价格、库存、图片。明确售罄的仍保留；无身份、无售卖证据的保留待核验原因，不能静默丢弃，也不能伪造一个完成商品。
5. 按原授权继续 **精确 ASIN 关联 Amazon 配方**；配方 pending / no-source / linked 分开，不借兄弟 ASIN 的配方冒充完成。
6. 发现数、待核验数、已入队数、独立原件数、最终处理数分别计数。当前搜索 `full` 只证明搜索覆盖，不能扩张成变体闭环完整。

接入点：`whole-foods-adapter.ts` / `whole-foods-product.ts` 目前清空 variants；`whole-foods-http-reader.ts` 采用 `readList`，会走 `policyListing` 直接返回，**只加 GNC 式 `familyMembers` 钩子不会生效**。需要把“商品自己的变体发现结果”实际接回既有派发边界，并做 ASIN 去重、循环终止、同批上限及取消处理。仅实现 family metadata 不等于派发完成。

## Costco：已采样本是独立商品，页内多子商品仍未实现

### 留存与实站事实

主商品身份是 `productDetailsData.productData.id`；子商品在 `childCatalogData[]`，当前项是 `selectedChildItemNumber`。主商品 ID、子商品 / warehouse item number、UPC 必须分开保存。

全部 60 个留存在线商品都只有 **1 个 childCatalogData 项**。本轮没有证据证明这 60 件已漏掉页内子规格，但现有 `variantId:null`、`variants:[]` 和仅按主 ID 校验的设计，确实没有覆盖多子商品。

实站搜索 protein powder：Optimum Nutrition 两个口味已经分别作为商品列出：

| 商品 | 在线商品 ID | 子 item | UPC |
| --- | --- | --- | --- |
| [巧克力 5.64 lbs](https://www.costco.com/optimum-nutrition-gold-standard-100-whey-protein-powder-extreme-milk-chocolate-564-lbs.product.100428750.html) | 100428750 | 1243880 | 748927059113 |
| [香草 5.47 lbs](https://www.costco.com/optimum-nutrition-gold-standard-100-whey-protein-powder-vanilla-ice-cream-547-lbs.product.4000177608.html) | 4000177608 | 1243864 | 748927065404 |

两页均只有一个子 item，拥有独立地址。搜索中还看到 Levels、Orgain、Ascent 的不同口味分开列出。本轮仅为有界观察，不声称搜索结果或 Costco 全站已覆盖。

另一个边界：Kirkland Extra Strength Energy Shot 48 瓶是一个 item（1711799），描述明确包含 24 Berry + 24 Blue Raspberry；这是混合口味商品包，不能因出现两个口味就凭名称拆成两个可购买变体。

### 最小修改方案

1. 已经分成独立商品 ID 的规格，继续由品牌目录发现、逐 URL 获取独立 HTML、进入原 Facts 流程。不能按相似名称推断家族或合并配方。
2. 读取当前主商品的 `childCatalogData` 并核对 selected child；单子商品保留既有身份兼容，同时明确记录子 item 证据。
3. 多子商品需要独立记录每个真实选项与 child ID。现有地址规范化会丢弃全部查询参数，页面身份只核验主 ID，因此不能未经验证就把选项 URL 交给旧路径，否则可能全落回默认子商品。
4. 后续以真实多子商品样本确认选择器、可定位地址 / 参数、完整导航后的选中 child、价格、图库与 Facts，再保存必要的选择信息，以 `(online ID, child ID)` 作为多子商品任务身份。选择不回显目标 child 必须 Review，禁止默认 child 兜底。
5. 若目标不能通过独立 URL / HTML 定位，记录明确缺口；不能凭空设计 query 参数，也不能自动把所有渠道切成 DTC 的混合图库前处理。

接入点：`address.ts`、`identity.ts`、`adapter.ts`、`evidence.ts`、`page-data.ts`，以及发现→入队的实际连接。Costco 扫描走 `browserListing`，同样不能只增添 HTTP `familyMembers` 就宣称接通。

**尚待真实验收：Costco 一个主商品含多个可选择 child 的营养产品样本。** 本轮没有找到并完成这个场景，不据单子商品样本编造选择协议。

## 返回 DTC 的边界

- 两渠道缺口留在 180 / 94 / 95，不改变现有 Whole Foods 精确 ASIN 配方共享策略。
- DTC 继续处理 Solaray 混合图库：在进入共用单品 Facts 前，单独复用既有 OCR 能力取得 Facts 证据，让 Codex 根据真实规格与 Facts 内容判断归属，再进入原流程。共用 Facts 流程不扩大改写；179 的复用校验 bug 单独保留。
- 不能把“URL 已变”“HTML 已保存”“family 已解析”分别误当作身份、图片归属、全部入队的完成证明。
- DTC 接下来仍需单独 OCR 实测及逐规格端到端验收。本轮未调用 OCR，未修改或部署 DTC 代码。

## 页面清理

2026-10-03 02:55:50Z 已关闭本轮操作的 space 6 / p1，目标 `EA0CD8AF195DEB4B359079117C351DBC` 在关闭后 inventory 中确认不存在。浏览器自动留下一个 `about:blank`、openedBy unknown 的未托管页，未操作；共享自动化空间保留。MacBook 用户保留的 Solaray 页面未触碰。
