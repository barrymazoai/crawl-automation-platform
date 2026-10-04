# 原生目录：观察路线，直接复用旧枚举器

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
