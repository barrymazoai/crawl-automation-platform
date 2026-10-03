# DTC 独立品牌任务与串行队列

CRAWLV3-147；整体验收151。用户确认：代码按站点分析、任务编排、品牌目录、单品材料采集分开，品牌任务排队慢慢运行。

## 11:20Z 串行实测结果

HMW `fe2efc4a-6db2-4653-97a7-1aa97596f832` 于10:52:06Z完成：完整目录6产品，全部为最近已处理项，新增/入队均0，旧Review未重试。30份R2原件5,087,920字节全部回读通过，四类停止证明后释放许可。暂停期间后两项保持queued；10:52:40Z手动恢复后，Solaray10:52:41Z启动。

Solaray11:00:07Z Review并完成清理，Nature’s Truth11:00:12Z自动领取，证明失败未堵住后项。Nature11:08:26Z Review并清理。两项原件均回读校验，停止证明早于释放；具体根因及187/188修复见[目录等待与映射记录](2026-10-03-dtc-catalog-wait-and-mapping.md)。11:19Z品牌队列running/concurrent1/queued0/running0/cleanupPending0；商品队列仍paused，held为空。

已验证串行、暂停/恢复、任务隔离及失败后清理；三个站点都是单品牌，不能代替同站多品牌正例。目录成功也不等于单品后续处理成功。

## 10:46Z 后续验收

通知问题已由 56cd201 修正并通过 Nature’s Truth 实站分析，见[185记录](2026-10-03-dtc-notification-prompts.md)。
分析 `800b3ac9-3c9e-480a-ba03-607f4e4e610e` completed，25份R2原件大小/hash通过、四项停止
证明后释放许可。确认一个真实品牌，不能称为多品牌正例。

应用新分析创建来源 `166bb8fb-9b63-4191-a2d1-762a1d3c18f7`、扫描
`4f1d38ba-b53e-4200-ad65-2a75413e7fee`。同 requestId 重交、不同 requestId 再次应用均返回
相同 scanId；与已有 HMW/Solaray 共三个独立排队任务，关联 API 正确。

预检产品队列 paused/readyLimit1/runningLimit1，仅6个历史Review，无持有许可或清理待办。
已手动启动品牌队列 running/concurrent1，验收跨站目录串行执行；产品队列继续暂停。
历史Review不重试，不把两个队列的暂停状态混为一谈。实际结果待后续回填。
Server一证据 `multibrand147-nature-apply.json`、`multibrand147-serial-start.json`。

10:47:37Z 首次检查：HMW 于10:46:03.916Z开始，另两项仍queued，running=1。
随即手动paused，返回queued2/running1，当前任务未被取消，后项暂停领取；等待当前项结束
后再验证恢复。回执 `multibrand147-pause-running.json`。

## 实现

- 保留独立analysis/catalog/product业务入口，复用Ego/Codex执行、原件归档与精确清理。目录任务直接使用已核实品牌入口，不从首页重新发现全站品牌；原单品材料与混合variant处理边界不变。
- `brands.applySiteAnalysis`增加可选`enqueue:true`。同一事务保存来源、每品牌的`brand_scan`和`dtc_analysis_scan`关联及请求回执。旧调用仍只保存来源。同一请求重交返回原回执；同一分析/来源换请求ID也返回原扫描，不重试历史任务。禁用来源保留并明确不入队。
- 迁移050增加DTC扫描控制，默认paused。`brands.controlDtcScans`以requestId和mode手动暂停/恢复；`brands.dtcScanQueue`报告模式、待处理、运行中及终态清理未完成的许可数。商品队列仍独立控制。
- 数据库控制行锁和DTC运行项唯一索引共同保证全局一次一个品牌。仍被旧扫描持有的许可会阻止新品牌领取；释放沿用现有停止证明规则。其他channel保持原领取条件。
- `brands.siteAnalysisTasks({analysisId})`返回每品牌独立scanId、目录状态/完整性、发现数与关联商品状态统计。目录完成不等于商品全部处理完成。
- 恢复沿用固定`browser-scan-<scanId>`工作流；补齐已关闭工作流结果的重连，不重新创建业务尝试。stale时间只触发重连，不是执行已停止的证明。
- 原生任务说明明确覆盖旧skill默认排除多品牌卖场的冲突；vendor别名必须由模型实际验证，不能机械拆成品牌。

