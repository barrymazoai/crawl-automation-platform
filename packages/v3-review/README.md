# 被动 Review · V3-017

独立模块，契约在 `v3-contracts`，实现不依赖 Temporal SDK、应用、R2 客户端或 Worker。
它是不可变错误记录，不是失败任务队列；没有消费者、自动重试、修复、领取、删除或批量续跑。

## 保存和交接

`ReviewRecord` 保存 reviewId、发生时间、分类/code、阶段、执行事实、request/observation/operation、
输入指纹、evidenceKey、blockedBy、原始错误（name/message/stack/details）、完整 JSON 候选及复核目标。
上游尚无产品观察时 observation 可以为 null；尚未产生候选时 candidate 必须显式为 null。
不依赖 Brand/Source 外键，不会因来源修改或删除丢失事故记录。

调用方须保存并重复使用**同一个事件的 reviewId、occurredAt 与原始内容**，不要每次重试生成新 ID/时间。
同一 operation 的不同事故可用不同 reviewId 追加；同 ID/相同规范 JSON 幂等，同 ID/不同内容拒绝覆盖。
`executed` 必须来自执行证据，不根据异常名字猜测；blockedBy 必须指向另一 operation，且本节点 not_executed。

```ts
const records = new PostgresReviews(primaryPool);
// record 已含完整原始错误/候选；不要把 Error 实例直接当 JSON。
await records.append(record); // 返回 registered:true 才确认登记
// append 报 REVIEW.REGISTRATION_UNKNOWN：独立读回，而非重新 OCR/重新发任务。
const proof = await inspectRegistration(records, record);
// proof.registered=false 只是没有登记；不是自动重算或补发许可。
```

应用不得在 append 失败时返回“已进入 Review”或计作业务成功。写后读来自主库；读失败也是未知。
本模块不吞错重试。调用方在收到可靠回执前保留原有本地/远端证据；后续原子 Worker 任务负责接入。

候选和原始错误完整保存在新业务库的私有 `review_record.record` 中，无截断；JSON 上限 2 MiB、
嵌套深度 48，拒绝 undefined、非有限数字、循环与类实例。超限报 TOO_LARGE，不能丢字段后假报成功。
本期未实现大载荷外置，应保留既有证据并停留在登记未确认状态，不删除它。
evidenceKey 是稳定引用，本模块不据此宣称远端文件存在；真正证据核验交给只读检查器。

## 查询与隐私

运行 API 的 Bearer 认证同既有 V3 API。全部 `Cache-Control: no-store`。

| GET 路径 | 用途 |
| --- | --- |
| `/api/v3/reviews` | 分页及 requestId/operationId/brandId/sourceId/category/code/stage/executionFact/blockedBy 过滤 |
| `/api/v3/reviews/summary` | 已持久登记的错误记录总数及分类；不是失败产品或成功入库数 |
| `/api/v3/reviews/:id` | 分类、身份、证据引用与原始载荷保留/hash 摘要 |
| `/api/v3/reviews/:id/inspection` | 独立只读证据复核，无状态变更 |

分页 limit 默认 25、最大 100，before 为上一页 nextCursor。按不可变 reviewId 的 C 排序倒序，
**不是发生时间倒序，也不是并发新增情况下的事务快照**；刷新重新查看新事件。
查询拒绝未知字段，没有任何 Review HTTP 写入/重试路由。

HTTP 使用显式允许字段清单，**不返回原始异常、完整候选或检查输入**，包括签名 URL、请求头等潜在敏感值。
内部 `PrivateReviewReader.read()` 可取完整记录，供受信任复核工具使用；不得直接转发到 HTTP/日志。
数据库备份同样包含这些私有数据，须使用既有私有权限保护。持有数据库读取角色可访问原始记录；这不是字段加密。
页面查看完整候选/原始错误的权限与展示在后续 UI 任务处理，本项无网页修改。

## 统一只读复核

`ReviewInspector` 只注入 PrivateReviewReader 与可选的 delivery.inspect / result.inspect：

- 入口交接适配已有 `DeliveryReviewer`；返回安全决策和是否有问题，不转发提供商异常原文。
- OCR 结果适配 `OcrResultHandoff.inspect(input, signal)`；重验签名输入，返回 computedLocal / artifactDurable / resultRegistered。
- 检查结果与原错误记录分开，不覆写原错误，不自动追加新记录，不释放来源、不重新 OCR、不上传或登记。
- 没有目标返回 NOT_APPLICABLE；未配置适配器返回 NOT_CONFIGURED；检查失败返回 UNAVAILABLE，均不是核验成功。
- 普通 API 入口仅连接数据库，**没有默认远端适配器**。必须在部署组装层显式选定集群/存储并注入只读端口。

现有只读交接 CLI 新增统一 Review ID 入口，要求相同显式私有配置和隔离 V3 主库：

```sh
pnpm --filter @crawl-automation/v3-api delivery:review --review-id REVIEW_ID
```

这条命令只接受 workflow-delivery 记录，先检查数据库版本/恢复隔离，再连接已配置 Temporal；
保留原来按 request UUID 检查的用法。40 秒整体上限、不消费任务、不启动 Workflow。
OCR 远端复核只有注入端口与本地测试组装，本轮未接真实 R2 配置。

## 数据库与验证

`007_review_records.sql`：不可变表、关联查询索引、UPDATE/DELETE 拒绝触发器。
新增 `v3_review_writer` 仅能追加 Review（及读表），`v3_review` 继续只读；其他运行角色不授予 Review 写权。
角色没有 public DDL/迁移权限。启动检查要求 007、索引和触发器；现有数据库必须显式备份后迁移，不能隐式升级。
**本轮仅新建临时数据库验证，没有迁移现有持久库、修改旧流程、部署 Worker 或接生产。**

```sh
pnpm --filter @crawl-automation/v3-review build
pnpm --filter @crawl-automation/v3-review test
pnpm --filter @crawl-automation/v3-api test:integration
```

集成测试位于 `apps/v3-api/integration/reviews.test.ts`：真实 PostgreSQL + Hono 内存 HTTP 请求，
真实交接/结果检查器，远端 Temporal/ObjectStore 均为 fake；不是浏览器、云端或真实模型验收。
[验收记录](../../docs/plane/evidence/CRAWLV3-17/README.md)。后续任务 18 为文件获取与页面整理原子模块。
