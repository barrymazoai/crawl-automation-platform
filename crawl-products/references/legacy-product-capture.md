# DTC 资料采集出口（dtc-materials/1）

复用已有 Ego 和旧 runHarvest 保存材料。采集不解析产品业务字段，不运行额外采后复核。宿主关页、归档后固定整理材料引用，交原有后续处理；只有混合规格材料进入已有 OCR/图片归属流程。

## 站点脚本

宿主生成固定 run-capture.mjs。模型维护可复用 site-method.mjs，重放已观察验证的导航、展开、网站规格和完整原图采集动作；不要重写启动器。

```js
export async function capture({ browser, tab, page, productUrl, outDir, skillRoot }) {
  return {
    record: {
      sourceUrl: productUrl,
      fields: { title, brand, currency }, // 仅网站身份元数据；未知项省略
      variants, // 网站ID/URL/选项/SKU/价格/库存，包含缺货
    },
    galleryUrls, // 所有状态的实际商品轮播和详情原图并集
    materials: {
      selectedVariantId, // 网站初始选中项，未知为null
      productHtml, // 初始商品区域原样HTML文件路径
      variants: variantMaterials, // 多规格逐项对应；单规格可为[]
    },
    notes, // 简记实际操作、原件位置与缺项
  };
}
```

每项 variantMaterials 只记录材料对应关系：

- 可采集：`{variantId, status: "independent" 或 "mixed", pageHtml, productHtml, galleryUrls, reason}`。
- 不可采集：`{variantId, status: "unresolved", reason}`。隔离该规格，不丢掉其他规格。

所有路径相对 outDir。pageHtml 为该状态完整页面；productHtml 为观察确认的商品正文区域原样 outerHTML，可原样连接多个实际区域，包含展开后的正文与FAQ。不按配料/用法等字段拆解、不总结或改写文字。文件只写一次，原件与索引一同归档。同一页面共用材料可复用路径，不重复抓取。规格自己的ID、SKU、价格来自网站，不能用基础默认值填充。

页面切换后材料独立才标 independent；URL变化本身不能证明独立。页面仍混着多个规格则 mixed，保留该状态全部实际图库，由已有混合流程判断归属；此处不挑Facts图片、不OCR、不提取营养信息。按页面实际行为记录，不按文件名、alt、图片顺序猜测。原图并集交旧runHarvest统一保存。

## 复用与执行

先复用已有 site-method.mjs / method-cache.json，仅局部修正不适用步骤。首次才视觉观察并验证真实节点或网站数据位置。脚本只保存动作/规则，不硬编码商品值或引用旧任务目录。禁止通用关键词提取器。

实际展开相关折叠、嵌套FAQ和懒加载，再保存当前完整页面与商品区域。`browser.harvestHooks.fetchPageSource` 不导航；不同状态另存。需要的平台响应仅通过明确观察过的 `fetchProductSource` 取得。收割前恢复初始选中状态。

先 `node --check site-method.mjs`，再用 Ego `nodejs -e` import 固定启动器绝对file URL。宿主保存实际执行脚本和散列；材料完整存档后保留该方法，后续同站商品复用，不手改成功计数。一个样本通过不代表全站验证。

runHarvest仍保存records、页面和完整图片；fields不装业务内容。materials.json由固定启动器保存，不需要模型另写证明文件。开始收割后不删checkpoint、不改原件、不重抓。只采集，不执行semantic导出、Facts、enrich或入库。
