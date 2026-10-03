# 旧 DTC 单品采集出口（legacy-harvest/1）

此宿主复用已经使用 Ego 的旧 DTC 采集行为：模型观察、验证并学习站点方法，旧 runHarvest 保存原始商品包。浏览器阶段结束后宿主关页、归档，再对留存资料复核、判断混合规格并固定转换。不要把 native-product-method.md 中后加的详情/规格证明流程搬进本阶段。

## 固定启动器与可复用方法

宿主生成任务根 `run-capture.mjs`，内部使用 `lib/site-capture.mjs` 调旧 runHarvest。不要改启动器、手写交接转换或重新枚举已派发商品。模型只负责站点方法 `site-method.mjs`：

```js
export async function capture({ browser, tab, page, productUrl, outDir, skillRoot }) {
  // 重放这个站点实际验证过的动作和位置；从本商品读值，不复制示例商品的值。
  // 用 browser.harvestHooks 保存当前 HTML、明确需要的平台响应与原件。
  // 按需从 skillRoot 动态 import 已有纯读取/规范化工具。
  return {
    record: { sourceUrl: productUrl, fields, variants },
    galleryUrls, // 当前实际产品轮播/详情中的完整原图集合
    notes, // 覆盖、展开/切换观察、缺项、截图/原件路径；相对 outDir
  };
}
```

示例变量均须由当前页面真实观察/已验证方法产生。函数只保存规则与动作，不硬编码某商品 URL、ID、价格、SKU、字段正文或图库 URL 数组，也不引用以前任务的文件。可使用旧 profile 的导航、展开和已确认字段选择器；不得调用通用关键词/猜测提取器。`readObservedProduct` 可作为执行确切位置的工具，但不要求为了使用旧输出再造 fieldEvidence。若使用了它，原件与方法保持真实，不能改返回值掩盖来源冲突。

首次学习按旧机制先视觉观察、再映射与核对。宿主提供已有 `site-method.mjs` 时先读 `method-cache.json`，对当前商品做便宜校验后复用；一个成功样本仅为 candidate，下一商品验证同一方法后才有多样本依据。普通商品值变化不应改脚本。方法失效只修不适用的步骤；保留原件，不用宽泛 fallback 代替观察。

先 `node --check site-method.mjs`，再通过 Ego `nodejs -e` import 固定启动器的绝对 file URL。Ego 每次 nodejs 是新进程，不能依赖上一轮变量。写额外观察脚本时同样先做语法检查。宿主会保存实际执行的模块散列与副本，在采后复核接受原始输出后，将该版本留在原有 profileDir 下的 capture-methods；后续任务自动获得这个方法。无需手改 profile 的成功计数。

## 原始内容范围

- 保留完整 fields、variants、gallery、pageHtml、coverage、flags，网站全规格包含缺货项。基础多规格商品的 SKU/价格不能来自任意默认项。
- 商品详情的用法、原料、描述、警告、质量/认证、FAQ 等按实际适用范围采集，不能只读平台 body_html。实际展开嵌套折叠，保留原文和截图；没检查不能记作不存在。
- 如果切换规格改变正文/图库，按旧流程观察对应状态并另存原件，分别保存适用正文，保留状态说明。没有独立 URL 时也看实际选项和内容变化；无需手写新版 variantContexts/preflight。缺货项仍尝试其公开资料，记录真实失败范围。
- 收齐实际轮播和详情原图，排除经观察确认的推荐、徽章或导航图；不能按文件名、alt、顺序、关键词挑 Facts。图片全部留给采后复核与既有 Facts 流程。
- `fetchPageSource` 只保存当前已展开状态，不导航。每次新状态用新文件名，原始副本由 native-originals 与宿主归档保留。

收割前解决方法问题，运行 runHarvest 后保留所有产物；不删除 checkpoint、不改 records、不 fresh 重抓。失败或未能确认的关键缺口返回 needs_review。先有原始输出，再判断混合，最后固定转换；采集不做 OCR、配方推断、语义归一化、API-ready 导出或入库。
