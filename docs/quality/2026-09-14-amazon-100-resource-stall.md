# Amazon 100 商品批次：第 10 个商品资源等待诊断

2026-09-14，只读核查 Mini 的 Temporal 历史、实际部署产物、数据库许可账本、Worker 日志、本地证据与 R2 对象。未改业务代码、重启 Worker、重发采集、释放许可或修改历史 Review。

结论：文字模型已经结束并返回质量 Review；停止核验在发布资源释放证明的过程中失败，模型名额因此隔离保留。当前流程把这类保留当成普通容量等待，两个后续图片分支持续轮询约 7 小时，直到标签 Workflow 因历史事件数量超限被 Temporal 终止。上层收尾与批次恢复没有覆盖这一种子流程遗留模型许可的情况，剩余 90 个商品未启动。

这次已定位到我们停止证明发布及异常恢复链。R2 发布阶段的底层异常已被代码统一替换，无法进一步确认是哪次 HTTP 请求失败，也不能将“网络波动”或“R2 服务故障”说成已经证实的根因。

## 范围与身份

- 批次：`amazon-history-100-us-10001-20260913`，美国站、纽约 10001，100 个商品。
- 第 10 个 ASIN：`B0D94RTZGR`，Horbäach Lions Mane Mushroom Supplement，80 Softgel Capsules。
- requestId：`24e1a133-c988-41a4-9143-2a8814645b8c`。
- 商品 Workflow：`catalog-product-96658469cc38bd3fce3ca48e0546b320ac7330b4cb60660af48d10fb48e8efb2`。
- 标签 Workflow：上述 ID 加 `-label`；runId：`01a09b9c-83f3-7dfc-8b5a-5f48266a9beb`。
- 遗留许可：`permit-01a09b9c-83f3-7dfc-8b5a-5f48266a9beb-2`，占模型容量 1、CPU 容量 1。
- 核查时模型容量总数为 1；唯一占用者正是本商品的文字解析步骤。OCR 许可均已释放。

## 证据时间线

以下为 2026-09-14 北京时间；对应 UTC 日期为前一天 9 月 13 日。两台机器时间不用于毫秒级因果推断。

| 北京时间 | 证据 |
|---|---|
| 00:32:21 | 标签 Workflow 事件 94：文字解析获得模型许可；事件 98：调度 `interpretText`。 |
| 00:33:03–05 | 文字解析返回 `TEXT.LABEL_INGREDIENT_HEADING_INVALID`，记录为 executed 的质量 Review。模型返回证明已保留到本地与 R2，哈希一致。事件 395 确认 Activity 正常完成。 |
| 00:33:06 | 事件 401 调度 `verifyResourceReviewStopped`。本地已生成释放证明，说明模型返回身份和质量 Review 的核验已通过。 |
| 00:33:07 | 释放证明的 publication claim 已进入 R2；本地与远端 claim 内容和哈希相同。 |
| 00:33:27 | 事件 481：停止核验 Activity 以 `CHANNEL.ACTIVITY_UNRESOLVED` 失败，不可自动重试。Worker 日志第 670 行起记录同一失败。 |
| 00:33:28 | 文字 Review 继续进入 `resolveTextReceipt`；没有释放模型许可，两个图片分支继续等待模型容量。 |
| 07:33:18 | 标签 Workflow 第 51201 个事件为 TERMINATED，reason=`Workflow history count exceeds limit.`，identity=`history-service`。随后商品 Workflow 因子流程被终止而 FAILED。 |
| 08:39–08:50 核查 | 品牌根流程与批次仍在等待。模型许可仍未释放；停止证明远端读取返回 404，模型返回证明仍可读取。 |

文字质量 Review ID：`text-fddb298f-2db8-404d-80ae-8a128a9eef0b`。这是成分标题校验未通过，不是模型调用超时。本次未重新分析这条质量校验是否合理。

## 发布失败定位与证据缺口

模型返回证明：`v3/model-returns/d0ece8680907c05e03508580b24e606bec6af6e0d4c3128db3a252309720a92f.json`，865 字节，本地及 R2 SHA-256 均为 `4b8dc589311c0100525fd524ca13c6ecad418a6541f95f81357f594a16905fc9`。

资源释放证明：`v3/resource-stop/permit-01a09b9c-83f3-7dfc-8b5a-5f48266a9beb-2.json`，本地 1199 字节、SHA-256 `92939914341c314a9c98ed04f68bafad00358df95961b6aa1dea5da4b31e6207`；本次远端 GET 返回 NoSuchKey / 404。

