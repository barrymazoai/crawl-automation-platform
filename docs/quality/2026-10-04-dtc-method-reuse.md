# 同站方法复用实测

CRAWLV3-183/151。2026-10-04 00:42:05.710Z，原Solaray目录队列Tongkat Ali root
首次attempt0→1，run`fc02f046-693c-4a95-936c-ec50fd1b750f`，Server二ab3d62c。
1/1放行后立即drain，643queued/7历史Review保留。没有单元测试，没有旧Review重排。

宿主确实加载Magnesium Glycinate留存方法744c8c2d…，method-cache.json记录源样本。
Codex核对当前页面后只修改三处reason/notes，将旧120ct/240ct和具名控件说明移除；实际
导航、展开、控件→ID校验、网站规格及完整原图采集动作均未重写。实际执行版本38f63888…
与使用回执归档，当前仅证明这两个相同结构/共享图库商品的方法动作复用。

采集保存180ct（40595631177788、SKU X003KT6RIN、23.69）与60ct
（31717444943932、SKU076280544336、15.39），每规格页面/商品区域原样HTML、完整图库
并集3张原图。两个状态实际仍有同组3张图，顺序变化；没有按文件名/顺序分配Facts。
采集fields只有title/brand/currency/images，没有业务内容解析或强制采后复核。
49份原件共13,598,580字节，00:48:12.874Z全量R2大小/SHA回读通过。

脚本当前仍按共享图库模式写mixed，不能视为独立资料/无选择器商品都适用；该类实际
差异仍须交模型局部适配。本次下游规格结果与全树停止证明待追加。
元数据price_currency遗漏另记193并修复；本项运行旧ab3d62c，不冒充已测试该补丁。

00:48:46.675Z终态Review，2个规格均DTC.VARIANT_EVIDENCE，无Label/Enrichment子流程。
逐图结果为两个明确包装正面other，一张可读Facts unresolved；直接视觉核验原件可见
Serving Size 1 VegCap、Tongkat Ali root 400mg和辅料，但没有每瓶份数或包装数量。
现有材料没有明确60ct/180ct归属或共用声明，不能凭文件名包含某个SKU分配。这属于当前
旧规则下的资料归属不足，不称采集失败；原Review保留、不自动重试。

用户随后明确接受第三方官网的资料局限：同一产品只有一张可用Facts时允许规格共用，
不要求包装数量或网站共用声明。上述旧Review是历史结果，不能继续用其旧限制阻挡后续
任务。新策略与留存材料派生验证另见[单Facts处理](2026-10-04-dtc-single-facts.md)。

8个许可全部释放；11个已登记执行均先停止后释放。未登记提供商执行的一项为联合选择
步骤因已有unresolved直接返回[]，并未调用模型。任务页00:45:09.933Z确认不存在，round
00:45:10.082Z结束。终态队列paused/643queued/8Review、held=[]。
Server一`reuse183-tongkat-{workflows,gallery-decisions,stop-proof}.json`和该run的
`product-<runId>-r2-proof.json`记录细节。183仍In Progress：已验证同模式动作复用，
独立资料/单规格/控件差异的适配仍待实测。

## 第三个商品直接复用成功

2026-10-04 01:15:45Z，Solaray D3+K2 首次 run
`d3106fb9-4f17-41e1-b756-604c7fed39a4` 在 `1d15959` 开始；1/1 放行后立即 drain。
缓存与实际执行的 site-method.mjs SHA 均为
`38f6388811031044ad72cbc3ba272dd49c06749defdb8650424f5bf44747ad66`，逐字节一致，
没有为这个商品重写采集方法。网站选项键由 VegCaps 变为 Caps 也未导致整项拒绝。

保留 60ct（32062974099516 / 076280385847 / 18.39 USD）与
120ct（32062974132284 / 076280574456 / 31.99 USD）、各自原始 HTML 与三张原图。
capture fields 仍只有 title/brand/currency/images，没有业务字段提取。
49 份原件共 8,552,674 字节于 01:22:28Z 全量 R2 大小/SHA 校验通过。

此产品同样只提供一张 Facts；新共用策略使两规格都进入原后续流程。
01:24:55Z 父任务 collected 2/2，两个 enrichment 均 registered、reused=false，网站数量
分别保持 60 / 120；币种也通过真实新采集保留。目视核对留存图：1 VegCap，D3 125mcg625%、
Calcium110mg8%、Phosphorus85mg7%、K2 50mcg未设DV、六项辅料，与两份保存结果一致。
没印的 servingsPerContainer 仍 null，不阻断。

八个 Workflow 全部完成，14 个许可、17 个已登记执行均有先停止后释放证明；
01:26:48Z 审计 invalid=[]。Server 一证据：`strategy151-d3-{start,workflows,products,stop-proof}.json`
及 `product-d3106fb9-4f17-41e1-b756-604c7fed39a4-r2-proof.json`。
该结果验证同一站点方法的直接复用及唯一 Facts 共用全链路，仍不代表全部网站已验收。

01:26:01Z 接续 Nature’s Truth 的新单品
`https://naturestruth.com/products/melatonin-12-mg-natural-berry-nt7393`，run
`d45aa3a2-7422-4fb0-ab2d-c5728a9ddbdb`。链接来自已有站点分析 800b3ac9… 的真实代表页，
该品牌此前没有单品 run；不重扫旧失败目录、不重试旧 Review。

首采完成了单规格、完整页面和原样商品区域 HTML、七张图库材料。固定收割 complete，
但模型在最终答复仅因实际图片为 375×500 返回 gallery_saved_rendered_resolution，
宿主因此于 01:32:16Z 留下 DTC.CAPTURE_REVIEW，未启动任何下游。55 原件共 3,592,283
字节 R2 全量回读校验通过；原任务 1 许可、4 执行先停止后释放，invalid=[]。
这个阶段的规格 ID 读取曾在 runHarvest 前局部修正，不是失败后重抓或另开业务重试。

随后用已归档材料首次执行原下游：`dtc-retained-single-6a4f3139-d572-49f7-8a70-da91b78be149`，
01:39:54Z collected、enrichment registered/reused=false。网站规格 44515937190075、
SKU NT7393、19.49 USD 保留。实际结果为 Melatonin 12mg 一行、十项辅料、
Serving Size 1 Fast Dissolve Tablet、Servings Per Container 120；未重抓页面或图片。
四个派生/范围 Workflow 完成，五许可、五已登记执行先停止后释放，01:41:15Z invalid=[]。
原 Review 保持原样。证据：Server 二 `manual-releases/nature184-retained-1d15959`；
Server 一 `strategy151-nature-retained-{workflows,product,stop-proof}.json`。

CRAWLV3-195 记录这个不必要的采集终止：修正通用采集指令，收割前使用已观察原图入口，
完整收割后尺寸偏小/可选项缺失记录 notes，由原下游判断内容可用性。保留真正身份冲突、
必需材料缺失及用户控制边界；不按 reason 字符串放行、不全局覆盖 needs_review，
不增加 OCR 或采后复核。静态检查通过；新首采验证待追加，不能把本次留存成功冒充新指令验证。
