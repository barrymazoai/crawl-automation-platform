# Amazon 购买条件观测

2026-09-14：已实现并在 Mini 部署。购买条件由现有页面 DOM 读取脚本解析，没有增加模型调用。固定 Temporal 业务流程、队列、OCR/配方处理及页面生命周期不变。

## 数据契约

`commerce.purchaseConditions` 是可选对象，codec 为 `purchase-conditions/1`。本轮 Amazon 开始生成；其他渠道兼容该字段，但没有声称已完成其站点解析。

| 字段 | 保存内容 |
| --- | --- |
| purchaseType | one_time、subscription 或 unknown；必须来自已选报价的明确页面文字 |
| seller | 卖家名称、公开卖家编号、规范化店铺链接 |
| shipsFrom | 页面标注的发货方 |
| delivery | 页面配送国家、邮编及原文；不从域名/IP 推断国家 |
| selectedOptions | 已选规格、包装等选项 |
| quantity | 已选购买数量 |
| subscription | 订阅频率与原文条件 |
| promotions | 优惠类型、原文、金额/百分比、币种、条件、是否明确显示已应用 |
| priceScope | 是否能绑定到已选报价，或仅为页面显示价 |
| evidence / warnings | 字段对应的页面文本、选择器及未确定原因 |

勾选优惠券不代表优惠已生效；不推算到手价。缺失值保留 null/unknown，旧观测不补写默认购买条件。

现有历史表 JSON 已能保存这些信息，无 SQL 迁移：原始 commerce 留在 `metrics.extras.commerce`，结构化对象同时位于 `metrics.extras.purchaseConditions`。产品服务导出保留 `item.extras.purchaseConditions` 和完整 retainedMetrics/raw。已验证导出材料；本次没有写入最终产品数据库。

价格统计区分页面报价差异与已记录购买条件的一致性。旧数据缺条件时仍保留价格趋势点，但不会标为同条件价格变化。已知差异标为 different；一边缺字段时为 unknown。`recorded_conditions_match` 也不代表税费、运费和结算总价一致。

## Worker 影响与部署

按照消费者先、采集者后的顺序，逐个更新、重启并检查 PID、实际入口、build ID 和 Temporal poller：

1. amazon-channel-product-input：解析采集内容、构建计划和历史观测。
2. amazon-channel-label-plan、amazon-channel-label-source、amazon-channel-label-manifest：重新读取含新字段的持久化采集计划。
3. amazon-product-input、amazon-file：重新读取采集内容并核对图片任务绑定。
4. amazon-batch-control：区分报价差异与购买条件比较结果。
5. amazon-capture：最后启用新字段生产。

产品服务导出 CLI 同步放入新 release。独立 monitor、Workflow Worker、Workflow 可执行 bundle、OCR/文本/视觉处理及 Windows DTC 未重启。原批次保持 `paused / cursor=24 / stopAfter=24`，没有新增业务采集。

独立部署脚本：`apps/v3-workers/scripts/deploy-purchase-conditions.mjs`。它要求验收通过、批次暂停、无在途业务任务及无占用许可；备份私有 manifest、逐个替换入口和 runtime build ID，再核对未修改角色 PID。私有配置只在 Mini 保存。

回退时必须考虑已经生成的新观测：先停用新生产端；读取消费者应保留新字段兼容能力，不可将全部消费者回退到拒绝新字段的旧 schema。部署本身不释放许可、不清理历史证据、不重发任务。

## 验证与边界

- TypeScript 检查通过；Mini 94 项测试全部通过，无跳过。涵盖 DOM 报价隔离、隐藏优惠、订阅、规格、未知值、冷读取、图片绑定、标签计划、历史入库、收据重放与产品服务导出。
- 对生产库及 R2 只读核验：39 份旧 Amazon 观测的 source ID、body hash、价格指标完全不变，39 份持久化采集计划仍可读取。
- 真实页面 B0GHZ3X54Z：16.69 USD，Amazon.com 销售/发货，数量 1，纽约 10001。页面未明确标注购买方式，保留 unknown。
- 真实页面 B0C296MRW4：7.99 USD，明确一次性购买，Carlyle 销售，Amazon 发货，数量 1，纽约 10001。
- 两份真实 DOM 样本通过隔离测试库写入、回读和导出一致性验证。没有把诊断样本提交到生产观测库。
- 订阅与优惠券逻辑通过 DOM 固定样本验证；本轮没有声称完成真实订阅/优惠券页面交互验收。
- 两次诊断页面均已精确关闭，读取复查 `targetsAbsent=true`，许可已正常归还。
- 部署后连续三轮健康检查：主部署 90/90、批次 2/2、Mini DTC 26/26；8 个新身份均出现在对应 Temporal Activity 队列。

脱敏证明：[purchase-conditions.json](evidence/2026-09-14-purchase-conditions.json)。Mini 原始证据目录：`/Users/barry/apps/crawlv3-history-20260913/purchase-conditions-20260914`。原始配置、凭据和完整浏览器诊断材料不进入 Git。
