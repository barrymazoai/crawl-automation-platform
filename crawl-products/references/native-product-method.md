# Ego 原生单商品：观察决定方法，脚本保存原件

此文只适用于宿主 `captureMode=product`。沿用旧采集的站点判断、观察、收割和证据包；后续 OCR、规格处理及业务入库由宿主负责。

## 多规格交接

基础商品仍只收割一次，`records.json` 只有一条，保留完整网站规格清单和所有实际观察的图片。逐规格处理使用这份原件，不重新抓取基础商品。缺货规格同样保留。

有多个规格时，为每个规格在 `capture-review.json.variantContexts` 保存一项（实际 schema 在任务根 `variant-context.schema.json`）：

```json
{"variantId":"实际网站ID","status":"observed","methodPath":"methods/variant-ID.json","galleryUrls":["该规格实际适用且已保存的原图URL"],"basis":"variant-state","reason":"本次实际操作和适用范围依据","evidence":["该状态的截图或原件路径"]}
```

- `methodPath` 指向单独保存的 `observed-product/1` 方法；先用同一 `readObservedProduct` 预览核实。规格身份仍由网站提供，不能从图片判断。该方法返回完整的原始网站 variants 清单，不手工删减或修改。
- `variant-state`：明确操作网站选项，确认规格、价格方案/地区，展开所需内容并另存当前 DOM 和截图。method.productUrl 和 DOM 来源 URL 带该真实 variant；只映射此状态适用的字段。每次保存新文件，不能覆盖原件。galleryUrls 是确认适用的完整图库范围，不按文件名或关键词挑 Facts 图片。
- 当前已经选中的规格无需再次请求页面：核对已存 DOM 的实际来源 URL 和页面状态，另存一份该规格的方法，`productUrl` 使用实际带 variant 的 URL。基础商品方法仍保留基础 URL。不能把不带规格的同一个方法塞给所有 `variant-state`；菜单里有另一个选项不等于已经观察了另一个状态。
- `website-shared`：仅当网站明确说明这些内容适用于该规格/全部这些规格时使用，可以引用基础商品方法。必须增加 `sharedScope:{rule:{source:原件下标,selector:"明确声明的确切DOM位置"},text:"该位置读取的完整网站原文"}`；JSON 可用 pointer，读取规则与字段方法相同。先用 `readObservedField(outDir, observedMethod, rule)` 核对原文；宿主会按原件散列重放位置并逐字比对。reason 解释该原文为何明确覆盖此规格及本次资料范围，不能把自己的总结填作网站原文。网页普通商品描述、单一轮播、当前默认选项、图库未变化、商品名相同或图片没绑定，都不是网站共用声明。找不到明确声明时，实际操作各规格并走 `variant-state`；不可访问或范围仍有冲突的规格记 unresolved。基础商品共用的方法不能带默认规格 SKU/价格。
- 不同配方/口味/剂量的内容按网站选项和对应区块分别指定；不得复制兄弟规格的原料、用法或 Facts。网站明确的尺寸/包装数量关系可加 `difference:{"kind":"size"或"pack-count","group":"网站实际选项组名"}`；其他关系可用 flavour/strength/form/unknown。不凭关键词自动分类；该声明仅允许后续尝试现有的标签一致性检查，不直接复用配方。
- 各状态观察到的新图库原图加入基础收割的 `observedGalleryUrls` 并全部保存，再在每项中引用已保存子集；不可用其他规格明确绑定的图片。
- 每个 observed 上下文增加 `galleryReview`，逐图覆盖全部 `observedGalleryUrls`。每项为 `{url,status:"applicable"|"other-variant"|"unresolved",reason,evidence:["实际查看的截图或原图"]}`；applicable 还需 `basis:"website-binding"|"visual-content"|"website-shared"`。website-binding 要与网站确切绑定一致，visual-content 要说明实际图中文字/包装标记为什么对应网站已知规格；website-shared 必须有本上下文的 sharedScope 声明。**切换后仍显示、图片绑定为空、文件名/alt、共用轮播本身均不证明适用。** 比如同一轮播包含 120ct 与 240ct 的包装和成分表，应保存全部图，但不能把两种每瓶份数的表都交给 120ct。此步骤限定图片使用范围，不从图片采集规格，也不执行配方语义提取。
- `galleryUrls` 恰好等于 galleryReview 中 applicable 的 URL；其余图仍在基础商品原件中，不能改绑给当前规格。没有任何已确认适用图片时该规格 unresolved，其他规格继续。默认选项也须独立保存状态，采前漏存可以通过真实控件切回补证，不能直接把“没保存”说成“网站不可访问”。
- 无法确认某规格的适用范围、选项不可访问或出现状态冲突，保存 `{"variantId":"真实ID","status":"unresolved","reason":"具体未确认内容","evidence":["实际证据路径"]}`。不要猜测，也不丢掉该规格。宿主会单独记 Review，继续处理其他规格。缺少上下文的旧原件也会这样保留，不能把旧基础商品成功冒充每个规格都成功。

