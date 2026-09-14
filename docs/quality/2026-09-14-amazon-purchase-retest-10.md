# 购买条件改造后的十商品复测

用户要求从已测试的 24 个商品中重新测试 10 个。2026-09-14 04:43:14 UTC 已通过 Temporal 启动，运行中；本记录不表示十个商品均已完成。

- Campaign：`amazon-purchase-retest-10-us-10001-20260914`。
- Run：`01a09e39-f6e8-7533-9214-2b41eee105d5`。
- 固定 10 个不同 ASIN、10 个新的单商品请求，`stopAfter=10`；全部完成后该 Workflow 自然结束。
- 从原 100 商品计划中按原顺序取前 10 个，均核实已有提交；保留旧观测、Review、R2 证据，并生成新的请求与观测身份。
- ASIN：B0C296MRW4、B01IAI2MB8、B0D1LQLV1P、B0GHZDFNP8、B07VLV4HMF、B0H2BRKTMX、B08951CXCW、B0GGVD471R、B0CZ16FHGN、B0D94RTZGR。
- Amazon US，纽约邮编 10001。价格基线同时保留旧历史价格和这批商品上轮的已存观测。
- 原 100 商品批次继续 `paused / cursor=24 / stopAfter=24`，原批次 Worker 不变。
- 新批次复用现有 Workflow Worker，增加独立 Activity 控制 Worker 和队列，避免把原暂停批次的控制配置改掉。
- 七个 Amazon Activity Worker 逐个重新加载追加后的任务清单；实际程序与 build ID 沿用已部署版本，没有重新构建或替换业务代码。其他 Worker 和原 monitor PID 不变。
- 业务迭代、等待、失败处理都由 Temporal 执行；启动脚本只准备配置并提交一次批次 Workflow。

Mini 数据目录：`/Users/barry/apps/crawlv3-history-20260913/amazon-purchase-retest-10-20260914`。
新控制 Worker：`/Users/barry/apps/crawlv3-batch-a.UiA4dx/amazon-purchase-retest-10-20260914`。
只读查询：`node /Users/barry/apps/crawlv3-history-20260913/inspect-amazon-purchase-retest.mjs`。

首次查询确认：提交 1/10，首个 B0C296MRW4 的产品 Workflow 正在执行，主部署 90/90 ready，原批次仍暂停。后续字段、Review、实际关页和完成情况以目录中的 `inspection.json` 及终态证据为准。

04:45:20 UTC 实际业务观测已写入：B0C296MRW4 为 7.99 USD、one_time、卖家 Carlyle、Amazon 发货、数量 1、邮编 10001、页面显示优惠 15%、priceScope=selected_offer。购买条件保存在历史记录中，旧观测仍保留。此时标签子 Workflow 继续执行 OCR，已有 `TEXT.LABEL_GROUP_EMPTY` 模块 Review；尚未认定产品完整解析成功。

## 待本轮十个结束后统一处理

用户要求（2026-09-14）：先记录问题，等本轮十个商品全部结束，再统一分析和处理。当前只维护问题记录，不修改解析代码、数据库、运行配置，不重启 Worker，不重发失败商品，不调整批次上限。不能因为单个商品进入 Review 就提前改变本轮测试条件。

以下是截至 2026-09-14 05:06:54 UTC（北京时间 13:06:54）的中途发现，当时已有 6 个提交、5 份新观测；不是十个商品的最终验收结论。

| 编号 | 问题及已确认事实 | 本轮结束后的核查范围 |
| --- | --- | --- |
| 1 | 评论数原文已抓到，但 5/5 未转成结构化数字。实际原文为 `(486)`、`(84)`、`(27,116)`、`(4,247)`、`(20)`。 | 核对采集值到历史指标的转换规则，覆盖括号和千分位；保留原文。 |
| 2 | 库存原文已抓到，但 5/5 结构化 `inStock` 为 null。四件原文是 `In Stock`；B0D1LQLV1P 为 `Only 10 left in stock - order soon.`。 | 区分明确有货、少量库存、无货和不能确定，不将页面读取问题当下线。 |
| 3 | B0GHZDFNP8 的购买方式为 unknown、购买数量为 null；价格 30.54 USD、Amazon.com 销售/发货、邮编和优惠已保存。其报价原文出现 Bundle Was Price / Bundle Savings。 | 对照保留的页面证据检查组合商品布局与已选报价范围；目前未证实具体缺失原因，不能直接推断一次性购买或数量 1。 |
| 4 | 五份观测的 `selectedOptions` 均为空。 | 核对页面是否实际提供规格选择，区分“无选项”和“有选项但漏取”；当前列为待核验，不认定五件全都漏抓。 |
| 5 | B01IAI2MB8 没有新价格观测，浏览器 Review 为 `AMAZON.BROWSER_PHASE_UNRESOLVED`，原因为 `AMAZON.GALLERY_UNVERIFIED`。 | 核查图库原始证据与校验条件；该错误本身不能证明商品没有图片、已下线或网络故障。 |
| 6 | 标签处理出现分组为空、核心内容缺失、配料标题不合法、覆盖范围不确定，以及组装时配方冲突。涉及 `TEXT.LABEL_GROUP_EMPTY`、`VISION.LABEL_CORE_MISSING`、`VISION.LABEL_GROUP_EMPTY`、`TEXT.LABEL_INGREDIENT_HEADING_INVALID`、`TEXT.LABEL_COVERAGE_UNCERTAIN`、`LABEL_PRODUCT.FORMULA_CONFLICT`。 | 先按商品和阶段归并最终结果，再区分原图质量、识别内容、字段转换和校验约束问题；多条模块 Review 不等于多个失败商品。 |

同时保留以下边界，避免误报或误修：

- 五份观测的当前价格、USD 币种、评分、卖家、发货方和纽约 10001 均已保存；购买方式和数量为 4/5 已识别。五份购买条件均通过历史指标回读和产品服务导出材料的一致性检查。
- 四件观察到优惠及条件，一件未观察到；未观察到不等于确实没有优惠。优惠原文里的订阅限制已保留，不把订阅券直接扣到一次性购买价格上。
- `applied=null` 表示没有证据确认优惠已生效；本轮不做结算操作，不能把它机械补成 true。配送国家没有明确证据时仍为 null。
- 参考价存在三件、两件为空；需核对页面是否展示，不能仅凭 null 判断漏抓。没有真实订阅购买方式样本，订阅周期的实站完整性尚未验证。
- 旧观测未记录完整购买条件，因此即使页面报价能比较，也不能宣称是相同购买条件下的价格变化。

统一处理的启动条件：确认该十商品 Campaign 到达终态且十个请求均有可核对结果；汇总最终字段完整率、每件商品的主因、任务页面清理结果和许可状态，再制定一轮修改及针对性复测。保留旧观测、原始证据和被动 Review，原 100 商品 Campaign 仍暂停在 24。