释放证明的 claim：`v3/publication-claims/3b8a2305e9faaf59cccec949eae23f1d0402df451897aedb7d714e5e66c67b3b.json`，本地及 R2 SHA-256 均为 `2546c9afd0c733c9e5dece11fe890fc3c0543f532adb0ea73f27b5117842c28c`。

因此失败已收敛到停止证明的发布链：本地校验及保留已完成，claim 远端已存在，但发布没有完成。不能再归因为“模型一直没结束”或“读取模型返回证明失败”。

claim 的时间到核验失败约 20 秒，部署的 R2 单请求超时配置为 20000ms，支持请求超时这一推测。但没有底层错误、HTTP 请求 ID 或分阶段日志，不能分辨 claim PUT 回执、claim GET、证明 PUT/GET 中究竟哪一步失败，更不能据此确定网络或服务端责任。

## 为什么一次失败变成整批卡住

1. [停止核验](../../apps/v3-workers/src/quality-review-stops.ts)要求证明发布到 R2 后才能释放许可。这一约束仍应保留。
2. [Activity 包装](../../apps/v3-workers/src/channel-label-execution.ts)统一丢弃原始异常，转换为不可重试的 `CHANNEL.ACTIVITY_UNRESOLVED`。停止核验自身也只配置一次尝试。
3. [资源 Gate](../../packages/v3-product/src/resource-workflow.ts)在核验失败时保留许可，但对本次配置返回原质量 Review，而非向整件商品传播“资源隔离，停止推进”。
4. 当前 Amazon 输入使用 `label-image-first/3`，在 [标签流程](../../packages/v3-product/src/channel-saved-workflow.ts)中走多个来源并行处理；只有 `/5` 启用 `requireReviewStop`。本次文字步骤保留模型名额后，两个图片分支等待同一个名额。
5. 资源 Gate 的 900 秒预算只针对持续 unhealthy；healthy 但 capacity 被占用时可以无限等，每个分支每 10 秒再次申请。本次就是后者，等待自身遗留许可也没有被区别处理。
6. 品牌收尾要求商品终态与许可清空、必要失败证据同时满足。批次 [恢复入口](../../apps/v3-workers/src/amazon-batch-control.ts)只从商品 Workflow 本身查浏览器许可，查不到仅由 `-label` 子流程持有的模型许可，因此没有启动对应恢复。根流程持续报告未完成，批次没有收到明确阻塞原因。

实际部署的 `product-workflows.cjs` 已只读核对包含上述等待和核验处理；SHA-256 为 `907d3dcd4dea521e15d53b74516ffe213016a5d7a9910865fb48b27d7e80d7be`。实际 Amazon 标签 Activity build 为 `31f23cdb6a146cef6b3168f72ab3e327a92fcb5d5a0b5e851a752682fddb3514`；执行失败的资源 Worker identity 与当前部署对应。

## 修复方向，尚未实施

- 对已确认模型结束的质量 Review，提供受限的证明发布核对与恢复：核对同一调用、同一许可、同一不可变字节及已有 claim，完成远端证明后再释放。不能重新调用模型、删除 claim 或直接清空许可。
- 简单重试目前的 `publish()` 不足以修复：远端证明缺失但本地 claim 已存在时，[发布器](../../packages/v3-artifacts/src/publication.ts)会拒绝再次发布。需要显式恢复协议，或专用停止证明发布器；不能把全局不可变发布保护直接放宽。
- 任一来源的停止核验无法确认时，让商品明确进入可恢复阻塞，并停止同商品尚未开始的资源等待。其他来源不得静默等待自身隔离许可。
- 给长期等待加入状态与历史预算处理；正常排队可持久化等待或续接，异常隔离必须向上报告，不能靠调高历史上限延后失败。
- 批次恢复覆盖子流程模型许可、TERMINATED 等终态，并让根流程明确显示阻塞。保留失败、Review、价格及原图记录。
- 在停止证明发布步骤记录脱敏的阶段、耗时、底层错误类型及请求 ID；避免再只留下通用错误。
- Amazon `/3` 与已有 `/5` 策略的选择应另外核对并验收，不能在历史重放中直接替换输入或据此宣称本次已使用“第一张完整标签即可”。

原始摘要见 [Temporal 与许可](evidence/2026-09-14-amazon-100-resource-stall/initial-history-and-permits.json)、[本地及 R2 证明](evidence/2026-09-14-amazon-100-resource-stall/proof-publication.json)。已移除 Worker 日志中的 Temporal taskToken；未保存私有配置或凭据。