这些都是资料采集及交接，不在浏览器阶段执行 OCR、语义提取或入库；完成原件和复核后释放页面。

在 `runHarvest` 前，对每个 `status:observed` 上下文执行以下只读预检，并将结果、方法路径和未解决原因保存到 `variant-preflight.json`。这是宿主使用的同一个检查函数，不是另一套非空判断：

```js
import { saveObservedVariant } from "./lib/observed-variant.mjs"; // 按 skillRoot 使用绝对路径
const checked = await saveObservedVariant(outDir,
  {...basePreview, gallery: observedGalleryUrls.map(url => ({url}))}, context, variantMethod);
// 工具保存真实方法文件，返回包含 methodPath 的完整上下文；宿主随后重放并精确比对。
preflight.contexts.push(checked);
```

`variant-preflight.json` 格式为 `{contexts:[{context,method,passed:true}]}`，覆盖全部 observed 上下文。不能用空 galleryUrls 做来源预检后再填图库；完整图库逐图检查也在同一函数内。采前修改上下文必须重做预检、保留修订记录，最终文件只引用实际通过的版本。收割后发现范围错误保留产物并 Review，不手改范围补成成功。

`variant_method_requires_selected_url` 表示错误引用了基础方法，`variant_source_selected_conflict` / `source_variant` 表示引用了另一个规格状态。基于已有原件另存正确方法，不改变原件 URL、散列或内容；需要新观察时在收割前操作。仍无法确认的规格明确记 unresolved。只有原件一致性通过后，再由模型核对资料的实际适用范围；预检不会替你判断共用配方，也不会导航、补字段或重抓。

## 先观察，再指定读取位置

1. 用 Ego skill 核对宿主派发的页面、商品身份、实际品牌、平台、规格选择器及当前选项。截图必须实际查看。展开描述、用法、配料、警示等实际区块，查看轮播每一项及延迟加载内容。
2. 明确哪些 DOM 节点/平台 JSON 字段对应当前商品。不能先套通用字段模板，再把非空当正确。导航、购物车、推荐商品、FAQ 和营销卡片可能都在同一 HTML 中。
3. `browser.harvestHooks.fetchPageSource(productUrl)` 保存当前渲染 DOM，并返回 `{text,url,receipt}`，不导航。先前的选项和展开状态因此保留；这不是服务器 HTTP 源码。需要另一状态时由模型明确操作，保存另一份原件和观察记录，不覆盖之前的文件。
4. 只有实际确认 Shopify 后，才显式调用 `fetchProductSource(productUrl)`，保留返回的原始 `text`。它返回 `{product,text,url,receipt}` 或 null，不自动转换描述或猜成分。返回 null 时说明来源不可用，按实际 DOM/结构数据建立方法；禁止伪造平台响应。挑战、身份冲突或请求失败停止，不自动重试。
5. 将原文以独立文件保存在 outDir，用 `flag:"wx"`；源记录包含相对路径、实际 URL、类型及 receipt.sha256。原始副本也已由工具保存在任务根 `native-originals`，不可删除。JSON 不要重新 stringify，保存原始响应字节文本。