持久化队列继续使用现有PostgreSQL和Temporal；不引入另一套队列库。数据库行锁适用于任务领取的依据：[PostgreSQL SELECT](https://www.postgresql.org/docs/14/sql-select.html)；固定工作流冲突策略沿用[Temporal TypeScript SDK](https://typescript.temporal.io/api/namespaces/client)。

## 验证状态

本地完整`pnpm check`通过（格式、lint、依赖边界、重复代码、22个类型检查任务），未新增或运行单元测试。部署与Mini直接验收尚待完成，不能将代码检查写成实站通过。

09:27Z只读预检：DTC商品队列paused，6个历史Review，ready/running上限1；所有channel当前running品牌扫描为空，held许可为空。旧Review/原件不改写。

待验收：迁移与新接口；分析结果独立入队及重复提交；DTC串行/暂停恢复；品牌结果与商品来源关联；真实多品牌、混合variant和跨站方法复用。每次浏览器业务结束均核对原件、任务页、执行停止和许可释放。

## 1e34fe0 部署及首次直接验证

两台Mini均经Git fresh clone/locked install/build部署1e34fe0。Server二09:31:44Z完成，Server一09:36前完成；迁移050之前保存数据库备份`deploy-20260930/db-backups/v3-backup-EmZgcd`，迁移前后目录哈希校验通过。Server一7/7进程ready；五个原本运行但为空的其他通道已恢复，DTC商品队列保持paused/1/1。

新API返回品牌队列paused/concurrent=1。暂停请求`1a5b642d-81f4-4dd5-9091-758d205cd03b`重复提交回执一致。以旧的已完成真实HMW和Solaray分析单独验证持久化交接：分别创建扫描`fe2efc4a-6db2-4653-97a7-1aa97596f832`、`c9961ba9-7f19-48dd-95c8-749964f438e7`。每项原请求重交、换请求ID再次应用都返回同一扫描ID；来源均matched，没有重复创建。09:43Z两项queued、零running，任务关联接口分别正确返回品牌/目录。这里只验证队列交接，未访问这些网站，也不算新版原生多品牌分析通过。

Nature's Truth新分析`ec8a7bc7-397a-4230-adc9-67404b3c9975`于09:37:03Z开始。浏览器通知权限弹窗把Space6交给用户，模型立即停止；PID51410于09:39:26Z退出。目录与代表商品未验证，未创建品牌任务。宿主报`BROWSER.PAGE_CLEANUP_PENDING`，目标`E03D4CE669BD3BBA54641F4C83AAF37D`仍待清理；09:41许可`permit-01a1011f-ca9e-743c-b68e-5899e301a8a5-0`仍持有且CLEANUP_UNVERIFIED。已请求用户处理提示，未接管/关闭用户空间，未释放无停止证明的许可。原有unknown blank保留。

实测补充修正：第一版新队列只统计/阻止旧品牌扫描的遗留许可，漏了同一DTC资源上的站点分析。本次补为分析和扫描共同阻止新品牌领取，并将终态分析的清理待办计入cleanupPending。另撤回新增的执行前enabled短路：禁用仅在新入队时校验，已运行扫描必须先接续旧工作流以核实停止，不能跳过清理。补丁静态检查/部署与后续验证另记。

证据位于Server一`manual-releases/dtc-native-20261002/multibrand147-*`；Server二分析任务目录末级`95e68725add5a2969dc57305f87697138ccb6f22da6d32536c1d799a7ca76472`，原件及模型结果均保留。147/150记录本次权限边界与待清理状态。
