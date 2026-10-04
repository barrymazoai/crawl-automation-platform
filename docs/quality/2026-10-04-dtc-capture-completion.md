# DTC 完整材料交接与跨站实测

关联 CRAWLV3-195 / 183 / 184 / 151。

Nature’s Truth Melatonin 首采 `d45aa3a2-7422-4fb0-ab2d-c5728a9ddbdb` 的固定
runHarvest 已 complete，模型却仅因图片实际为 375×500 返回 needs_review，导致宿主
01:32:16Z 在交接前停止。原 Review 与 55 份、3,592,283 字节的归档原件均保留。

01:39:54Z，同一材料首次进入已有下游并 collected/enrichment registered；未请求新页面
或图片。直接目视原图与保存结果一致：1 Fast Dissolve Tablet、120 servings、Melatonin
12mg、10 项辅料。原始任务及派生任务所有许可均有先停止后释放证明。完整引用见
[实测记录](2026-10-04-dtc-method-reuse.md)。

修复 `41e4a5b06705f352ea89aa62f207469eb31c648a` 只调整通用模型采集指令和材料合约：

- 收割前固定网站已观察的原图/放大图入口，不凭空拼大图 URL。
- 完整收割后的像素尺寸或可选字段局限记 notes，由既有下游判断内容可用性。
- 实际身份冲突、必需材料未保存、收割失败及用户控制边界仍停止。

没有按 reason 字符串白名单放行、全局忽略 needs_review、添加 OCR/采后复核或修改原下游。
`pnpm check` 与提交/推送检查通过；没有新增或运行单元测试。
01:43:48Z，经 origin/main fresh clone、locked install/build，只部署 Server 二 browser-worker
并 verified ready；Server 一和其他渠道未切换。日志 `manual-releases/capture195-deploy.log`。

01:44:15Z 新商品 Ashwagandha Gummies 首次 run
`b5d2ad49-6337-425d-8d0e-a06523c8df9e`，URL 来自此前 800b3ac9… 分析归档目录的实际商品卡片，
没有旧采集记录。模型观察提到 7 个商品媒体有实际 1024px 放大图入口，网站仅默认商品规格，
订阅 radio 是销售计划、不是产品 variant。01:48:45Z 观察到原采集 complete、7 图、
variant 43508362608827。01:51:38Z 正常父流程 collected、Label collected、enrichment
registered/reused=false，未经人工留存派生绕行；网站 NT18131A / 16.99 USD 保留。
01:52:54Z 三个 Workflow、六许可、十已登记执行全部先停止后释放，invalid=[]。
195 的采集交接修复已交 Review，但下述数据内容错误意味着本商品正确性未通过验收。

实际原件核对发现仍保存 375×500 URL/图片，而非模型描述的 1024px。site-method 没读
data-zoom，仅仅读 anchor/srcset/currentSrc/src；下载器忠实保存其传入地址。这项方法来源
不一致另记 CRAWLV3-196（Backlog），不得宣称高分辨率采集已修好，也不因此停止可用材料
或重抓旧任务。52 份新原件共 4,108,081 字节已于 01:50:36Z 全量 R2 大小/SHA 校验通过。

直接目视下游使用的原图（SHA `5e1c1ba421e0713eaef4b2f8a82645986c306c0b800b84ab0605fc54c6cd6482`）
发现辅料首项印刷 **Glucose Syrup** 被保存为 **Gluten**。其余十项辅料和五行 Facts 对应；
1 Vegan Gummy / 60 servings 保留。此实质误读单独记录 CRAWLV3-197，不能用自动 collected
冒充内容准确，不机械替换词语或覆盖原记录，也不能未经验证归咎于图片尺寸。
证据 Server 一 `capture195-ashwagandha-{workflows,product,stop-proof}.json`；本次精确资料链
及结果完整保留，其他已授权测试继续。