## 方法格式

从 `${SKILL}/lib/observed-product.mjs` 导入 `readObservedProduct`。输入方法只包含模型已经观察确认的来源和位置，不包含猜测字段值：

```js
const observedMethod = {
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

上例只有在真实响应存在 `/product`、品牌/vendor 一致、body_html 确实是该商品完整描述时适用；不是所有站点的预设模板。描述也可指向模型实际看到的唯一 DOM 区块。`offerSource` 指定已保存详情的同商品 JSON-LD offers 来源。平台 JSON 没有全部规格 available 布尔值时，此项必填，不能静默丢失网站已有的库存状态；出现身份或库存冲突会停止。

- `source` 是 sources 下标。DOM selector 使用完整 CSS 语法，必须匹配且仅匹配一个节点。默认返回该节点 HTML 的旧 `htmlToText` 转换结果；`attribute` 可读取明确的属性，如 `content`。不自动查其他 selector。
- JSON `pointer` 使用 JSON Pointer；默认保存原值，明确 HTML 字段可指定 `format:"html-text"`。不存在的路径报错。品牌不能从任务名称补齐。
- 需要保留表格或结构正文时显式指定 `format:"html"`：DOM 保存所选节点的完整 outerHTML（包括 table、行列和脚注），JSON 保存原 HTML 字符串；下游保留其结构。默认及旧 `raw` 的 DOM 文本语义保持兼容，不能用 `raw` 代替新 HTML 格式。
- Shopify `platform` 仅映射已验证商品的全部网站 variants，复用旧规格规范化。不会把平台图片数组替代实际轮播，也不会按关键词解析 body_html。
- 非 Shopify 不填 platform。用 `variantMappings:[{variantId:{source,pointer},sku:{source,pointer},title:{source,pointer},options:{source,pointer},price:{source,pointer},available:{source,pointer},url:{source,pointer}}]` 指定每个真实规格字段；也支持 DOM selector/attribute。只填来源里存在的字段，不编造 ID、选项或库存。
- 基础商品有多个规格时，SKU 和价格只留在各自 variants。派发明确 variant URL 时，fields 中的 SKU/价格必须等于对应规格的值，DOM 来源 URL 必须保留同一 variant。
- 缺失的可选字段不写规则，在预览中说明 `not_present` 及检查过的区块；没有检查过写 `not_observed`，不能称缺失已确认。不同原件的币种、地区、订阅方案、商品身份或库存互相冲突时，保留冲突并返回 needs_review。

## 预览与收割执行同一个方法

### 详情完整性预检

完整读取宿主生成的 `detail-coverage.schema.json`。页面走到底，实际打开商品折叠内容，检查懒加载后，按实际观察列出每个区块。商品描述、质量/认证、用法、警告及 FAQ 的适用正文都要进入相应 `method.fields`；其他商品、导航等明确排除并说明依据。包含多种商品的公共文案不能整块当成本商品资料。宿主不按标题关键词代你选择。

`detailCoverage` 格式（下面每项只是格式示例，位置和结论必须来自实际观察）：

```js
const detailCoverage = {
  version: "observed-details/1", reachedEnd: true,
  pageEvidence: ["walk-to-bottom.png"],
  sections: [{
    name: "本次观察到的区块名称", status: "captured",
    field: "description", location: observedMethod.fields.description,
    imageUrls: [], reason: "确属本商品且完整正文进入该字段", evidence: ["description-open.png"],
  } /* 列出所有实际观察的商品区块；排除项 status:excluded,field:null */],
  checks: [
    {kind:"description",status:"captured",fields:["description"],imageUrls:[],reason:"实际依据",evidence:["description-open.png"]},
    // ingredients、directions、warnings、facts 各一项，不能省略。
    // 仅图片：status:"image-only",fields:[],imageUrls:[已保存原图URL]。
    // 真实检查后没有：status:"not-present",fields:[],imageUrls:[],reason及检查证据。
  ],
};
```

每个 section 都有确切 `location`（规则格式与字段相同）、reason、evidence、field（没有文字则 null）和 imageUrls。`captured` 的 location 必须等于实际交接字段规则。`image-only` 区块用已观察的唯一图像节点及其属性定位，并引用保存的原图；不能只把 Facts 标题当作正文。闭合的原生 details 不能伪称展开；自定义折叠也必须实际操作并留证。遮挡、未检查或无法确认的项记 `uninspected`，返回 needs_review，不能填 not-present。

在收割前调用同一机械校验并保存完整证据，避免最终手抄遗漏：

```js
import { saveObservedDetails } from "./lib/observed-details.mjs"; // 使用 skillRoot 绝对路径
const { detailCoveragePath } = await saveObservedDetails(outDir,
  {...basePreview, gallery: observedGalleryUrls.map(url => ({url}))}, detailCoverage);
