# 目录之后的商品链路续验

关联 CRAWLV3-183/184/155/151。用户确认继续下一阶段；本轮仍在Mini直接执行，
不增加单元测试。保留网站原始HTML、完整图库与规格关联，业务字段由既有后续处理读取。

开工核对：Natrol46项准确脚本复用和HMW6项目录已通过；Solaray D3+K2已有两规格
唯一Facts共用及下游成功正例。当前剩余覆盖包括单规格/独立材料的适配、新商品与跨站
结果正确性；不把可选缺项当硬失败，也不把collected状态代替原图核对。

04:08:29Z两个DTC队列paused、held=[]，商品queued688。浏览器实际资源
server2-ego-space-6、模型与OCR健康。执行版本：Server二a6e9851，Server一1d15959。

04:10:05Z原队列Zinc Copper项4893e414e81197c80fbf809354b616721d0ba2a71aaf7f42b31855a7b10c446e
首次queue attempt0→1，run dc6f36ac-d9cf-4050-81c3-9358f12f95c8，URL
https://solaray.com/products/zinc-copper。该URL曾有旧版本独立验证，本次不重排这些历史记录。
按原队列1/1启动后立即drain(graceSeconds=0)，仅此项执行，余687项保持未启动。
目的：已存多规格方法对当前单规格的适配、材料直交、下游实际结果与精确清理。
Server一e2e183-zinc-{start-intent,start,latest}.json保存入口与状态；结果待追加。

Zinc Copper于04:13:39Z正常collected，既有配方和enrichment均reused=true，没有再OCR。
原网站单规格32703815778364、SKU076280471052、100ct、11.89USD保留；materials.variants=[]，
没有为单规格执行混合图库前置流程。模型只为旧方法增加variants.length>1条件与对应notes，
其余导航/展开/图库动作不改；实际方法fd8aee79362b0996e126307faee9b96c5eeeb7cf8455104d29a2fd0e10dd2d17。

原图实际打开核对：1 VegCap，Iodine53mcg35%、Zinc50mg455%、Copper2mg222%、
Pumpkin10mg未设DV；四项辅料与保存结果相同。没有印每瓶份数，保持null。
本次Facts SHA fb4d15753485a989a47e989fc22f98ebc3c4905cc67141ef97266d2716776318
与被复用的旧Vision来源完全相同。是合法原结果复用，不声称新模型解析。
38份原件/7,132,927字节04:14:26Z全量R2回读通过；04:15:36Z两个Workflow、
两许可/五执行停止审计invalid=[]。证据e2e183-zinc-{workflows,product,stop-proof}.json。

04:16:09Z下一原队列项Papaya Enzyme首次attempt0→1，run
1785e063-ebbb-487e-940a-76fc943c4180，URL https://solaray.com/products/papaya-enzyme。
原item3280a988…，先前无该URL产品run。保持1/1并随即drain(graceSeconds=0)，
余686项未启动、旧8Review不动。继续验证上一项保存的方法在新商品上的实际适用性。

04:17:56Z已核实Papaya加载上一项保存的fd8aee79…准确方法，采前实际观察到180ct与90ct
两个radio规格，以及两组Facts/背标原图。固定收割正在运行。本例将验证新单规格分支
没有破坏原多规格方法，以及两张不同Facts的归属，不能套用唯一Facts共用规则。

Papaya原采集于04:20前完成，实际method-use与源码SHA均为fd8aee79，未修改脚本。
保存4/4原图库，两规格分别为180ct/SKU076280462128/12.69USD、
90ct/SKU076280265354/8.99USD。两份规格HTML及共享图库保留，采集未解析业务字段。
04:21:04Z两规格最终Review（No Facts image assigned），没有开始Label/Enrichment。
52份原件/17,725,068字节于04:22:51Z全部R2回读通过；10许可/13执行停止审计invalid=[]。

## 204：两张等价Facts未进入已有联合比较

