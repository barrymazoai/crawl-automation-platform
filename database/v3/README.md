# V3 新业务数据库 · 第一版基础结构

2026-09-09：新增 `013_catalog_presence.sql`，保存目录页/发现/子流程启动回执/目录封闭/存在性结论及观察到 Temporal 执行的映射，全部不可变。只在新隔离库验收；现有持久库未升级。不是第二任务队列，不从处理/入库结果推断产品消失。[第二批边界与证据](../../docs/quality/2026-09-09-batch-two.md)。

2026-09-07：新增 `010_label_collected_products.sql`，同一不可变 collected_product 表允许分组配方 codec /3。仅更新版本约束，不改写旧快照；Formula、Ingredients、分组剂量和来源由共享契约验证。只在隔离临时库验收，已有持久库未升级；[报告](../../docs/quality/2026-09-07-label-product.md)。

当前决定：新建独立的 V3 业务数据库，完全按新系统设计；不与旧库混用，也不与 Temporal 内部数据库混用。当前只提交结构与隔离测试，不创建云端数据库、不连接旧库。

## 第一批表

| 表 | 用途 | 核心字段 |
| --- | --- | --- |
| `brand` | V3 自己的品牌身份 | UUID、名称、备注、版本号、创建和修改时间 |
| `brand_source` | 一个 Brand 的多个采集入口 | UUID、Brand 外键、渠道、地区、URL、启用状态、版本号、时间 |
| `api_request_receipt` | API 写入的幂等回执 | 请求 UUID、操作、输入指纹、成功结果、创建时间 |
| `collection_submission` | 不可变的采集入口请求 | 请求 ID、来源 ID、稳定 Workflow ID、配置快照、接收时间 |
| `source_submission_guard` | 来源级防重叠 | 来源主键、关联的提交请求；无 TTL、无任务租约 |
| `workflow_delivery` | Temporal 交接事实 | 固定目标/输入指纹、Run、核验分类、终态事件；非任务队列 |
| `processing_result` | 核验后的不可变处理结果登记 | operation 唯一键、登记 hash、输入/文件/完成清单引用、登记时间；非产品入库 |
| `review_record` | 被动错误和完整候选留存 | reviewId 幂等追加、原始错误、blockedBy、引用；私有载荷不直接经 HTTP 返回 |

`006_processing_results.sql` 随[结果登记与完成凭证恢复](../../packages/v3-results/README.md)增加。只在全新临时库执行，现有持久库未升级；应用更新后启动检查会要求显式备份和迁移。新 v3_result 运行角色仅追加结果，不允许覆盖或删除。原件/结果/清单的远端核验由结果模块负责，数据库 JSON 行自身不是联网验证证明。

`007_review_records.sql` 随[被动 Review](../../packages/v3-review/README.md)增加。只在全新临时库执行，新增 v3_review_writer 追加角色；v3_review 保持只读。Review 不自动消费，不与产品入库成功混算。备份恢复已补非空 Review 完整载荷比对；生产迁移仍未执行。

`002_api_receipts.sql` 随 Brand API 切片增加。它只防止同一个 API 请求重复写入，不领取任务、不保存旧 ID，不是兼容层或第二套队列。

`003_collection_submissions.sql` 随提交入口切片增加。请求、API 回执、来源防重叠记录在一个事务里提交；失败全部回滚。`004_workflow_delivery.sql` 随[Temporal 投递核心](../../apps/v3-api/DELIVERY.md)增加：意图先落库，事务外调用网络；确认终态和释放来源原子提交。`005_delivery_scan.sql` 为[独立交接运行器](../../apps/v3-api/RUNNER.md)增加 keyset 索引，不添加队列或租约状态。运行器已完成本地验证但未常驻部署，业务 Workflow 尚未实现，正常 API 仍关闭接收。003–005 只在新临时库验证，未应用到现有持久业务库。

同渠道允许多个入口。Brand 无需正式公司 ID 即可创建。这里没有 `legacy_id`、旧数据结构、旧状态机或旧 Job 依赖。公司同步是未来独立集成边界，不提前在基础表中保存未经验证的公司映射。

来源默认禁用；启用也只改变配置，不自动发任务。来源不能改绑其他 Brand，删除有来源的 Brand 会被拒绝，不级联删除。暂不提供硬删除接口。品牌名称在当前工作空间内不区分大小写唯一；名称不是产品服务的公司身份。

`revision` 是乐观并发控制字段。数据库更新触发器自动递增版本并更新时间；API 更新必须加 `WHERE id = $id AND revision = $expected`，影响 0 行时返回冲突或不存在，不能无条件覆盖。

数据库仅检查 URL 基本形状。[V3 API](../../apps/v3-api/README.md) 已实现解析、主机/默认端口规范化及 fragment 去除；抓取访问安全仍未实现，不能声称具备 SSRF 防护。相同 Brand、地区和规范化 URL 不重复存储，不把不同地区强行合并。

## 开发边界

只创建当前切片用到的表。采集观察、产物、结果、被动 Review、请求回执和计划等表，随对应模块的新契约逐步增加，不预先照搬旧库。

`001_brand_sources.sql` 定义 Brand / 来源，`002_api_receipts.sql` 添加 API 回执，`003_collection_submissions.sql` 添加接收与防重叠，`004_workflow_delivery.sql` 添加交接事实，`005_delivery_scan.sql` 添加扫描索引，**都不是旧库迁移脚本**。已接入[版本化迁移与恢复工具](OPERATIONS.md)：使用 `v3_local_migration` 记录顺序和 hash，DDL 与登记原子提交；已有库升级前备份，普通启动不隐式迁移。不要绕过工具直接重放 SQL 或补写 ledger。SQL 文件自身的事务保留，独立结构测试仍可直接使用。

当前不做历史 ID 映射、批量搬库、旧字段兼容、双写或旧任务续跑。以后需要真实样本时，只读取一个明确 Brand 及必要来源，在隔离环境按新契约构造 fixture；旧状态不进入新运行链。真实样本来源可记在测试说明里，不因此增加生产兼容字段。

## 验证

需要本机 `initdb`、`pg_ctl`、`psql` 和 `postgres`：

```sh
node database/v3/test-schema.mjs
```

脚本创建全新临时 PostgreSQL 集群，仅启用私有目录中的 Unix socket，禁用 TCP，忽略所有继承的 `PG*` 连接参数。不接收数据库 URL，不可能因默认配置连到旧业务库。

上述结构测试仅覆盖 `001`；完整版本迁移、API、备份/恢复和权限验证使用 `pnpm --filter @crawl-automation/v3-api test:integration`。当前验证范围与命令见 [OPERATIONS.md](OPERATIONS.md)。测试结束后停止临时服务，保留证据目录；不导入旧数据，不新增后台常驻服务。
