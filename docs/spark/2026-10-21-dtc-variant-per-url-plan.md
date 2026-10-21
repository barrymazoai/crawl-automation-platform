# DTC 第 2 步计划：一规格一 URL，像 Swanson

状态：待 owner 批准（2026-10-21）。第 1 步（Shopify 走平台读取器）已于 2026-10-21 上线（c411a51 起，当前 93629f9）。本步只改多规格产品的命运；第 3 步（label core 与包装校验范围统一）另案。

## 1. 目标与成功标准

- 多规格 Shopify 产品不再整体交给 Codex 采集 agent，再由 `DtcVariantWorkflow` 逐规格、`DtcGalleryWorkflow` 每图 OCR + 模型判归属。改为：**基础页任务读出规格清单，其余规格按 `?variant=<id>` 作为独立产品任务入队；每个任务只读自己的页面，图库归该任务的规格，标签走共享的有序走法。** 这与 Swanson（一 variant URL 一任务）、Whole Foods / Costco（页面列出的 variant 由 `discoversVariants` 入队）是同一套机制。
- 多份不同的 Facts 不再靠模型归属：同一图库给每个规格任务后，共享走法读到多张不同面板时按现有多来源比较进 `LABEL_PRODUCT.FORMULA_CONFLICT`（真不同需人工归属，与 10-04 接受的"唯一可用面板共用、多份不同面板需归属"政策一致）；只有一张面板时自然共用。
- 成功标准：
  - 第 1 步离线重放语料（Server 二 `manual-releases/dtc-platform-replay-20261020/`，1,931 页）里的多规格页（约 333 件，17%）：每个 `?variant=` 地址用读取器重放都能得到 `selectedVariantId` 等于请求的规格、每规格有 `featured_image` 或共用图库，命中 ≥ 98%。
  - 真实对照：现有 Review 里 `DTC.VARIANTS_INCOMPLETE` 56 件、`DTC.PRODUCT_SCOPE_UNRESOLVED` 22 件（Jarrow 25、Kate Farms 10、Natrol 10 等）重排后不再出现这两个码；剩余 Review 只剩标签原因。
  - 不比 agent 路径差：对照同一组产品，规格数一致、每规格收录数 ≥ agent 路径。

## 2. 现状（已核对代码）

| 环节 | 现在 | 文件 |
|---|---|---|
| 采集路由 | 平台站读一次页面；读取器读出 `variants.length > 1` 就转 agent（reason `multi_variant`） | `packages/channels/dtc/src/capture-route.ts` `platformDecision` |
| 证据 | `variants > 1` 时图库全部 `variantId: null`，facts scope `product-unassigned-variant`，告警 `DTC.FACTS_VARIANT_UNASSIGNED`；规划器要求每张图 `variantId === owner.variantId`，否则 `CHANNEL.VARIANT_CONFLICT` | `packages/channels/dtc/src/evidence.ts`、`packages/channels/core/src/planning/plan-sources.ts:91` |
| 地址 | `dtcProductAddress` 保留 `?variant=` / `?variation_id=`，identity = `{listingId: site+path, variantId}`；去掉 `/collections/x/products/` 前缀 | `packages/channels/dtc/src/address.ts` |
| 读取器 | 表单单选 → 该规格；否则 URL `?variant=` 属于本产品 → 该规格；基础页无选中 → `null`（Natrol 尺寸按钮、Kate Farms 无表单）；URL 带 variant 但页面没确认 → `DTC.IDENTITY_UNVERIFIED` | `packages/channels/core/src/platforms/shopify.ts`、`selected-variant.ts`、`packages/channels/dtc/src/product.ts` |
| 规格 URL / 图 | Shopify 记录里每个 variant 有 `variantUrl(url, "variant", id)` 和 `featured_image.src` | `packages/channels/core/src/platforms/shopify-data.ts` |
| 身份 | 计划 owner 取 `parsed.identity`（evidence.listingId/variantId），不是请求地址；队列项身份是地址（基础 URL → variantId null） | `packages/channels/core/src/pipeline/source-plans.ts:35-50` |
| 发现规格 | 适配器 `discoversVariants: true` 时共享采集把 `parsed.variants` 去掉本任务地址后交回 `discovered`（≤ 200）；`DiscoveredVariants.queue` 只入队该渠道从未持有过的 `(listingId, variantId)`（SQL `unseen`）；`removedVariantSightings` 用同一清单标 `variant_removed` | `packages/channels/core/src/pipeline/product-capture.ts`、`packages/app/src/queue/discovered-variants.ts`、`packages/app/src/pipeline/removed-variants.ts` |
| **缺口** | `queueDiscovered` 只接在 HTTP 渠道的 `collect()`；**浏览器路径 `collectInBrowser` 没有调用**，DTC 即使打开 `discoversVariants` 也不会入队 | `packages/workflows/src/product-pipeline-workflow.ts:73-100`、`browser-product.ts` |
| agent 路径 | `captured.variants`（`DtcVariantHandoff`）→ `collectDtcVariants` → 子流程；保留为 agent 站后备 | `packages/workflows/src/dtc-variants.ts`、`dtc-gallery.ts` |

