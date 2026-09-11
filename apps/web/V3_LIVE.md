# V3 本地真实数据入口

2026-09-05 已补 [CRAWLV3-6 浏览器验收与截图](../../docs/plane/evidence/CRAWLV3-6/README.md)：品牌增改、来源编辑/禁用、重复名称错误及手机尺寸均用隔离真实数据库验证。来源页支持 `?brand=<UUID>` 直达/刷新恢复；打开新表单不再残留上一笔保存提示。现有持久库未修改，写入测试入口单独位于 4183。

这是原 HeroUI Demo 的独立真实数据入口，同样使用 Vite / HeroUI V3 / Tailwind。Brand/来源配置、手动提交/交接回读及定时计划已接 API；产品与 Review 后续接入。没有把 Demo localStorage 导入真实数据库。

CRAWLV3-13：来源行「选择计划」可创建每日暂停计划，修改时间/时区、启用或暂停。计划直接回读 Temporal；不建本地调度表。?brand=<UUID>&scheduleSource=<UUID>#schedules 提供只读分享，编辑需先选择来源。计划请求使用独立会话键，刷新保留原始规则且不会自动 POST。普通启动器仍关闭计划功能，隔离验收入口为 4185，详见 [计划运行说明](../v3-api/SCHEDULES.md) 与 [验收证据](../../docs/plane/evidence/CRAWLV3-13/README.md)。

2026-09-06 已补 [CRAWLV3-12 手动提交验收](../../docs/plane/evidence/CRAWLV3-12/README.md)。普通入口仍默认关闭提交，**不能把 Probe 注册当成业务爬虫已上线**。`GET /api/v3/collection-capabilities` 返回经认证的入口开关和部署端配置的 Temporal UI 集群映射，浏览器不猜目标集群、不读取云端密钥。当前正常启动器没有开放真实采集的配置开关。

在来源行点击「选择采集」，再点击「提交一次采集」。先保存专用会话凭证，再 POST 冻结版本；202 只表示已受理。所有错误保留原 key，页面刷新/5 秒回读只发 GET；人工「用原 key 确认提交」才重发相同 POST。404 不等于之前提交失败，不能据此自动创建新 key。仅明确拒绝或终态收口才允许人工归档，归档先复制原凭证至会话归档区，绝不清除服务端占用或取消 Workflow。配置编辑和采集请求使用不同存储键。

`?brand=<UUID>&request=<UUID>#collection` 可在没有提交会话的新标签页只读查看已存请求；不能从这个只读模式重发请求。本标签页若已有未归档的提交凭证，优先保护并显示该凭证。交接回执显示实际 Run、核验时间与错误分类；未确认、集群未配置、身份/Run 链异常时不提供猜测链接。

## 启动

本机需 PostgreSQL 15 的 `initdb` / `pg_ctl` 在 PATH 中。分别启动：

```sh
pnpm --filter @crawl-automation/v3-api dev:local
pnpm --filter @crawl-automation/web dev:v3:live
```

打开 http://127.0.0.1:4181/v3-live.html 。API 固定回环端口 4180；新建的 PostgreSQL 仅接受私有 Unix socket，不开 TCP。专用数据保存在 `apps/v3-api/.local/postgres`，数据库名 `crawler_v3_dev`。没有读取环境中的旧 DATABASE_URL，没有执行旧数据迁移。

正常 Ctrl-C 会停止 API 与它启动的 PostgreSQL，不删除数据。再次启动复用数据，只读校验版本/hash 和必需能力；缺迁移时拒绝启动。已有库需按[数据库运行手册](../../database/v3/OPERATIONS.md)显式升级，升级前自动备份。若异常退出留下 `.local/run.lock`，先人工确认 `.local/last-owner.json` 中的进程已经退出，并检查这个专用集群是否仍运行，再处理锁；程序不会自动抢锁、删除数据或接管未知集群。此启动器用于单机开发，不是生产服务管理器；逻辑备份/隔离恢复已在独立临时库验证，现有持久库未升级或恢复，不代表断电/生产灾备已验收。

API 令牌由本地启动器生成，保存在私有 `.local/api-token`；Vite 服务端代理注入它，浏览器不接触令牌。三个 Web 开发配置都禁止通过静态文件访问 `.local`。真实入口还限制 Host、Origin、Fetch Metadata 和自定义请求头，禁用 CORS；这不是生产认证/权限方案，不要改成公网监听或直接对外发布 Vite。

## 共享边界

- `packages/v3-contracts`：请求、响应、分页与 Zod 校验，Web/API 同源。
- `src/v3/live/api.ts`：浏览器 HTTP、错误展示和待确认请求凭证，无 DTO 副本。
- `src/v3/live/App.tsx`：真实列表、分页、编辑、来源启停；复用 Demo 的纯 UI 组件，不复用模拟 store。
- `apps/v3-api`：鉴权、用例接口、PostgreSQL adapter、事务与持久化。

写入先把 UUID + 原始请求存入 sessionStorage，再发到 API。超时/格式异常/结果未知时保留该凭证，阻止新写入；“确认原请求结果”原样重发，利用 API 幂等回执确认，不重复创建。凭证可跨页面刷新，但关闭整个浏览器会话后的恢复不在此保证内。版本冲突不覆盖新版本，需关闭弹窗、刷新、重新编辑；未提供自动合并。

来源开关只保存配置，不提交采集。手动与定时接收/Temporal 交接使用相同来源防重叠入口；没有硬删除、正式公司匹配、旧库导入或生产数据同步。

## 验证

```sh
pnpm --filter @crawl-automation/v3-contracts test
pnpm --filter @crawl-automation/web test src/v3/live/api.test.ts src/v3/data/model.test.ts
pnpm --filter @crawl-automation/web build:v3:live
pnpm --filter @crawl-automation/v3-api test:integration
```

`build:v3:live` 产物不包含开发代理，不能单独静态发布就视为已接后台；生产需另做认证网关与服务部署。当前构建有大于 500 kB 的主包提示，后续按路由拆包。
