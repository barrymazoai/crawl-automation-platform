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