## 3. 复用什么（都已存在）

- `discoversVariants` 契约与 `discovered` → `DiscoveredVariants.queue` → `queue_item` 去重（Whole Foods / Costco 在用）。
- Shopify 读取器的规格 URL、`featured_image`、`selectedShopifyVariant`。
- 共享有序标签走法与多来源比较（bc75f31 / 93629f9：sections / subset / conflict），替代 `DtcGalleryWorkflow` 的逐图模型归属。
- `removed-variants`：基础页列出的规格清单顺带让"下架规格"能被标 `variant_removed`。

## 4. 网上搜库

不涉及：Shopify `?variant=` 是平台约定，读取器已实现；不引入新依赖。

## 5. 要改的地方（按层）

### 5.1 `packages/channels/dtc/src/adapter.ts`：`discoversVariants: true`
- `parsedProduct` 已返回 `variants: product.variants.map(dtcProductAddress)`。打开开关后共享采集把除本任务地址外的规格交回。
- 基础页任务按页面默认规格收录（owner = `parsed.identity`，与 Swanson 同口径）；该默认规格的 `?variant=` 地址也会被交回入队一次，造成同一规格两条任务。处理：`parsedProduct.variants` 排除 `product.selectedVariantId` 对应的规格（`removed-variants` 的 `listedVariants` 已把 `page.variantId` 计入，不会误标下架）。

### 5.2 `packages/channels/dtc/src/capture-route.ts`：多规格不再一刀切转 agent
- 平台站读出 `variants.length > 1` 时也走平台路径。只有读取器本身失败（`PLATFORM_READ_FAILURES`）才转 agent；`multi_variant` 这个 reason 删除。
- 站点级回滚仍是 `capture: "agent"`；不加新开关。

### 5.3 `packages/channels/dtc/src/evidence.ts`：图库归当前规格
- `selectedVariantId !== null` 时：图库 `variantId = selectedVariantId`（共用），`variant-featured` 只保留本规格的那张（其他规格的 featured 会触发 `CHANNEL.VARIANT_CONFLICT`，也不属于本任务）；facts scope `selected-product`。
- `selectedVariantId === null` 且 `variants > 1`（基础页无默认选中）：图库 `variantId: null`，owner.variantId 也是 null，规划器放行；按产品级标签收录（agent 路径今天记的也是"基础商品、规格 null"）。
- `DTC.FACTS_VARIANT_UNASSIGNED` 不再对平台路径发出；改记一条 warning `DTC.GALLERY_SHARED_WITH_VARIANT`（规格数、是否有本规格 featured），审计共用政策。`variants` 清单照常完整带回，供 5.1 发现与下架判断。
- `product.ts` 的 `IDENTITY_UNVERIFIED`（URL 带 variant 但页面没确认）保持。

### 5.4 `packages/workflows/src/browser-product.ts`：浏览器路径接上发现入队
- 把 `product-pipeline-workflow.ts` 的 `queueDiscovered` 提到共用模块（`discovered-queue.ts`），`collectInBrowser` 在 `captured.status === "captured"` 且 `captured.discovered?.length` 时调用；受 `patched("queue-discovered-variants-v1")` 同一补丁保护。agent 路径（`captured.variants`）不变。

### 5.5 不改的东西
- 队列、API、`DiscoveredVariants`、`removed-variants`、规划器、标签走法、`DtcVariantWorkflow` / `DtcGalleryWorkflow`、模型提示与 wire 格式。
- WooCommerce 站维持 agent（第 1 步结论：读取器 52 图 vs agent 4 图、规格 1/21 一致，未证明）。

## 6. 自己写的部分及理由

只有 5.1–5.4 的条件分支、一个 warning code、一次函数搬家；无新库，无新模型步骤。

## 7. 验证（Mini 直接验证，不加单元测试；现有 `adapter.test.ts` / `capture.test.ts` / `evidence` 断言随新契约更新）

