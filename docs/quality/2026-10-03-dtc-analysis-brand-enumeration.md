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

## 修复后实站验收

`1c3e1427c16e344b1226ebb6634b346bd3ac6ada`通过完整pnpm check（22项类型任务），
main推送后在Server二fresh Git clone、locked install/build，12:39:10.666Z部署ready。
新分析`c924ad51-85bd-4956-b7a6-c53c85c0fc4d`于12:39:46Z开始，12:43Z结束。

模型先访问实际Brands索引，保存224个去重目录候选，明确超过50上限、未进入代表商品验证。
这是品牌索引范围，旧179来自首页菜单，不能把差值解释为同范围丢失或新增品牌；两者均是
候选数而非认证品牌数。新API状态needs-review，具体原因和capture.json引用完整。
对本分析执行apply(enqueue=true)返回HTTP400/SITE_ANALYSIS.NOT_APPLICABLE，tasks为空，
品牌队列paused/queued0/running0/cleanupPending0。没有把部分分析应用到业务队列。

23份R2原件/2,698,018字节全部回读大小/SHA-256通过；Codex12:42:37.438Z、
任务页12:42:37.847Z、round12:42:38.007Z及host CLI停止证明均早于12:43:04.266Z许可释放。
Server二任务目录末级`bc2011a76dd6049dc277542f69ca2dbfbdc9788dc6988933583422630422fe32`。
Server一`analysis191-*`保存请求/结果/不可应用证明，R2校验仍沿catalog-<analysisId>-r2-proof
命名。191交Review；上限内真实多品牌完整拆分正例仍归147，不宣称本项超限测试覆盖该路径。

12:45:18.874Z接续现有Solaray队列首项Magnesium Glycinate，run
`a1c175bc-b157-4762-bc17-a89cda96ca62`，attempt0→1，1/1开始后立即drain且无强制超时。
644项继续等待，6个旧Review不变；后续材料/混合变体结果另记183/184。
