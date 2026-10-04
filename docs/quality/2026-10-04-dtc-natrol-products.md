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

`1bb21ef31716cf9a5ac38c4f50a51263c6291aaf`静态/类型检查与push检查通过，06:44:45Z
Server二经Git新克隆、锁定依赖、构建部署browser-worker，Server一下游保持4c178eca。
06:45:04Z首次启动Natrol目录中的`https://www.natrol.com/products/methyl-b12-1000mcg-capsules-60ct`，
run `b3ba1835-dd38-4ab6-8060-6ae3e26f92a3`，预检held=[]、实际资源健康、两DTC队列paused。
Server一证据`crosssite206-natrol-b12-{intent,start}.json`。验证具体缺陷反馈被读取、原始板块
保存范围及既有下游，尚未得到结果。

06:48:57Z对留存原件的DOM核验通过：初始页和唯一规格页各有一个2985字节的
`sliderNutritionFacts`板块，productHtml内各自与页面原件outerHTML相同（无重复）。
证据Server二`manual-releases/crosssite206-natrol-b12-region-proof.json`。
新方法`86b777b32801020856df0d2d421be68641fddcf2568baa934ad563a8a52eae00`
已补范围，原图库7张/网站唯一规格51047470563548/SKU8561/22.99USD完整保留。

206仍有未通过部分：实际代码依旧有URL query selectedVariantId兜底，notes写死七张图，
variantMaterials固定mixed。该商品仅一个variant，最终按原单商品LabelWorkflow处理，
没有混合归属子流程；不能拿它证明多规格判定已修好。针对86b777b3的新已确认反馈继续
精确绑定其SHA，要求去掉假选中状态及其依赖门槛、单规格复用原路径、notes不复制数量，
保持已正确的板块修正。旧原件保持不变，本任务没有采后重抓。

## B12终态与新的下游阻塞

06:55:58Z root/Label均结束，仍为`CHANNEL.LABEL_NO_SOURCE` Review
`chl-review-d9b303515631605566c64d8dcea3727a8b875c6822ab703ec607309c836e9222`，
未得到新商品/enrichment。此次不是148再次漏板块：page文档已包含新增原始区块，
文本模型抽到完整B12表和辅料，但将商品营销、标题、评论UI等逐段作为排除项。
原`label-text/5`规则不接受这类整页正文排除，06:58:43Z Mini直接复用原文/原回答
诊断仅有`LABEL.COVERAGE_UNCERTAIN`，没有`LABEL.EXTRACTION_INCOMPLETE`。

图库image-3的Vision结果已registered，formulaComplete/ingredientsComplete=true，
B12 1,000mcg、41,667%DV及完整辅料已读出；合并仍受文本覆盖失败阻断。
最终主错误却取了无关末图的`LABEL_NO_SOURCE`，不能据此解释成网页或图库没有Facts。
另有真实官网差异：正文为30 servings，Facts图为60；这是本商品原始资料差异，
不得在解释规则失败时一并隐藏。此下游问题单独记207，206仍未完整验收。

59份原件/4997388字节06:52:14Z全量R2回读通过；06:56:32Z两个Workflow、10许可/
14执行停止审计invalid=[]。Server一证据`crosssite206-natrol-b12-{workflows,stop-proof,
review,text-review,document,vision,text-diagnostic}.json`及`product-b3ba1835-dd38-4ab6-8060-6ae3e26f92a3-r2-proof.json`。
后续方法反馈`260ff3911d3750c61d1544cab6f67a98472cf26b`经完整push检查，06:53:55Z
Git新克隆/构建部署Server二；无其它channel变更，无单元测试，无旧业务重试。

207首个修正仅处理诊断：同等处理进度下，DTC优先展示实际失败，避免最后一张
没有标签的图片把文本覆盖失败冲掉。仍保持原完整性/来源冲突规则及原Review；
其它channel继续原排序。使用本run留存的真实ordered progress验证，不重跑业务。

诊断修复`9b8ed97fbd22b2041a978f7d1c16c9d542e539f8`已main提交/push并通过完整静态/
类型检查。新DTC标签任务显式带`source-failure-first/1`；旧任务和其它channel保留旧排序。
07:04:22Z在Server一新Git克隆构建中直接读取B12真实progress，新策略得到
page/`TEXT.LABEL_COVERAGE_UNCERTAIN`，旧策略仍为image-0/`CHANNEL.LABEL_NO_SOURCE`。
这是仅原件的新诊断策略验证，不是重跑业务，也不改写旧Review。

07:04:27Z只切换Server一pipeline-worker/label-worker并完成健康核验，其余5进程原定义
保留；Server二仍260ff39。Server一证据`crosssite207-natrol-b12-diagnostic-proof.json`、
`crosssite207-deploy.json`。07:04:41Z held=[]，DTC商品/站点队列均paused，零running/
cleanupPending。207的整页正文输入适配与来源差异处理尚未完成，206的方法修正亦未完整
验收，下一轮先解决这些已知缺口，不盲目扩大商品批量。三项Natrol没有完整成功结果。