// 最终 capture-review.json 使用这个原样返回的 detailCoveragePath。
```

工具只校验模型的选择与原件、展开状态、实际交接字段及图片之间的一致性，不发现字段、不 OCR、不操作浏览器。所有截图/来源放在 outDir 内。`detailComplete:true` 不能代替这份逐项证明；宿主对新原生采集强制验证。旧原件继续保持原样可审查，但不能声称已经通过新的完整性验收。

每个 observed/mixed 规格使用自己的方法返回值与适用图库执行同样的 `saveObservedDetails`，将返回路径放进 `context.detailCoveragePath`，再调用 `saveObservedVariant`。最终上下文仍原样读取预检，不手抄。确有网站共用依据时可以复用相同原件/位置，但必须证明该规格方法实际包含正文；不能把基础商品的字段证明套在缺少这些字段的规格方法上。缺少证明或不完整的规格单独 Review，不丢其他完整规格。

先用 `validateHarvestPlan(plan)` 验证计划，在获取 HTML/JSON/图片之前修正 schema 错误；该函数从 `lib/harvest-plan.mjs` 导入，返回 `{valid,errors,plan}`。单品 `single_page_confirmed` 只属于 perSeed.exhaustionSignal，不是 oracle 类型；无目录总数断言时使用 `oracles:[]`。采前修正计划/方法时读取已保存原件，不再次调用抓取函数、不覆盖或清空旧文件。字段与校验结论的修订另存版本。

以下接在本轮 Ego 初始化、实际观察与计划验证之后，变量来自本轮真实结果：

```js
await mkdir(`${outDir}/sources`, { recursive: true });
const dom = await browser.harvestHooks.fetchPageSource(productUrl);
await writeFile(`${outDir}/sources/details.html`, dom.text, { flag: "wx" });
const platform = await browser.harvestHooks.fetchProductSource(productUrl); // 已确认 Shopify
if (!platform) throw new Error("observed platform source unavailable");
await writeFile(`${outDir}/sources/product.json`, platform.text, { flag: "wx" });
// 按上节构建本轮 observedMethod。
const preview = await readObservedProduct(outDir, observedMethod);
// 保存真实 preview，并逐项对照已查看的页面，记录字段位置及语义核对结论。
// 不得只检查非空或排除几个关键词；没有通过则停止，不进入收割。
const result = await runHarvest(browser, browser.tab, plan, {
  outDir,
  observedGalleryUrls, // 本轮逐项观察确认的完整原图，不按文件名筛选
  hooks: {
    extract: async () => ({ records: [await readObservedProduct(outDir, observedMethod)], needsUpgrade: [], failed: [] }),
    fetchPageHtml: async () => dom.text, // 沿用同一已保存状态，不重新访问页面
  },
});
```

`readObservedProduct` 返回的 fieldEvidence 必须随记录保留。宿主按原件散列和确切字段位置重放核对；不可在 helper 返回后补写字段或 variants。通用 `extractDetailDomRecord` / `applyDetailExtractionProfile` / `extractProductsBatch` / `upgradeProducts` 在原生任务内禁止，嵌套在 hooks 也不例外。没有 hooks.extract 就停止，没有隐藏 fallback。

任务根目录的 `capture-review.schema.json` 是宿主实际 schema，先读再写复核文件。`capture-review.json.method` 必须是字符串（例如“逐项查看轮播及落盘原图，并对照商品平台字段”）；字段读取方法对象是 `observedMethod`，保存在 method-candidate.json 与记录的 fieldEvidence 中，不能把它赋给复核文件的 method。返回 complete 前检查复核文件所有字段类型与该 schema 一致。

保存 `field-preview.json`、`profile-validation.json`、方法 candidate 副本、截图、`capture-review.json`；逐张查看落盘原图。只凭一次单品成功不能更新为全站已验证 profile。方法错误只能在收割前基于已保存原件修正并保留预览版本；收割后发现问题保持本次结果并返回 needs_review，不清空重抓。

图库完整性、规格完整性和后续业务成功是三件事。保留网站确切图片归属；商品共用图的 variantId=null，不猜规格。保存完成后宿主关闭确切任务页并验证消失；模型不操作其他页、接管空间或开启后台任务。

## DTC 规格资料分流

规格选中状态必须实际观察并留存独立方法，默认项也不例外。资料已对应选中规格时使用 `status:observed` 和逐图 `galleryReview`；图库/Facts 仍混在一起时使用 `status:mixed`、`basis:variant-state`、完整 `galleryUrls`、实际 `methodPath` 与观察证据。mixed 不要求浏览器先做图片归属，页面关闭后由 DTC 前置复用 OCR，再让 Codex 根据网站规格和原图判断。两路最终都回到旧单品 Facts 流程。

URL 变化不证明资料隔离，URL 不变也不证明无法隔离。没有独立规格 URL 时，提供 `selectedState:{rule:{source,selector,attribute},value:实际variantId}`，规则必须指向已保存页面中的实际选中状态，不能指向规格清单任意项。有独立地址时明确访问、验证自身身份，再保存；保存 HTML 的工具不自动导航，客户端遗留的旧 JSON 不当成新规格原件。

所有 observed/mixed 上下文都用 `readObservedVariant` 完成原件预检，保留最终 context、method、passed:true 于 `variant-preflight.json`。mixed 必须保留完整图库；缺少状态或原件则 `unresolved`，OCR 不负责猜补采集。共用 Facts 必须有明确依据，不能由相同图片、相似成分、文件名或轮播位置推定。

## 最终交接不重复抄写规格上下文

真实验收中曾出现：预检完整，但手写最终 `variantContexts` 时漏掉 `reason` 和 `selectedState`，两个规格都被宿主拦成 Review。已通过的上下文必须原样读取，不能逐字段重建：

```js
import { readPreflightVariantContexts } from "./lib/observed-variant.mjs"; // 使用 skillRoot 绝对路径
const variantContexts = await readPreflightVariantContexts(outDir);
const review = { ...reviewWithoutVariantContexts, variantContexts };
await writeFile(`${outDir}/capture-review.json`, JSON.stringify(review), { flag: "wx" });
```

该函数只搬运已保存的完整预检上下文，不重新判断图片、不提取字段、不补造规格证据。最终仍由宿主重放原件并精确比对。真实 unresolved 项可单独追加；全部 unresolved 时直接保存这些项，不把失败预检标为通过。`capture-review.schema.json` 现在包含逐规格的完整类型要求，最终校验不能只检查顶层字段。

`methodPath` 必须是实际保存的 JSON 方法文件，不能写成“HTML 路径 + JSON 路径”的文字说明。采前用 `saveObservedVariant` 由工具保存方法并返回路径；它仍使用模型选定的原件/字段方法/图库范围，不提供任何通用提取器。`readPreflightVariantContexts` 会重新读取该文件并与预检内联方法比对，缺失或不一致就停止交接。
