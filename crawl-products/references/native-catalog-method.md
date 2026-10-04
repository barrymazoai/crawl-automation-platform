# 原生目录：观察路线，直接复用旧枚举器

宿主已生成固定 `run-capture.mjs` 时，模型不要改启动器。只维护任务根目录
`catalog-method.mjs`，导出两个函数：

- `async prepare({page,tab,sourceUrl,outDir})`：复用已经观察验证的导航步骤，读取本次
  目录数量，返回 `{seedUrls,listingOptions,oracle:{expected:number|null,comparable:boolean,basis}}`。
  `listingOptions` 使用下文的旧参数；不传 `outDir/profileDir/enumerate/onListingPage`。
- `projectPage({document,url,sourceUrl})`：在固定入口传入的本页原始HTML document 上，
  按已观察规则返回 `[{url,title,brand}]`。仅目录身份，不提取商品业务字段。不要读其他页面
  或API补条目，返回集合必须与该页旧枚举器保存的URL完全相同。

固定入口负责唯一 `discoverCatalog` 调用、逐页原件、方法源代码与散列、`catalog.json`
及完成回执。`comparable=true` 时数量不符会保留 `complete=false`，不能手改交接结果。
先 `node --check catalog-method.mjs`，再通过 Ego 导入固定启动器。开始后不重跑。

`catalog-script-cache.json` 为 `verified` 时复用已通过完整目录验收的确切脚本，只修
结构确实失效的步骤。为 `candidate` 时是保留原始观察的修复候选，不等于已通过验收；
沿其中已知商品网格和分页控件做当前首末页视觉核验、实际点击并检查变化，不从零猜路线。
控件可用 `page.hover(已知选择器)` 带入视口后截图查看，不能用网站页脚当目录尾部。
公共脚本缓存按完整来源URL隔离，只在宿主现有身份/页面/完整性校验通过后保存。
方法可以包含站点已观察的选择器、动作及原文映射规则，不包含固定商品清单或上次总数。
版本化候选登记在 [站点方法目录](../methods/catalog/index.json)，不是通用关键词提取模板。

先在实际页面确认商品网格、分页动作和最后一页。将已验证的选择器作为参数传给
`discoverCatalog`，让它默认调用旧 `collectProductUrls`；普通翻页、点击加载、滚动
不需要自行实现 `enumerate`，也不需要重新组装 coverage、seedReports 或 onListingPage。
页面原件保存、每个 seed 的完成记录、零增长复核都由现有入口负责。

例如，实际观察到需要点击的图形分页控件时，用下面的结构。变量必须来自本轮观察，
不是示例选择器或根据 URL 猜测出的下一页：

```js
const paginationActions = [{ action: "click", selector: observedNextSelector }];
const discovery = await discoverCatalog(tab, seedUrls, {
  outDir, profileDir,
  productLinkSelectors: observedProductLinkSelectors,
  paginationActions,
  listingProfile: {
    productLinkSelectors: observedProductLinkSelectors,
    paginationActions,
  },
  listingCoverage: seedUrls.map(url => ({
    url, paginationMode: "click", verifiedVisually: true,
  })),
  completionProof: "enumeration",
  extraRoundsAfterConverge: 1,
  maxRounds: 4,
  maxPagesPerSeed: observedPageBudget,
});
```

`observedNextSelector` 只匹配当前可用的下一页控件；在最后一页检查其消失或不可用，
不能选择“上一页”或任意页码。`maxPagesPerSeed` 是安全上限，不是已确认的页数；
多页目录不能为了逐页截取而固定为 1。普通链接分页使用 `paginationMode:"link"`；
确认单页才使用 `none`，滚动加载使用观察到的原有 scroll 参数。

不要同时把同一个目录的每个页码当 seed 又重写遍历回调。`onListingPage` 的页面记录
没有 `status`；只有返回的 `coverage.seedReports` 有完成状态，把两者合并会将已采齐
目录误判为不完整。若现有枚举器确实无法表达已观察路线，保留具体限制，不另造完成证明。
