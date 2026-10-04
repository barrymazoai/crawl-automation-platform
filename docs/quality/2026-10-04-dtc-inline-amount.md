# Facts 行内数量验证

关联CRAWLV3-205/184/151。用户继续下一步：修复Papaya180ct把原图明确印出的
“Includes 0 g Added Sugars”误判数量不可读。原失败label-b0a64ca6…及同图90ct成功
label-e0c4139c…保留；原图SHA52bdb8069e25635ac59fb48c2722fed48df63287b222886ba695d743fb2f8782。

根因是通用视觉提示仅规定“visible amounts → printed”，未明确同一行文字内的数量
无需独立数量列。修改label-vision/8：明确行内数量、单位、零值也是printed，
引用原行证据；不把%DV、标识符、别行、营销或等效量当作该行剂量。真正缺失/模糊仍
保留原校验，不添加产品/关键词回填、不改采集。提示及完整模型指纹随版本更新。

没有新增或运行单元测试。只同步已有协议快照中的两个提示hash与policy版本，防止
旧版本快照与明确升级矛盾；验收使用必要静态/构建及Mini真实留存原件、原处理流程。
05:03Z开工前held=[]，DTC paused/queued686，其他五渠道无running/ready/queued。

## 修复部署与负例

- 代码 `4c178eca5108e8ccc19e72864febc25efe06c9dd`，`pnpm check`通过；两台Mini均从origin main新clone、锁定依赖安装并构建Worker。
- 新视觉指纹 `6e6a494d65515220014c2918308ea8ed7519af7571bb7aad692a3b2db5ced4e7`。Server一同步plan/label，Server二同步plan；私有配置原件单独备份，没有提交凭据。
- Server一只更新pipeline-worker、label-model-worker、browser-worker；API、label、OCR、resources进程保留。05:08:44Z再次确认held为空、六渠道没有running/ready，未改变任何渠道队列模式。
- Server二维护调用最初遗漏MachineConfigSchema默认值，args未定义导致部署在写ecosystem/停止进程前退出。配置已更新但无新任务发出；随后用既有schema补全默认值，记录独立恢复intent后继续部署。不是产品业务重试。
- 05:09:50Z，在新构建上解码留存旧错误回答：仍为Review，代码`LABEL.AMOUNT_STATE_CONFLICT / LABEL.AMOUNT_UNREADABLE / LABEL.EVIDENCE_UNCERTAIN`。未调用模型、未关闭校验。Server一证据`facts205-old-answer-validation.json`。

证据根：Server一`manual-releases/dtc-native-20261002/`；Server二`manual-releases/facts205-*`。

## 留存材料直接验证

Server二`tools/verify-dtc-retained-mixed.mts`使用原run
`1785e063-ebbb-487e-940a-76fc943c4180`的52份原件，共17,725,068字节；
本地/R2大小和SHA全部一致。独立派生run `dd8b6646-9ef4-417a-8ff7-dbe82ce64009`，
输出`manual-releases/facts205-papaya-inline`，没有网页采集或旧任务重排。

两规格图库归属均ready，新source plan均携带`6e6a494d…`：180ct保持
ID41760471351356、SKU076280462128、12.69USD；90ct保持ID41760471384124、
SKU076280265354、8.99USD。独立180ct下游
`dtc-variant-accept-183efeb0-12da-4940-b0bf-60999f7e75b4`。

## 结果与收尾

- 05:13:01Z图库流程完成，两规格ready。
- 180ct在05:14:53Z完成新的Label解析，05:15:07Z新的enrichment registered，`reused=false`。商品操作`label-079b0746bfaa0747ed767b4eae9f615161426e9b1b8022290fce478160af1818`；enrichment `258a02b39dcc4b76de8f5c9247cd799b28e21c3cf093e44f75c969a75c4b9a27`，count180。
- 新原始模型回答中“Includes 0 g Added Sugars”原文保留，amount=`0 g`、amountStatus=`printed`，证据引用该原行。其余七行均与原图一致：Total Carbohydrate/Sugars各0g；Papain2mg、Amylase50mg、Protease10mg、Bromelain7mg、Papaya10mg。100,000 FCC PU等酶活性数字保留在名称，没有被误用为剂量。
- 每份量`1 Chewable Tablet`、每瓶份数null；完整辅料原文保留7条，`Silica and Stevia (leaf extract).`仍为同条，不声称已拆成8项。wholeLabelVisible=false且辅料确实已显示，正常通过，未扩大到修复194的所有情况。
- 90ct在05:15:14Z完成，合法复用原`label-e0c4139c…`和enrichment `408e8aea…`，count90，`reusedFormula=true/reused=true`。本次没有再对90ct调用配方模型。180ct新enrichment保留了原图明示的天然菠萝风味，90ct历史enrichment的可选flavor仍null；历史结果未覆盖，不冒称两个enrichment字段完全一致。
- 05:16:20Z选中原图、原模型response、assembly全部R2回读大小/SHA一致。选图仍是原SHA`52bdb806…`；新模型配置指纹确认为`6e6a494d…`。原回答路径`v3/vision/chl-d96a1ed9b1c8687557a2459e8e9909857b38f19eda72ddc3090c4d5d3b479d1f/response.json`；assembly SHA`2f1bb3044356f86cf9894111607ea99226e268275cc4302df1b569abd5554794`。enrichment原件亦已回读并留hash。
- 05:16:13Z共6个Workflow均COMPLETED，13许可、13已登记执行有停止早于释放的证明，invalid=[]。本次无浏览器阶段，原采集页此前已核验关闭；05:16:42Z全局held=[]，DTC仍paused/686queued/9历史Review/2completed/46following，其他五渠道模式和计数不变。

Server一证据：`facts205-papaya-{workflows,stop-proof}.json`、
`facts205-papaya180-{product,response,proof,enrichment}.json`、
`facts205-final-state.json`、`facts205-old-answer-validation.json`。
Server二证据：`manual-releases/facts205-papaya-inline/{prepared,gallery-result,results}.json`
及逐规格intent/result。部署配置备份与回执分别保存在两机`facts205-*`记录中。

205修复交Review；184/151继续In Progress。此轮通过的是Papaya留存材料两规格处理与
行内明确数量的真实新模型正例，不是重新采集成功或全部DTC验收完成。原Papaya队列
Review和旧错误模型回答保持不变。下一覆盖仍是跨站商品、独立材料/不同配方规格和
完整品牌/规模；194/197等已记录问题保留，未在本轮顺带宣称解决。
