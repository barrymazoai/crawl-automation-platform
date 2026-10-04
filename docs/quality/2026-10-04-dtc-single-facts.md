# DTC 只有一张 Facts 时继续处理

关联 CRAWLV3-151 / 155 / 184。用户明确：第三方官网不具备大型购物平台的标准化
资料，不应因缺少次要信息长期阻塞采集。按实际结果影响处理差异，合理兼容后继续覆盖
其他商品/网站，实际错配风险或关键材料缺失才隔离对应项。

原 Tongkat run `fc02f046-693c-4a95-936c-ec50fd1b750f` 已采集两个网站规格
180ct / 60ct、三张原图（两张包装正面、一张清楚的 Supplement Facts）。唯一 Facts
没有标包装数量或 servings per container，旧归属判断将其视为 unresolved，导致两规格
进入 Review。完整 49 份原件已保留并校验，浏览器和资源均已清理。

本次共性修改：模型区分清楚但未绑定规格的 Facts 与不可读的潜在 Facts。
汇总完整图库后仅一张 Facts 则允许所有有效网站规格共用；记录
`dtc-single-facts/1` 和原图/决策引用，明确是用户接受的策略，而非声称网站已证明共用。
各规格的 ID、SKU、价格、数量和原始 HTML 保留。多张不同 Facts 仍沿用原归属流程。
没有清楚 Facts 或还有不可读潜在 Facts 时不伪造内容。

采集仍只保存材料，未增加强制采后复核，未修改共享 Facts 业务解析。
scope 缓存使用 v2，防止将旧 unresolved 当作新策略已经执行；旧结果不改。
已有留存材料验证工具支持指定原 run 和 materials 合约，在 Mini 直接执行派生下游，
不打开网站、不重跑原失败队列项、不覆盖原 Review。无单元测试。

## Mini 直接验证结果

代码 `1d15959d8d64c4360ab033ec9487dc0720e1feb9` 已经 Git fresh clone、锁定安装与构建
部署两台 Mini；必要静态/类型检查通过。部署期间临时暂停的其他五个空闲渠道已于
01:07:44Z 恢复原状态。没有启动那些渠道的新采集。

Tongkat 派生 run `0cc5af3d-9297-4c21-b271-4b5609ecffd9` 使用原 49 份材料，
13,598,580 字节逐份校验一致。01:10:07Z 共用判断完成，两规格均 ready，引用同一
`single-facts-policy.json`，各自网站规格、SKU、价格不变。

- 60ct：01:14:25Z 完成收录和 enrichment（本次新结果，reused=false）。Facts 为
  1 VegCap、Tongkat Ali root 400mg、一行配方与五项辅料；网站 count=60。标签未印的
  servings per container 仍为 null，没有因此阻断。operation
  `label-0a3ba0c6ab56f9d097bbff1d0a38eba6c8693c74d9af3db5674cb363bf02805b`。
- 180ct：进入原有 Facts 处理后 Review `VISION.LABEL_INGREDIENTS_INCOMPLETE`。
  原始模型回答已完整抄出相同五项辅料，却因“未证明整个实体标签可见”将完整性标为 false。
  同图 60ct 成功结果的 wholeLabelVisible 也是 false，说明当前实现并非硬性要求整瓶图片，
  是模型对 present 与 none_printed 条件的判断不稳定。另记 CRAWLV3-194；保留原回答及
  Review，不自动重试，不将本轮写成 2/2 全链路成功。

01:16:58Z 核对本轮六个 Workflow 已结束、12 个许可已释放、11 个已登记执行均有先停止
后释放证明。验证工具已退出，没有浏览器阶段。

另用已完成的 Magnesium 两种不同 Facts 原件和原联合选择结果，直接执行新版完整
finishGallery；01:11:40Z 两规格结果与旧成功结果完全一致。仅本地派生产物，无模型调用或
R2 改写。初次临时比对误把选择前候选集与选择后单图比较，未作业务重试；改为完整收尾函数
后确认一致。

证据：Server 二 `manual-releases/single-facts184-1d15959/`；Server 一
`manual-releases/dtc-native-20261002/single-facts184-{workflows,product,stop-proof}.json`、
`single-facts-multiple-panels-proof.json`、`single-facts-{label-review,vision-response}.json`。

按用户策略，已于 01:15:45Z 继续下一项 D3+K2 首次采集（run
`d3106fb9-4f17-41e1-b756-604c7fed39a4`），1/1 放行后立即暂停新投送。
当前共用交接规则已实测，194 的共性提示歧义待集中处理，DTC 总验收仍在继续。

D3+K2 已于 01:24:55Z collected 2/2，两规格共用唯一 Facts、各自网站数量与 USD 价格
保留，原图四行配方/六项辅料核对一致、两个新 enrichment 已登记。该新商品从采集到
最终处理全链路通过；方法逐字节复用、49 份原件校验及 14 许可/17 执行清理证明详见
[同站方法复用](2026-10-04-dtc-method-reuse.md)。随后继续 Nature’s Truth 跨站单品。
