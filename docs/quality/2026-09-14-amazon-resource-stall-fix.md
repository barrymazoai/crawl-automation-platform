# Amazon 停止证明发布及资源等待修复

针对 [第 10 个商品的卡住原因](2026-09-14-amazon-100-resource-stall.md)：模型已经返回质量 Review，但停止证明发布失败。原流程保留模型许可，其他图片分支无限等待，最终触发 Temporal 历史上限。

## 实现

- 仅对模型已结束的不可变证明恢复发布：复用相同 claim、相同字节，有限次重试与回读；不重跑模型，不删除 claim。哈希冲突仍拒绝。
- 新 Workflow 有共享隔离状态和等待预算；停止核验失败后，同商品尚未开始的分支明确结束，不再无限消耗事件。未知执行仍保留许可。通过 Temporal patch 保持旧历史的命令顺序。
- 保存发布阶段、耗时和经过筛选的错误元数据；不保存 SDK 原始消息、签名请求或凭据。
- 批次恢复覆盖标签子流程遗留的模型许可。恢复必须核对完整终态历史、唯一调用、已执行 Review、模型返回证明、精确页面清理证明和三次目标消失复查。发布和回读停止证明后才释放精确许可。
- 恢复后的失败仍保留为失败，品牌流程可以结束等待。原 Review、原图、旧价格观测不覆盖。

## Mini 验证

- 原有及新增核心回归 93 项通过；随后恢复证据专项 17 项通过（其中 7 项与前述回归重合，合计 103 个不同用例）。
- 真实 Temporal 集成 2 项通过：瞬时证明故障恢复、永久故障停止分支、历史重放，以及批次持久游标和继续执行。
- 原失败商品历史 142 个事件、标签子流程历史 51,201 个事件均使用新 bundle 离线重放通过，没有重新执行 Activity。
- TypeScript 类型检查通过。
- 第 10 个商品只读恢复核验通过：唯一模型许可、返回证明一致、原任务页面三次均不存在。

## 部署和恢复

修复源码已推送 main（`aaa0647`），批次产物目录修正为其独立部署根目录内（`d682922`）。更新并单独重启了 9 个相关 Worker：Amazon 文字、视觉、资源核验，商品、目录、标签 Workflow，Amazon control，以及批次的两个角色。主流程其余 Worker PID 未变，主监控 PID 未变。

批次产物最初放在主部署目录，触发批次独立部署的路径限制，批次监控因此退出；随后将产物放到批次自己的目录，重新拉起该监控及两个批次 Worker。已更新的 7 个主流程 Worker 未再次重启。最终连续三次健康采样均为主流程 90/90、批次 2/2。

旧批次累计了 25,000 多条事件，Worker 重载后首次完整读取历史触发 Workflow Task 超时；SDK 后续重试成功，批次恢复执行。没有重置历史或新建替代批次。

北京时间 09:47:50，原批次的 `recoverAmazonHistoryChunk` Activity 记录 `LABEL_STOP_RECOVERED`，第 10 个商品的精确停止证明发布、回读并释放许可完成。原商品的 FAILED 和质量 Review 保留；其品牌根流程已正常结束。恢复证明：`v3/amazon-label-recovery/01a09b9b-ca75-7beb-b36c-433cdddef45d/proof.json`。

09:50:56，确认无遗留许可、无 intake guard，向同一个 `amazon-history-100-us-10001-20260913` 发送 resume，继续原游标 10。此次不修改模型、纽约 10001 配送条件、商品选择或标签质量校验规则。

## 真实采集验收

第 11 个商品 `B08LP471TS` 的商品和标签 Workflow 均 COMPLETED，业务结果为 Review；文字成分标题和图片剂量仍未通过质量校验，不能计为正式产品入库成功。

- 新标签历史为 497 个事件；两份模型停止证明均已写入 R2 并回读核对。
- 本商品模型、浏览器等许可占用为 0，intake guard 为 0。
- 任务页面 `4385080879BCEB3F9E79BF3DA2602715` 已关闭，三次只读复查 `targetsAbsent=true`；未操作其他页面。
- 采集观测和 metrics trend 已进入 `crawler_v3_test`，本次价格为 USD 12.99。
- 随后批次自行完成第 12 个商品收尾，继续第 13 个。

北京时间 10:01 的快照：游标 12/100，已提交 13 个，11 个采集观测、10 个价格点、31 条模块 Review，完整产品保存数仍为 0。此次修复解决整批卡住和资源恢复，不代表标签质量问题已经解决。

证据：[测试汇总](evidence/2026-09-14-amazon-resource-stall-fix/test-summary.json)、[真实历史重放](evidence/2026-09-14-amazon-resource-stall-fix/replay-results.json)、[部署](evidence/2026-09-14-amazon-resource-stall-fix/deployment.json)、[原批次恢复](evidence/2026-09-14-amazon-resource-stall-fix/resumed.json)、[新商品验收](evidence/2026-09-14-amazon-resource-stall-fix/new-product-acceptance.json)、[进度](evidence/2026-09-14-amazon-resource-stall-fix/progress-summary.json)。私有配置、凭据、完整含内部调用数据的历史仍仅保存在 Mini。
