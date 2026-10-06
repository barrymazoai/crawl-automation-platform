# 原生目录：观察路线，直接复用旧枚举器

## 标准写法：用 catalog-kit 填写观察到的配置（2026-10-06）

新站点和需要重写的方法一律优先用公共工具，只填本轮实际观察到的事实，不手写 prepare/projectPage：

```js
import { defineCatalogMethod } from "<skillRoot>/lib/catalog-kit.mjs";
export const { prepare, projectPage } = defineCatalogMethod({
  ready: "已观察的商品网格就绪选择器",
  productLinks: "限定在商品网格内的商品详情链接选择器",
  card: "可选：一张商品卡片",
  title: "可选：卡片内标题选择器（默认用链接文字）",
  pagination: { mode: "none" },   // none | link | click（需 next 选择器）| scroll
  identity: "可选：只在第一页核对一次的站点身份选择器",
  count: { selector: "可选：网站显示总数的节点", pattern: "(\\d+) items" },
  brand: "可选：多品牌卖场卡片内的品牌节点",
});
```

工具负责导航、就绪等待、listingOptions、oracle 和 projectPage。只有工具确实表达不了的路线
才手写方法，并必须遵守下面的接口和规则：

- `prepare` 的参数恰好是 `{ page, tab, sourceUrl, outDir, navigate }`；导航用 `navigate(url)`。
- `projectPage({ document, url, sourceUrl })` 在 Node 中读取已保存的页面 HTML（linkedom），
  不是浏览器：没有 `location`，`document.baseURI` 不可用。链接一律 `new URL(a.getAttribute("href"), url)`。
- 不写死上次看到的数量或网格个数；总数只作为可比 oracle。
- 站点身份只在 `prepare` 的第一页核对一次，不在每页 projectPage 里抛错。
- 固定启动器只跟随目录路径之内的下一页（如 `/page/2/`、`?page=2`）；`/feed/` 等目录外链接不是分页。
- 方法读不出某页时，启动器保留枚举器已在该页保存的商品链接并记警告，不丢弃已取得的商品。
- 脚本在开始遍历之前报错（如 prepare 失败）时，可修正 catalog-method.mjs 后再执行一次启动器；
  第一次的文件自动移到 attempt-1/。遍历开始后或第二次之后不再重跑。

## 原有接口说明

宿主已生成固定 `run-capture.mjs` 时，模型不要改启动器。只维护任务根目录
`catalog-method.mjs`，导出两个函数：

- `async prepare({page,tab,sourceUrl,outDir,navigate})`：复用已经观察验证的导航步骤，读取本次
  目录数量，返回 `{seedUrls,listingOptions,oracle:{expected:number|null,comparable:boolean,basis}}`。
  `listingOptions` 使用下文的旧参数；不传 `outDir/profileDir/enumerate/onListingPage`。
- `projectPage({document,url,sourceUrl})`：在固定入口传入的本页原始HTML document 上，
  按已观察规则返回 `[{url,title,brand}]`。仅目录身份，不提取商品业务字段。不要读其他页面
  或API补条目，返回集合必须与该页旧枚举器保存的URL完全相同。

固定入口负责唯一 `discoverCatalog` 调用、逐页原件、方法源代码与散列、`catalog.json`
及完成回执。`comparable=true` 时数量不符会保留 `complete=false`，不能手改交接结果。
先 `node --check catalog-method.mjs`，再通过 Ego 导入固定启动器。遍历开始后不重跑；开始遍历之前的脚本错误可修正后再执行一次。

`catalog-script-cache.json` 为 `verified` 时复用已通过完整目录验收的确切脚本，只修
结构确实失效的步骤。为 `candidate` 时是保留原始观察的修复候选，不等于已通过验收；
沿其中已知商品网格和分页控件做当前首末页视觉核验、实际点击并检查变化，不从零猜路线。
控件可用 `page.hover(已知选择器)` 带入视口后截图查看，不能用网站页脚当目录尾部。
公共脚本缓存按完整来源URL隔离，只在宿主现有身份/页面/完整性校验通过后保存。
方法可以包含站点已观察的选择器、动作及原文映射规则，不包含固定商品清单或上次总数。
版本化候选登记在 [站点方法目录](../methods/catalog/index.json)，不是通用关键词提取模板。

新建或修改方法时，在采前核对方法内实际使用的选择器和就绪条件，不能只确认页面上有商品。
数量、标题、品牌从已经观察到的具体节点读取；不要改成扫描整页可见文字。抽屉节点的
textContent 与 body.innerText、CSS大写显示与原始文本可能不同，正常显示差异不应当阻塞采集。
采前条件不成立先检查当前DOM并局部修正方法；不要用正式的唯一收割调用来试猜测规则。
已验收方法只需廉价结构检查，不为每个商品新增整套发现/证明任务。

采前导航使用 `prepareBrowserRound` 返回的 `navigate(url)`，等待 DOMContentLoaded，
然后等待方法已知的卡片/选中状态并查看截图；不要裸 `page.goto(url)` 等整页所有资源load。
已明确提交到准确目标URL且页面interactive/complete的导航超时，先留警告并检查当前页，
不再发一次导航。URL不符、页面不可用、权限/用户控制/挑战仍停止；DOM就绪不是资料已完整。

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