逐图核实后修正采前“不同Facts”的表述：两张原图字节、排版和换行不同，**内容相同**。
两图都是1 Chewable Tablet；Total Carbohydrate 0g <1%、Total Sugars 0g、
Includes 0g Added Sugars <1%、Papain(100,000 FCC PU)2mg、Amylase(250 FCC)50mg、
Protease(50 FCC HUT)10mg、Bromelain(12 MCU)7mg、Papaya(fruit)10mg。
两图八项辅料相同，DV脚注含义相同而非逐字相同，都没有包装数量或servings per container。
原图为capture/evidence/img/{b7cb082d5ef99501,67af95bbaeefd098}.png。

单图模型正确返回facts/scope-unassigned；代码只接受唯一Facts或已明确归属的图片，
因此两个清楚的未归属Facts从未进入已有联合比较。此共性缺口记录CRAWLV3-204。
修复仅增加候选路径：全部Facts均清楚且均未归属时，交原联合比较模型审阅全部原图，
确认每行/用量/单位/DV/每份量/每瓶份数/辅料/脚注等价才选代表图供规格共用。
排版差异和两图都缺同一个可选值不阻塞；真实差异、不可读或比较不确定仍Review。
不是OCR文本、文件名或品牌专用匹配；不改原采集和共享业务解析；比较缓存升级v2，
精确task/variant/candidate所有权检查保留。接下来用Mini留存原件做派生验收，
原Review不改、原采集不重跑，成功后首次进入尚未执行的Papaya下游。

8dfb01f已提交main并push，pnpm check静态/22包类型检查通过，无单元测试。
Server一按Git fresh clone/锁定安装/build完成，只通过既有JobService更新
pipeline-worker与label-model-worker，其他5作业unchanged且ready。部署前六渠道均无
running/ready、非DTC无queued、held=[]；其他队列模式保持原样。
自动审批拒绝了暂停非DTC队列和不必要的Server二部署，两项均未执行；实际采用上述
两个必需空闲执行器的定点更新，Server二采集版本不动。

留存派生run009f29a0-7e97-45e2-87fc-b3f84773a255，52原件再次校验通过，
gallery workflow dtc-gallery-accept-009f29a0-7e97-45e2-87fc-b3f84773a255开始。
工具为既有verify-dtc-retained-mixed.mts，输出Server二manual-releases/facts204-papaya-retained。

04:28:56Z不同份数反例通过：在Server一新代码直接执行Magnesium原真实task/decisions/
selection的finishGallery，两个规格最终handoff与此前成功结果逐字段相同，仍分别保留
各自30/60份标签，未被新等价候选路径合并。没有模型调用、没有远端写入；
这是既有归属隔离的回归，不冒称新增一次模型对差异标签的判断。
证据Server一facts204-magnesium-{workflows,proof}.json。

首轮派生于04:30:26Z仍Review；联合比较已执行，模型确认配方/剂量/辅料一致，却将
脚注“Percent Daily Values are based…”与“Percent Daily Value based…”的同义语法差异
判为不等价。原图确有该文字差异；不能声称逐字相同。04:31:54Z本轮9许可/10执行均
先停后释放、invalid=[]，没有开始下游。204继续修复：明确按营养/配方含义等价，
允许不改变含义的语法/标点/同义措辞；数字、成分身份、人群、条件或限定含义变化仍阻塞。
比较缓存升v3，旧模型回答和派生Review不覆盖。下一次仅为新修订的留存材料验证。

页面清理证据另核对：Zinc目标32A0D95F8027D7D0E13DF0E7F560E841于04:12:41Z确认不存在；
Papaya目标09C4B6A61587B5FA2B9D2D37A991798B于04:18:12Z确认不存在，均在浏览器许可释放前。
原Space6基线2B17A86DBCA4F3AC717200EF04BD6BA4保留，派生验收没有浏览器阶段。
