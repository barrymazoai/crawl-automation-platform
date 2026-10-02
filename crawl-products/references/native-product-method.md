# Ego 原生单商品：观察决定方法，脚本保存原件

此文只适用于宿主 `captureMode=product`。沿用旧采集的站点判断、观察、收割和证据包；后续 OCR、规格处理及业务入库由宿主负责。

## 先观察，再指定读取位置

1. 用 Ego skill 核对宿主派发的页面、商品身份、实际品牌、平台、规格选择器及当前选项。截图必须实际查看。展开描述、用法、配料、警示等实际区块，查看轮播每一项及延迟加载内容。
2. 明确哪些 DOM 节点/平台 JSON 字段对应当前商品。不能先套通用字段模板，再把非空当正确。导航、购物车、推荐商品、FAQ 和营销卡片可能都在同一 HTML 中。
3. `browser.harvestHooks.fetchPageSource(productUrl)` 保存当前渲染 DOM，并返回 `{text,url,receipt}`，不导航。先前的选项和展开状态因此保留；这不是服务器 HTTP 源码。需要另一状态时由模型明确操作，保存另一份原件和观察记录，不覆盖之前的文件。
4. 只有实际确认 Shopify 后，才显式调用 `fetchProductSource(productUrl)`，保留返回的原始 `text`。它返回 `{product,text,url,receipt}` 或 null，不自动转换描述或猜成分。返回 null 时说明来源不可用，按实际 DOM/结构数据建立方法；禁止伪造平台响应。挑战、身份冲突或请求失败停止，不自动重试。
5. 将原文以独立文件保存在 outDir，用 `flag:"wx"`；源记录包含相对路径、实际 URL、类型及 receipt.sha256。原始副本也已由工具保存在任务根 `native-originals`，不可删除。JSON 不要重新 stringify，保存原始响应字节文本。

## 方法格式

从 `${SKILL}/lib/observed-product.mjs` 导入 `readObservedProduct`。输入方法只包含模型已经观察确认的来源和位置，不包含猜测字段值：

```js
const method = {
  codec: "observed-product/1",
  productUrl, // 宿主派发 URL，保留显式 variant
  sources: [
    { path: "sources/details.html", kind: "dom", url: dom.url, sha256: dom.receipt.sha256 },
    { path: "sources/product.json", kind: "json", url: platform.url, sha256: platform.receipt.sha256 },
  ],
  fields: {
    title: { source: 1, pointer: "/product/title" },
    brand: { source: 1, pointer: "/product/vendor" },
    description: { source: 1, pointer: "/product/body_html", format: "html-text" },
    // 本轮确认存在时才增加，例如：
    // recommended_daily_intake: { source: 0, selector: observedDirectionsSelector },
    // ingredients: { source: 0, selector: observedIngredientsSelector },
  },
  platform: { kind: "shopify", source: 1, pointer: "/product", offerSource: 0 },
};
```

上例只有在真实响应存在 `/product`、品牌/vendor 一致、body_html 确实是该商品完整描述时适用；不是所有站点的预设模板。描述也可指向模型实际看到的唯一 DOM 区块。`offerSource` 可选，使用已保存详情的同商品 JSON-LD offers 补足规格可售状态；出现身份或库存冲突会停止。

- `source` 是 sources 下标。DOM selector 使用完整 CSS 语法，必须匹配且仅匹配一个节点。默认返回该节点 HTML 的旧 `htmlToText` 转换结果；`attribute` 可读取明确的属性，如 `content`。不自动查其他 selector。
- JSON `pointer` 使用 JSON Pointer；默认保存原值，明确 HTML 字段可指定 `format:"html-text"`。不存在的路径报错。品牌不能从任务名称补齐。
- Shopify `platform` 仅映射已验证商品的全部网站 variants，复用旧规格规范化。不会把平台图片数组替代实际轮播，也不会按关键词解析 body_html。
- 非 Shopify 不填 platform。用 `variantMappings:[{variantId:{source,pointer},sku:{source,pointer},title:{source,pointer},options:{source,pointer},price:{source,pointer},available:{source,pointer},url:{source,pointer}}]` 指定每个真实规格字段；也支持 DOM selector/attribute。只填来源里存在的字段，不编造 ID、选项或库存。
- 基础商品有多个规格时，SKU 和价格只留在各自 variants。派发明确 variant URL 时，fields 中的 SKU/价格必须等于对应规格的值，DOM 来源 URL 必须保留同一 variant。
- 缺失的可选字段不写规则，在预览中说明 `not_present` 及检查过的区块；没有检查过写 `not_observed`，不能称缺失已确认。不同原件的币种、地区、订阅方案、商品身份或库存互相冲突时，保留冲突并返回 needs_review。

## 预览与收割执行同一个方法

以下接在本轮 Ego 初始化及实际观察之后，变量来自本轮真实结果：

```js
await mkdir(`${outDir}/sources`, { recursive: true });
const dom = await browser.harvestHooks.fetchPageSource(productUrl);
await writeFile(`${outDir}/sources/details.html`, dom.text, { flag: "wx" });
const platform = await browser.harvestHooks.fetchProductSource(productUrl); // 已确认 Shopify
if (!platform) throw new Error("observed platform source unavailable");
await writeFile(`${outDir}/sources/product.json`, platform.text, { flag: "wx" });
// 按上节构建本轮 method。
const preview = await readObservedProduct(outDir, method);
// 保存真实 preview，并逐项对照已查看的页面，记录字段位置及语义核对结论。
// 不得只检查非空或排除几个关键词；没有通过则停止，不进入收割。
const result = await runHarvest(browser, browser.tab, plan, {
  outDir,
  observedGalleryUrls, // 本轮逐项观察确认的完整原图，不按文件名筛选
  hooks: {
    extract: async () => ({ records: [await readObservedProduct(outDir, method)], needsUpgrade: [], failed: [] }),
    fetchPageHtml: async () => dom.text, // 沿用同一已保存状态，不重新访问页面
  },
});
```

`readObservedProduct` 返回的 fieldEvidence 必须随记录保留。宿主按原件散列和确切字段位置重放核对；不可在 helper 返回后补写字段或 variants。通用 `extractDetailDomRecord` / `applyDetailExtractionProfile` / `extractProductsBatch` / `upgradeProducts` 在原生任务内禁止，嵌套在 hooks 也不例外。没有 hooks.extract 就停止，没有隐藏 fallback。

保存 `field-preview.json`、`profile-validation.json`、方法 candidate 副本、截图、`capture-review.json`；逐张查看落盘原图。只凭一次单品成功不能更新为全站已验证 profile。方法错误只能在收割前基于已保存原件修正并保留预览版本；收割后发现问题保持本次结果并返回 needs_review，不清空重抓。

图库完整性、规格完整性和后续业务成功是三件事。保留网站确切图片归属；商品共用图的 variantId=null，不猜规格。保存完成后宿主关闭确切任务页并验证消失；模型不操作其他页、接管空间或开启后台任务。