1. 离线重放（Server 二，不开浏览器、不调模型）：在第 1 步重放脚本上加"多规格页按每个 `?variant=` 地址重放"的统计：`selectedVariantId` 命中、featured 存在、图库数；按站点出表附在本文。阈值见第 1 节。
2. 真实对照（DTC 批量 paused，一次一个站）：Jarrow 挑一个多规格产品的基础 URL 重排 → 预期：基础任务按默认规格收录、`discovered` 入队 N−1 条、各自收录；对照老 Review 记录。然后 Natrol（无默认选中）一个，验证基础页规格 null 路径。
3. 部署：Server 一（API / pipeline / label）与 Server 二（browser-worker）同时上；回滚 = 站点 `capture: "agent"` 或回退 commit。
4. 上线后把现有 78 件 `VARIANTS_INCOMPLETE` / `PRODUCT_SCOPE_UNRESOLVED` 的基础任务重排，由发现机制补齐规格任务；统计新增任务数与收录数。

## 8. 工单拆分建议（Plane）

- 2a 适配器与路由（5.1、5.2）
- 2b 证据归属（5.3）
- 2c 浏览器路径发现入队（5.4）
- 2d 重放 + 真实对照 + 部署 + 重排（第 7 节）
- 父：CRAWLV3-151 / 第 1 步 CRAWLV3-215~218 的后续

## 9. 需要你确认的点

1. **基础 URL 任务的身份**：按页面默认选中的规格收录（推荐，与 Swanson 一致；老 `queue_item` 不悬空），还是基础任务只做发现、自己不收录。
2. **共用图库政策**：每个规格任务把整库图都归自己，不同面板靠 `FORMULA_CONFLICT` 拦截，而不是再调模型判归属。接受？
3. **基础页无默认选中（Natrol、Kate Farms）**：按产品级（规格 null）收录一份，另外每个规格各收一份。接受？
4. 上线后是否把 78 件老 Review 的基础任务全部重排。

## 10. 离线重放结果（2026-10-21，Server 二，commit 807561b，`tools/replay-dtc-variants.mts`，留存页 2,065 份）

多规格页 404 份（其中 158 份基础页没有默认选中），规格地址 1,043 条。

| site | 多规格页 | 基础页有默认 | 规格地址 | 读出 | selected = 请求 | facts | 证据图中位数 | 失败 |
|---|---|---|---|---|---|---|---|---|
| solaray.com | 146 | 146 | 320 | 320 | 146 | 0 | 9 | - |
| jarrow.com | 90 | 0 | 198 | 198 | 198 | 0 | 10 | -（修 807561b 前 27 条 IDENTITY_UNVERIFIED：JSON-LD 路径不认 `?variant=`） |
| www.natrol.com | 46 | 0 | 112 | 112 | 112 | 112 | 1 | - |
| shop.katefarms.com | 0 | 0 | 94 | 94 | 94 | 0 | 4 | - |
| www.blueshiftnutrition.com | 26 | 26 | 60 | 60 | 26 | 44 | 6 | - |
| www.tryauri.com | 0 | 0 | 39 | 39 | 36 | 0 | 62 | - |
| womaness.com | 11 | 0 | 33 | 33 | 33 | 0 | 9 | - |
| tallyhealth.com | 11 | 0 | 33 | 33 | 33 | 0 | 6 | - |
| lovewellness.com | 11 | 11 | 26 | 26 | 11 | 0 | 14 | - |
| shop.hmwmethod.com | 11 | 11 | 22 | 22 | 11 | 0 | 2 | - |
| zahlers.com | 2 | 2 | 6 | 6 | 2 | 0 | 26 | - |

口径说明：
- "selected = 请求"只在基础页**没有**默认选中的站能离线判断（Jarrow、Natrol、Kate Farms、womaness、tallyhealth 全中）。有默认选中的站（solaray、blueshift、lovewellness、hmwmethod、zahlers）留存的是基础页 HTML，表单里永远是默认规格，离线必然不等于请求；线上 Shopify 按 `?variant=` 服务端渲染表单，这一项只能在真实站对照里验证。若线上某主题真不按 `?variant=` 渲染，页面身份与地址不符 → 走共享采集的 `identity_conflict` sighting，不会把错的规格收进来（adapter.test 已断言）。
- "featured" 全 0：这些店的 variant 没有单独 `featured_image`，图库共用；评估依据是证据图数（每个规格任务拿到整库）。
- Kate Farms / tryauri 的留存任务 URL 本身带 `?variant=`，所以没有"基础页"行。
