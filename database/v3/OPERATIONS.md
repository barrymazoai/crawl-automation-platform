# V3 数据库迁移与恢复

R08 部署迁移入口是 `packages/app/src/deployment/migration-service.ts`，数据库实现位于
`packages/adapters/src/{migrations,postgres}`。`ops/deploy` 直接调用服务；不再启动四次旧
`v3-api db` 子进程，也不增加新的数据库 CLI。现有开发启动器、凭证初始化和恢复功能尚未迁移，
下方保留其独立操作说明；它们不是新部署路径的一部分。

## 目标与维护窗口

- 连接只读取操作者显式提供的 `V3_DATABASE_URL`，不使用旧 `DATABASE_URL` 或猜测 `.env`。
  保留旧 URL 限制：`localhost` / loopback IPv4、`crawler_v3_dev` / `crawler_v3_test`、
  显式用户名和密码，无 query/fragment。不得连接旧业务库或 Temporal 数据库。
- 私有机器配置的 `migrations.confirm` 必须精确匹配 `host:port/database`，默认端口为 5432。
  新部署服务不读取 `V3_DB_CONFIRM`。确认串不是认证，也不代替核对真实目标和授权。
- 迁移前手动停止该库的 API、投递运行器及其他写入者；只操作已确认的目标。使用维护账号，
  不使用业务运行账号。部署服务不会自动暂停数据库写入者。
- `migrations.backups` 为已存在的绝对路径。可选 `migrations.pgDump` 指定绝对可执行路径，
  否则使用 PATH 中的 `pg_dump`，版本须与服务器兼容。
- 部署携带完整的 release `database/v3/*.sql`，不只复制 dist。代码仍只通过 git 到服务器。

## 迁移顺序与历史兼容

服务执行：验证历史 → 备份 → 迁移 → 再检查。修改流程先核对目标，再在同一个数据库事务中
取得 advisory lock `73110311`。历史检查在锁取得之后执行，避免两个迁移器同时读取旧前缀。
锁持续到提交或回滚；连接随后关闭。锁只协调使用此锁的迁移器，不阻止普通写入或人工 DDL。

沿用 `public.v3_local_migration(name text PRIMARY KEY, sha256 text NOT NULL)`，只写原有两列，
不创建 SequelizeMeta 或另一套 Umzug 元数据。Umzug 3.8.3 的 custom storage `executed()` 返回
**完整验证后的**已应用名称。目录当前为 001–031，按原始文件名排序、连续编号；不重命名文件。
SHA-256 覆盖原始 UTF-8 文件字节，包含注释、换行、BEGIN 和 COMMIT，与旧工具对现有文件的
hash 完全一致。执行时才移除旧工具同样移除的外层 BEGIN/COMMIT。

每一条历史记录必须是发布目录的完整、未变更前缀。缺口、未知/超前版本、顺序或名称变化、
hash 变化、`public.v3_restore_hold` 隔离标记均会失败。无历史但已有业务对象的数据库拒绝接管，
包括历史表存在却为空的情况。只允许空库首次初始化；不自动 baseline、down、rerun 或修复历史。

有待执行 SQL 时，在锁内、任何 DDL 之前创建**一次**备份，包括首次初始化空库。
使用当前事务导出的快照调用 `pg_dump --format=custom --no-owner --no-acl --no-password`。
凭据只进入子进程环境，不出现在参数和日志中，并清除继承的 PG* 连接设置。
备份目录为 0700，dump 从创建起为 0600，manifest 为 0600。原有 manifest 格式保留：
`format: 1`、数据库名、时间、dump SHA-256、`applied` 数量、`recovery: quarantine-required`。
首次空库备份的 `applied` 为 0。备份失败不执行任何迁移；失败的私有临时目录保留供排查。

全部待执行 SQL 与对应历史行在**同一个事务**中提交，最后再次验证历史完整性。后续迁移或
再检查失败时，前面本次新增的 DDL 与历史行一并回滚。已到目标版本的库不重放 SQL、不另做备份。
任何失败直接终止部署，不切换 job list、不自动重试、修复或恢复。提交后的数据库升级不会随
job list 回退而撤销；恢复必须单独核对备份与隔离状态。

## 只读检查与演练

`MigrationService.status()` 使用只读事务，验证历史但不创建版本表、备份或加迁移锁。
`MigrationService.migrate({ ..., dryRun: true })` 只返回当前已应用与待执行名称。
部署 `--dry-run` 仅展示步骤，连数据库都不连接，因为新的 release 尚未实际 clone。
这些历史检查不是完整 schema diff，也不能证明管理员未修改触发器或表结构。
旧 API 的启动完整性检查保持原样，不隐式迁移。

