# DTC 独立品牌任务与串行队列

CRAWLV3-147；整体验收151。用户确认：代码按站点分析、任务编排、品牌目录、单品材料采集分开，品牌任务排队慢慢运行。

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
