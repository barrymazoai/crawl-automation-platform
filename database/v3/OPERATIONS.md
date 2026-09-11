# V3 开发业务库：迁移、凭证与恢复

CRAWLV3-11。仅管理新 V3 业务库，不是旧库迁移，也不管理 Temporal 内部库。工具代码在 `apps/v3-api/src/bootstrap/{schema,backup,credentials}.ts`，CLI 为 `src/database-cli.ts`。

## 安全边界

- 仅显式 `V3_DATABASE_URL`，不猜旧 `DATABASE_URL` 或 `.env`。普通 CLI 只接受 `127.0.0.1` / `localhost` 的 `crawler_v3_dev` / `crawler_v3_test`，用户名和密码必填；禁止查询参数覆盖目标。不是远程/生产迁移工具。
- 修改前停掉该库的 API、投递运行器和其他写入者，核对主机、端口、数据库、操作者与备份目录；不得顺手停止别的系统。CLI 的确认字符串不是身份认证，也不能代替现场核对。
- 迁移/恢复仅用专用 V3 集群的维护账号，业务运行不用维护账号。不要指向同名但不是本项目的库。新建云端资源、修改现有持久库仍需明确确认目标与授权；本轮只在临时库测试。
- 运行脚本需要 Node/pnpm 和 PostgreSQL 的 `pg_dump` / `pg_restore`。部署须携带整个 monorepo 的 `database/v3/*.sql`，不能只拷贝 `dist`。使用与服务端兼容的 PostgreSQL 工具版本。

## 版本化迁移与启动检查

沿用已有 `v3_local_migration(name, sha256)`，不改写已发布迁移。当前清单到 010（同表接纳图片 /1、混合 /2 与分组配方 /3 采集快照）；清单按编号追加，缺失前缀、未知/超前版本、hash 变化立即失败。没有自动 baseline、降级、删表重建或修复 hash 功能。009/010 仅更换 codec 版本约束，不更新既有记录、不放宽 observation 唯一性或不可变规则；本轮只在临时库验证，已有持久库尚未升级。

迁移器取得事务级 advisory lock 后，将本次所有新增 DDL 与版本登记放进同一事务。失败整体回滚；重复执行无新版本时不重放 SQL。已有版本且需要升级时，必须先成功生成新备份；备份失败不执行 DDL。该锁只协调本工具，不阻止管理员手工 DDL，因此仍需维护窗口。

正常 API 与投递运行器只读检查：版本/hash、必需列、有效扫描/Review/采集索引、七个已启用的完整性触发器，以及恢复隔离标记。缺版本时不启动、不自动迁移。此检查不是数据库完整 schema diff，也不证明管理员没有篡改同名触发器函数体。

从仓库根目录操作，连接串通过私有环境/密钥管理注入，不把密码粘进命令历史或日志：

```sh
# 先设置 V3_DATABASE_URL，再核对输出目标；不显示密码。
pnpm --filter @crawl-automation/v3-api db status
# 将核实后的目标设为 V3_DB_CONFIRM，例如 127.0.0.1:55440/crawler_v3_dev。
# 目录必须已存在且为绝对路径。工具在其中创建私有的新子目录，不覆盖旧备份。
pnpm --filter @crawl-automation/v3-api db backup /absolute/private/backups
pnpm --filter @crawl-automation/v3-api db migrate /absolute/private/backups
pnpm --filter @crawl-automation/v3-api db status
```

只有空的新库可以首次初始化；未登记但已有业务对象的库拒绝接管。状态检查不会创建版本表。失败时保持服务停止，查迁移日志和数据库日志，修复原因后原命令重跑；不要删除版本记录绕过检查。程序脱敏错误，不输出数据库原始异常/凭据。

## 当前 socket-only 开发启动器

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