部署用法与所需 workspace 依赖见 [ops/deploy/README.md](../../ops/deploy/README.md)。
单元及隔离 PostgreSQL 测试：

```sh
npx vitest run --config vitest.v3.config.ts packages/app/src/deployment packages/adapters ops/deploy
```

迁移集成测试在 `packages/adapters/src/migrations/umzug-runner.test.ts`，有 `initdb`、`pg_ctl`、
`pg_dump`、`pg_restore` 时创建专用临时集群，仅私有 Unix socket、不监听 TCP。SQL 测试样例
运行时生成，现有 001–031 文件只读；不把 fixture 或数据库数据提交 git。结束后关闭服务并保留
临时目录。无工具时 `skipIf` 跳过；沙箱明确禁止共享内存等能力时，可设置
`V3_TEST_SKIP_POSTGRES=1` 运行其余测试，但必须另行报告集成测试未完成，不能视为通过。

## 旧开发启动器与独立维护功能（未迁入 R08）

`dev:local` 只在它刚创建的全新数据库初始化结构；**已有库启动只检查，不再自动补迁移**。既有 001/002 库需要显式升级，但本轮没有升级或重启它。

停掉该启动器并确认其专用集群已停止后，用原来的 ownership marker 和排他锁执行：

```sh
V3_LOCAL_DB_ACTION=status pnpm --filter @crawl-automation/v3-api dev:local
V3_LOCAL_DB_ACTION=backup V3_LOCAL_DB_CONFIRM=crawler-v3-local-v1/crawler_v3_dev \
  pnpm --filter @crawl-automation/v3-api dev:local
V3_LOCAL_DB_ACTION=migrate V3_LOCAL_DB_CONFIRM=crawler-v3-local-v1/crawler_v3_dev \
  pnpm --filter @crawl-automation/v3-api dev:local
```

维护模式不启动 HTTP，不创建缺失的库；仅短时启动自己已标记的 socket 集群，完成后停止。升级前备份存入 `apps/v3-api/.local/backups/v3-backup-*`。普通启动时不设置 `V3_LOCAL_DB_ACTION`。

异常遗留 `run.lock`：先核对 `.local/last-owner.json` PID、进程命令和该集群 `pg_ctl status`，确认没有仍运行的 API/数据库再人工处理这个确切空锁目录；不按时间过期抢锁，不删除数据目录，不擅自杀进程。无法确认就保持停止并报告。

该 launcher 仍是单用户私有 socket、trust 的本地原型，`v3_local` 仅属其专用集群；不是下面的 SCRAM 最小权限部署。私有目录保护不等于密码认证。要转换既有集群的 HBA/角色配置，需要独立确认和联调；本轮不暗改现有凭证或 HBA。

## 独立运行账号

在已迁移的**专用 V3 集群**，维护账号可运行：

```sh
pnpm --filter @crawl-automation/v3-api db credentials /absolute/private/credentials
```

同样要求 `V3_DB_CONFIRM`。为六个固定角色生成不同随机密码，SCRAM 存储；仅输出私有目录路径，文件权限 0600、目录 0700。角色已存在会失败并回滚，不自动接管或轮换密码。失败可能保留不生效的凭据文件，不要将其当作成功凭证使用。已有部署升级后，新增角色/新表授权须单独核对，不能再次运行此初始化命令代替权限迁移。

| 角色 | 当前权限 |
| --- | --- |
| `v3_api` | 读取现有表；Brand/Source 插入更新；API 回执、提交快照、来源占用插入 |
| `v3_delivery` | 读取现有表；交接事实插入更新；来源占用删除（应用层先验证终态） |
| `v3_review` | 读取现有表；默认只读事务，即使关闭只读选项也无表写权限 |
| `v3_result` | 读取现有表；仅可追加 processing_result，不可更新/删除结果或修改来源占用 |
| `v3_review_writer` | 读取现有表；仅可追加 review_record，不可更新/删除 Review 或修改来源占用 |
| `v3_collection` | 读取现有表；仅可追加 collected_product，不可更新/删除采集结果或写入其他表 |

六者均非超级用户，不可建库/建角色/复制/绕过 RLS；不可建 public 对象、修改迁移账本。角色授权本身不验证业务终态，持有 delivery 密码的人仍有删除 guard 的 SQL 能力，故不能分给人工复核。DB 管理员也不受此隔离约束。读取角色能访问 Review 原始错误/候选；HTTP 只提供允许字段摘要，数据库备份必须保持私有。

迁移工具不使用这些运行账号。SCRAM 身份需服务端 `pg_hba.conf` 同样配置 `scram-sha-256`；创建密码不会自动修改 HBA。测试用全新 loopback SCRAM 集群验证，旧 socket trust 环境不能当作 SCRAM 已上线。

