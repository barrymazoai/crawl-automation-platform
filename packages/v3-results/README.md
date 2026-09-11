# V3 结果登记与完成凭证恢复

CRAWLV3-16：独立 Node 包，消费共享契约与 v3-artifacts。当前结果 codec 为单文件 OCR；不是对任意提供商 JSON 的通用信任。包内没有 OCR/模型客户端、任务队列、Workflow、自动消费者或重试循环。

## 三层事实

| 字段 | 判断依据 |
| --- | --- |
| computedLocal | 本地结果和完成清单字节齐全，hash、长度、输入版本、结果身份及清单交叉引用通过 |
| artifactDurable | 原图/页图、结果、完成清单均从注入的远端存储直接回读核验；本地缓存不代替远端证据 |
| resultRegistered | 主数据库已存在同一 operation 的相同登记，且远端证据仍通过核验 |

三者不是一列互相覆盖的任务状态。本地缓存丢失但远端与登记齐全，可以是 false/true/true。数据库行存在但远端证据丢失，返回 NOT_DURABLE，不冒称可用完成。登记并非正式产品入库，也不是 Temporal Workflow 完成。

## 职责及调用

应用启动层显式注入 storageId、LocalCopies、ObjectStore、CompletionJournal、ResultRegistry。storageId 是稳定部署存储命名空间标识，不含密钥；迁移存储位置不自动视为相同登记。客户端超时、数据库连接池和关闭由组装层管理。

```ts
const handoff = new OcrResultHandoff(storageId, localCopies, objectStore,
  await FileCompletionJournal.open(privateJournalDirectory),
  new PostgresResultRegistry(primaryPool));

// 提供商结果收到后，先保存本地结果/完成清单及不可变查找记录。
await handoff.capture(input, output, signal);

// 严格只读：不填充缓存、不上传、不 INSERT、不调用提供商。
const facts = await handoff.inspect(input, signal);

// 显式、可分别安排的交接动作；不是后台自动重试循环。
await handoff.uploadMissing(input, signal);
await handoff.register(input, signal);
```

capture 只写本地：结果 → 完成清单 → 按 operationId 可定位的不可变 journal。输入指纹重算，输出字段严格匹配；原件/结果/清单身份和 key 不得混用。局部失败留下证据，只有完整清单链才算 computedLocal。两个输出竞争同一 operation 时只能发布同一份 journal，否则 CONFLICT，不覆盖旧记录。

inspect 只调用 read：读取主库/journal、核对同一输入和存储身份、核对本地与远端 bytes。原图单独存在、半份结果、未完成 journal 不授权重算。失败分类交由调用方进入后续被动 Review，任务 17 才负责 Review 持久化。

uploadMissing 先核验，只上传明确缺失且有有效本地证据的对象。已存在的对象校验后跳过；远端不可用不当作缺失。使用 v3-artifacts 的条件 PUT 和只读回执核验，不覆盖已存在对象。上传响应未知时保留证据；下次先 inspect，再显式补缺失项。

register 先检查所有远端证据，向主库单次 INSERT ON CONFLICT DO NOTHING，再回读与重新验证。重复相同登记幂等，任何输入/版本/结果/清单/存储身份变化均冲突。响应未知返回 RESULT.REGISTRATION_UNKNOWN，下一步是独立 inspect；确认未登记后才由调用方显式补登记。唯一键使并发或晚到的同一登记不会覆盖结果。

错误区分 INCOMPLETE、INTEGRITY、CONFLICT、UNAVAILABLE、NOT_DURABLE、REGISTRATION_UNKNOWN；文件层保留 ARTIFACT.* 分类。数据库原始错误不传入返回消息。取消不返回伪成功；不能取消已经提交的数据库事务，仍应查证据。DB Pool 应显式配置连接/语句超时并连接主库，不能用延迟副本判断登记不存在。

## 数据库与权限

新增 database/v3/006_processing_results.sql，接入已有版本/hash 迁移工具。operation_id 唯一，登记记录、hash、时间不可更新/删除；DB 不联网验证 R2，可信登记模块才负责插入前证据核验。不能直接向该表插入任意 JSON 后声称已核验。

v3_result 专用运行角色可 SELECT/INSERT，但无 UPDATE/DELETE/TRUNCATE/DDL 或来源占用写权限。旧角色不增加结果 INSERT 权限。凭证只在用户显式运行数据库管理命令时创建，此轮仅在新临时集群验收。

启动层必须使用已有 assertSchemaReady 检查迁移及恢复隔离标志，再组装服务；包自身不自动连接、迁移或创建角色。已有持久库尚未应用 006，新版本启动会要求显式备份/迁移；没有为通过验收自动升级或重启现有 4180/4181 等服务。

## 完成范围与后续边界

21 单元测试、6 真实临时 PostgreSQL 场景、2 构建后独立 Node 进程 SIGTERM/SIGKILL 场景通过。调用计数证明进程本地完成后退出，新实例只补传/登记；提供商及远端存储在这些恢复测试中是 fake，进程信号和 PostgreSQL 是真实的。任务 15 的真实 R2 证据独立保留，本轮没有重复使用聊天密钥或发起云端调用。每个引用在存储 I/O 前限制为 32 MiB；本地 journal 限 1 MiB。取消在读取返回和本地发布后再次检查，不把中途取消当成功快照。

本模块不发放 provider 执行许可，不声称 provider exactly-once。进程在收到结果但尚未可靠保存之前死亡，可能没有可恢复完成证据；仍需保守分类，不能依据“未找到结果”自动 OCR。预调用保留/并发准入、真实 OCR Worker、Workflow 绑定和 Review 持久化由对应后续任务实现。P0 LocalEvidence 未替换，没有重写旧队列或旧生产链。

local journal 使用私有绝对目录、拒绝最终路径符号链接、限制读取大小，暂存写入 fsync 后硬链接发布。只移除已确认发布的本次暂存链接；失败暂存、结果和清单保留。不承诺抵御同权限恶意进程或主机断电，不当作跨主机共享文件系统。跨机器恢复依赖已登记的远端证据，未上传的本地完成仍需原节点/原卷可访问。

测试命令：

```sh
pnpm --filter @crawl-automation/v3-results test
pnpm --filter @crawl-automation/v3-results test:integration
pnpm --filter @crawl-automation/v3-api test:integration
```

[任务验收证据](../../docs/plane/evidence/CRAWLV3-16/README.md)。没有页面变更，不用截图代替后端证据。
