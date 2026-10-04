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

网站规格可直接复用 `lib/platform-variants.mjs` 的 `normalizePlatformVariants` 整理ID/选项等元数据，保留网站实际选项名称；无需重写格式转换。缺失值保持缺失，不补默认SKU、库存或币种。

已观察确认平台接口时，`const source = await browser.harvestHooks.fetchProductSource(productUrl)`
返回 `{product,text,url,receipt}`；使用 `normalizePlatformVariants(source.product, productUrl)`，
不要重新手写规格格式。平台的title/vendor可作为已确认商品的身份元数据，不解析正文。
规范化结果的身份字段是`variant.variantId`（字符串），不是原始平台对象的`variant.id`。
例如`for (const variant of variants) { const variantId = variant.variantId; }`；所有等待条件、
材料variantId、文件名和恢复初始状态均使用该字段，不能混用两种对象格式。
网页选项的radio.value可能是240ct等文字或option-value ID，不等于真实variant ID。先观察
选项控件、实际选中项与网站variant ID的对应关系，再执行切换；从实际选中状态读取ID并与
网站规格清单核对，不允许用选项文字兜底。控件是radio/select/按钮由模型实际观察，不猜类型。
保存前可调用 `lib/material-variants.mjs` 的 `assertMaterialVariantIds(variants, materials)`
核对索引。固定启动器会在runHarvest前执行同一检查，并与本次显式请求的原始平台规格对账。
多规格每项均须有材料索引或明确unresolved原因，不能缺一项仍声明采齐；不要求新增证明报告。
新方法首次运行前，先用同一来源/选择规则预览网站规格ID、当前选中ID和对应控件，确认没有
undefined或错对象字段，再开始保存与收割；不新增逐商品证明文件。存在真实规格URL时，
可沿旧流程直接`page.goto(variant.url)`，再核对选中状态并保存，不强制改成点击radio。
已经验证的同站方法直接复用，只有真正失效的步骤才局部重新观察。

每项 variantMaterials 只记录材料对应关系：

- 可采集：`{variantId, status: "independent" 或 "mixed", pageHtml, productHtml, galleryUrls, reason}`。
- 不可采集：`{variantId, status: "unresolved", reason}`。隔离该规格，不丢掉其他规格。

所有路径相对 outDir。pageHtml 为该状态完整页面；productHtml 为观察确认的商品正文区域原样 outerHTML，可原样连接多个实际区域，包含展开后的正文与FAQ。不按配料/用法等字段拆解、不总结或改写文字。文件只写一次，原件与索引一同归档。同一页面共用材料可复用路径，不重复抓取。规格自己的ID、SKU、价格来自网站，不能用基础默认值填充。

`main`、首屏商品容器或直接子 `section` 不是天然的商品内容边界。首次建立或修正方法时，沿完整页面观察实际商品板块，包括这些容器以外的下方详情、营养表和独立折叠区域；将属于当前商品的真实节点 `outerHTML` 一起保存。完整页面原件存在，不能代替这些材料进入 `productHtml`。按观察到的区域保存内容和详情原图，排除实际推荐节点；不要用 Facts/Ingredients 等标题关键词自动提取字段。已有方法若漏了这样的实际板块，只补相应选择范围和展开动作，继续复用导航、规格、图库和收割步骤，不每商品重做发现，不新增证明文件或采后复核。

页面切换后材料独立才标 independent；URL变化本身不能证明独立。页面仍混着多个规格则 mixed，保留该状态全部实际图库，由已有混合流程判断归属；此处不挑Facts图片、不OCR、不提取营养信息。按页面实际行为记录，不按文件名、alt、图片顺序猜测。原图并集交旧runHarvest统一保存。

复用脚本不能把所有商品的材料状态无条件写成mixed；本商品的判断理由与观察记录不放进可复用
脚本常量。图库按已观察的实际媒体项选择完整原图，缩略图和响应尺寸不另算一项；优先读取
页面实际原图链接或srcset中已出现的最大版本。不通过删除width/height、改文件名或拼URL造
原图，不丢弃可能改变内容的crop/format等参数。图库来源映射仍由模型观察选择。
在收割前确认网站的实际放大图入口，并把已观察的大图地址来源保存进方法；不要只读取
当前显示尺寸而漏掉已确认的原图链接。不为补尺寸重新下载已完成任务的材料。
每个规格“各存一份HTML”或“选中ID正确”都不等于independent：还要观察资料是否实际随规格
分开。完整图库继续包含多个规格、或资料归属仍不明确时使用mixed，让后续已有归属流程处理。
不要仅因为保存动作独立就写independent，也不要在脚本里将全部商品无条件写mixed。

## 复用与执行

先复用已有 site-method.mjs / method-cache.json，仅局部修正不适用步骤。首次才视觉观察并验证真实节点或网站数据位置。脚本只保存动作/规则，不硬编码商品值或引用旧任务目录。禁止通用关键词提取器。

实际展开相关折叠、嵌套FAQ和懒加载，再保存当前完整页面与商品区域。`browser.harvestHooks.fetchPageSource` 不导航；不同状态另存。需要的平台响应仅通过明确观察过的 `fetchProductSource` 取得。收割前恢复初始选中状态。

先 `node --check site-method.mjs`，再用 Ego `nodejs -e` import 固定启动器绝对file URL。宿主保存实际执行脚本和散列；材料完整存档后保留该方法，后续同站商品复用，不手改成功计数。一个样本通过不代表全站验证。

runHarvest仍保存records、页面和完整图片；fields不装业务内容。materials.json由固定启动器保存，不需要模型另写证明文件。开始收割后不删checkpoint、不改原件、不重抓。只采集，不执行semantic导出、Facts、enrich或入库。

固定收割完整结束且材料已保存时，图片像素较小、网站可选字段缺失等差异只记 notes，
不能仅因此返回 needs_review，也不在采集阶段预测后续 OCR/产品处理能否成功。
complete 表示采集结束，内容可用性由原后续流程判断；实际身份冲突、必需材料未保存、
收割失败及用户控制边界仍明确停止。不能伪造完整性、抹掉缺口或忽略所有 needs_review。
