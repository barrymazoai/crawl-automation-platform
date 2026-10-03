# DTC 多品牌分析顺序与超限结果

CRAWLV3-191，关联147/151。沿用用户授权的Nutriessential样本；不增加品牌上限，不启动整站商品批次。

## 真实问题

8745dba上的分析`0a37f48e-7771-4ffb-a256-1f8cd406d81d`于12:26Z开始，模型12:31:23Z
结束。它只验证Metagenics目录及代表商品，又查看成分区后主动needs_review，理由为其余品牌
尚未验证，limitsReached=false。没有先枚举品牌或检查上限，也没有继续验证其余品牌。
证据索引另有htmlPath:null，以及未访问的/pages/brands被写成discoveredFrom.page。
失败输出未被应用，不创建品牌扫描或商品采集任务。

只读核对原件首页Brands导航，实际存在179个不同的collection候选（不是179个已验证品牌），
超过现行50品牌上限。本轮应先报告这个范围，而非完成首品牌后泛泛结束。

29份R2原件/4,813,218字节于12:34Z全部回读大小和SHA-256通过。
Codex12:31:23.110Z、页面12:31:23.467Z、round12:31:23.605Z停止，host CLI也有停止证明；
许可于12:31:54.570Z释放。原件和失败状态保留。

Server二目录：`browser-model/dtc-native/1ad8666370709b5c142097cbf7dd9d54c605192f239ba9fb7ce91760762587c5`。
Server一证据：`manual-releases/dtc-native-20261002/multibrand147-nutriessential-*`及
`analysis-0a37f48e-7771-4ffb-a256-1f8cd406d81d-stop-proof.json`；R2校验文件沿原工具命名为
`catalog-0a37f48e-7771-4ffb-a256-1f8cd406d81d-r2-proof.json`，内部archiveKey为实际analysis路径。

## 修正

站点分析按模型实际观察的品牌区域先形成候选清单，再检查数量/页面/域名/时间上限。
超限明确报告候选数和剩余范围；未超限逐品牌完成目录及代表商品身份验证，待办本身不构成
停止理由。代表商品不执行成分/FAQ/全图库预检。证据索引只引用真实保存的HTML/截图对，
来源页用实际看到链接的页面，观察商品数与页面声明总数区分。

原runner对所有needs_review一律抛出采集异常，导致有有效超限分析也只显示通用failed。
修正仅允许analysis模式的needs_review进入原有归档与完整分析校验，且analysis.json自身必须
明确needs-review；不会接受complete替代，也不会绕过原件校验或允许应用部分品牌。
其他采集模式和失败路径不变。

没有通用关键词提取器、站点专用分支、自动重试或单元测试。静态检查、Git部署和新Mini实测
结果另行追加；当前未宣称多品牌正例或整个DTC已验收。
