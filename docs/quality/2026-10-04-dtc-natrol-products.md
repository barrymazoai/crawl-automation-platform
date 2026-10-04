# Natrol 跨站商品与方法复用验证

关联CRAWLV3-183/184/155/151。205行内数量修复完成后，继续未覆盖站点的真实商品处理。
Natrol目录已完整发现46项且相同方法复用通过；此前没有Natrol产品run，46个原始队列项
均为attempt0。本轮通过现有runs.submit单项执行，保留批量队列paused，不重排旧Review。

预检：Server一与二必要Worker均为4c178eca；DTC品牌队列paused/无running或cleanupPending，
商品队列paused/686queued、held=[]，实际Space6、OCR、模型资源健康。源
`a97a24a2-284b-4f2f-baaa-c7336b9f661f`、品牌`bbdf46ba-0530-46b5-8920-0b0d6d809f8d`，
目录`https://www.natrol.com/collections/all-products`。

06:19:46Z启动首个新商品
`https://www.natrol.com/products/melatonin-sleep-support-strawberry-fast-dissolve-tablets-1mg`，
run `02192773-1ad1-425e-9ac1-fdb56396b2be`。继续原Codex/Ego采集流程，模型观察网站后
保存可复用方法；采集只保存原始HTML、完整图库及实际网站规格/页面关联，业务数据仍由
后续处理。检查实际材料分路和结果，再选另一新商品验证方法复用。未增加或运行单元测试。

Server一证据根`manual-releases/dtc-native-20261002/`：
`crosssite183-natrol-preflight.json`、`crosssite183-natrol1-{intent,start}.json`。

## 首项结果及148复现

06:25:37Z终态Review `CHANNEL.LABEL_NO_SOURCE`，没有商品/enrichment结果。
原图库实际上只有1张瓶正面，平台images与页面swiper的1/1一致；保存的700px版本是
页面真实picture地址，不按文件名里的Label推断它含Facts。

采集方法`644bbf7ffaebf5f9a2ae23410dc6504cc153845153a992e84f715f98269f419d`
只选择`main > section:not(.more-for-you-section)`。完整699342字节页面在main内另有
一层DIV包裹`x-data="sliderNutritionFacts"`区块，含营养表及Other Ingredients；交给后续的
157656字节productHtml完全缺失。不是网站没有资料，也不是OCR错读。记录回原本负责
商品区域外板块的CRAWLV3-148，不重复建相同缺陷票。

本次方法曾在收割前因局部变量名错误中断，模型修正后在同一次采集完成；没有删除
checkpoint或覆盖已完成原件。35份原件/2959178字节06:27:02Z全量R2回读通过；
06:26:55Z两个Workflow、2许可/6执行停止审计invalid=[]，held=[]。

最小修正为采集指导明确HTML容器不等于商品材料边界：首次建立或实际修正方法时，
观察完整页面的本商品板块，将旧选择范围遗漏的部分原样纳入productHtml，只局部修已有方法。
没有通用关键词采集、业务解析、逐字段证明或采后复核。下一新Natrol商品验证修正，
原失败及方法原件保留，不重抓该商品。

06:28:51Z Mini对原件的DOM结构核验进一步确认：营养区块insideMain=true，父为
`DIV#shopify-section-template--23280535699676__1653488126194a8271`，3161字节；
旧productHtml中没有该区块。此前将其粗述为main之外不准确，已在148评论与用户沟通
中更正。区块保留Melatonin1mg、14项辅料、用法与警示。证据Server二
`manual-releases/crosssite183-natrol1-region-proof.json`。

修复`556ac921bba47440566938302dacdc8aa8c5b89c`已main提交/push，完整静态/类型检查
通过，无单元测试。仅采集提示和引用文档变化；06:29:49Z经Server二Git fresh clone、
锁定依赖、构建及唯一browser-worker切换就绪，Server一保持4c178eca。

06:30:11Z启动第二个、此前未尝试的官网目录商品
`https://www.natrol.com/products/melatonin-sleep-support-strawberry-fast-dissolve-tablets-3mg`，
run `ae2f72a3-21e4-422e-8cbb-a5d5ede2f9be`。保持两DTC队列paused，先验证旧方法局部
补齐区域及原下游；与1mg是两个真实商品URL，不冒称同一产品内的两个网站variant。

第二项确认加载原方法`644bbf7f…`，不是从头建立方法。06:35Z采集会话通过网站原始
平台规格发现3mg商品自身包含90ct/150ct：ID43004268675292/SKU6076.957/10.49USD，
ID43004492579036/SKU7281.957/14.49USD。正在观察这两个规格材料关联；这份清单还不
代表逐规格采集或下游已完成。

## 第二项终态：指导修正未奏效

06:39:40Z两规格均Review `CHANNEL.LABEL_NO_SOURCE`，root为
`DTC.VARIANTS_INCOMPLETE`（0完成/2Review）。仍漏同一营养区块，不能将556ac921
当成有效修复。新方法`d46cf623fb72c208d56fd8fdb75e8a84df5e6cc2278f360af2063a9caccfce6c`
还以productHtml原始字符串不等或图库URL不等判independent，用URL query兜底selectedVariantId。
实际网页无确认的规格选择控件，两规格页面同一150ct瓶正面图；这个independent结论没有
资料归属依据。记录155及新增206，未把此例计入独立资料正例。

49份原件/6116771字节06:42:06Z全量R2回读通过；06:41:58Z五个Workflow、3许可/7执行
停止审计invalid=[]。Server一证据`crosssite183-natrol3mg-{workflows,stop-proof}.json`、
`product-ae2f72a3-21e4-422e-8cbb-a5d5ede2f9be-r2-proof.json`。旧Review与原件保留。

206修正：加载缓存方法时，从版本化的`methods/product-feedback.json`携带严格匹配origin
及方法SHA的已确认缺陷到本任务。Codex先读反馈，局部修正对应步骤并保留其余方法；
工作目录反馈随原采集证据归档，新方法SHA不自动继承旧缺陷。不加业务解析、关键词
规则或采后复核。缓存samples只说明原件已归档，不再误称它证明下游正确。
