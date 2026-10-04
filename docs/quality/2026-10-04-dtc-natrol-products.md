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
只选择`main > section:not(.more-for-you-section)`。但完整699342字节页面在main之外
存在`x-data="sliderNutritionFacts"`区块，含营养表及Other Ingredients；交给后续的
157656字节productHtml完全缺失。不是网站没有资料，也不是OCR错读。记录回原本负责
商品区域外板块的CRAWLV3-148，不重复建相同缺陷票。

本次方法曾在收割前因局部变量名错误中断，模型修正后在同一次采集完成；没有删除
checkpoint或覆盖已完成原件。35份原件/2959178字节06:27:02Z全量R2回读通过；
06:26:55Z两个Workflow、2许可/6执行停止审计invalid=[]，held=[]。

最小修正为采集指导明确HTML容器不等于商品材料边界：首次建立或实际修正方法时，
观察完整页面的本商品板块，将外置部分原样纳入productHtml，只局部修已有方法。
没有通用关键词采集、业务解析、逐字段证明或采后复核。下一新Natrol商品验证修正，
原失败及方法原件保留，不重抓该商品。