后续新表须随模块明确增加 grants；本工具不授予所有未来表的默认写权限。备份不包含全局角色/密码，恢复也不继承旧 ACL。正式权限轮换、生产 TLS、秘密管理与跨机部署另行验收。

## 备份与空库恢复

备份是 PostgreSQL custom archive，版本元数据和 dump 使用同一导出快照，附 SHA-256 清单。输出目录/文件私有，失败留下的半份目录无有效清单，不视为可用备份。当前为小型开发库逻辑备份，无压测、自动调度、异地复制、加密归档或 PITR 承诺；应另保存到受控的持久备份介质，不能把系统临时目录当备份保障。

恢复前准备**独立、空的新 V3 目标库**，设置该目标的 `V3_DATABASE_URL` / `V3_DB_CONFIRM`；原库保留不动：

```sh
pnpm --filter @crawl-automation/v3-api db restore /absolute/trusted/v3-backup-xxxxxx
```

只接受自己受控生成且来源可信的备份。checksum 检测损坏，不认证来源；PostgreSQL dump 可以包含可执行 SQL，不能导入外部不可信文件。

工具核对 checksum 与空库，**先持久创建 `v3_restore_hold`，再执行单事务 pg_restore**，不使用 clean/drop、禁用触发器或覆盖现有表。恢复失败也保留隔离标记，不能自动启动或清理。成功后保持隔离，需单独验证数据：

```sql
SELECT name, sha256 FROM public.v3_local_migration ORDER BY name;
SELECT count(*) FROM public.brand;
SELECT count(*) FROM public.collection_submission;
SELECT request_id FROM public.source_submission_guard;
SELECT request_id, run_id, last_issue, closed_at FROM public.workflow_delivery;
SELECT * FROM public.v3_restore_hold;
```

对照清单和原库/事故记录，检查行数、关键 ID、输入指纹、FK 与完整性约束。测试逐行比较了 7 张表，不只比较行数。隔离库允许直接只读 SQL 或 [只读交接复核](../../apps/v3-api/RECOVERY.md) 查询；普通 API/投递启动必须拒绝。

**为什么不能恢复后直接启动？** 快照之后可能已经向 Temporal 发出 Start、写入 R2 或产品服务，但相关本地意图/凭证不在旧快照。恢复库“没有记录”不表示外部操作没有发生。因此先保持停止，逐项核对 Temporal 历史、外部完成证据与请求记录；无法证明的继续保留。恢复标记没有自动解除命令，禁止直接清标记、清 guard、换 request ID 重跑。真正重新开放需另行批准对账与切换方案；这不是已完成生产灾备闭环。

参考 PostgreSQL 官方说明：[pg_dump 快照备份](https://www.postgresql.org/docs/16/app-pgdump.html)、[pg_restore 单事务恢复和权限选项](https://www.postgresql.org/docs/current/app-pgrestore.html)。

## 可复现验收

```sh
pnpm --filter @crawl-automation/v3-api test:integration
pnpm --filter @crawl-automation/v3-api test:temporal
pnpm --filter @crawl-automation/v3-api test
pnpm --filter @crawl-automation/v3-api build
```

测试仅创建一次性新集群，保留证据目录并停止服务。覆盖版本前缀/hash、无备份拒绝升级、失败事务回滚、重复/并发迁移、只读能力检查、备份校验、7 表一致恢复、恢复隔离、独立 SCRAM 权限以及 CLI 目标确认；不读取旧数据、不改现有持久库、不部署云端。

2026-09-05 最终结果：20 单测、49 数据库/HTTP 集成、18 本地 Temporal 场景，类型检查与四入口构建均通过。新增数据库维护测试 10 项；并发升级只生成一次前置备份。另用构建后的 `dist/database-cli.js status` 在全新库验收 SQL 资源定位，返回 applied=5、pending=[]。测试 PostgreSQL / pg_dump / pg_restore 为 Homebrew 15.14；不代表跨主版本恢复已经验证。

恢复证据：`/var/folders/8g/hb1c2xq156b15mbh1ljhkqs00000gn/T/v3-api-2ztr77/maintenance-proof.json`；备份为同目录 `v3-backup-K9LpVx`，合成请求 `749234b7-88f2-4686-a436-02558472b7dd`。7 张表逐行匹配，未知发送 guard 保持 1，恢复隔离=true，实际 API 子进程拒绝启动。临时证据不等于持久备份。原 socket launcher 的维护模式未在现有持久目录实跑；共享迁移/备份能力已在隔离库验证，后续对现有库操作仍要先核对、授权。
