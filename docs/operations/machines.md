# Crawler 执行设备清单

> **R41（2026-09-30）归档提示：** 下文旧 CLI、`crawler-queue`、`crawler-maintenance`、`manual-control.mjs` 及旧 Worker 启动入口已退出当前版本，目录待 Git 索引权限修复后移入 `archive/`；这些历史命令不得再执行，现行入口见 [部署说明](../../ops/deploy/README.md)，Windows `apps/ocr-service` 继续保留。

更新日期：2026-09-30。此文件是设备身份、连接地址与职责的统一入口。地址、用户名和运行状态分开记录；收到 Tailscale 地址不等于已验证 SSH 或已部署服务。本文不保存真实密码、令牌、私钥或数据库连接串。

## R39 Browser Worker：双 Mini 配置（2026-09-30）

Owner 决定：**Server 一与 Server 二都运行 browser worker**，共同轮询
`v3.browser.wholefoods.v1`；队列名沿用现值，不表示只支持 Whole Foods。
两台各驱动本机 Ego 的 `crawler-browser-worker` 空间：Server 一 **TaskSpace 2**，
Server 二 **TaskSpace 6**。Server 二 **TaskSpace 1 `dtc-bridge` 禁止使用、接管或清理**。
本节是配置与手工部署交接，不是已经上线或完成实页验收的声明；下文 09-23/24 状态均为历史记录。

| 机器 | Process / PM2 job | Ego 空间 | 资源 ID | PostgreSQL |
| --- | --- | --- | --- | --- |
| Server 一 | `browser` / `browser-worker` | 2 | `mini-ego-space-1`（保留账本 ID，数字不代表空间号） | `127.0.0.1:55432` |
| Server 二 | `browser` / `browser-worker` | 6 | `server2-ego-space-6`（需要独立容量行） | `192.168.68.70:55432` |

数据库为 `crawler_v3_dev`，运行角色 `v3_runtime`。两机直连私网，无 SSH 隧道。
Temporal 地址 `192.168.68.74:7233`，mTLS `serverName: temporal-server2.local`，namespace `crawler-v3`。
Ego 使用本机 `ego-browser` CLI；schema 的键是 `cliPath`、`taskSpaceId`，没有 `endpoint` 或空间名称键。

### Server 一：追加 job 与 browser 配置

将以下 **一个 job 追加**到现有私有 machine config 的 `jobs`；保留 collection-api、pipeline-worker、
label-worker、label-ocr-worker、label-model-worker、resources-worker 六项。
部署器已有通用支持，自动生成 `V3_WORKER_PROCESS=browser` 和 `V3_WORKER_HEALTH_FILE`。

```json
{
  "id": "browser-worker",
  "app": "worker",
  "process": "browser",
  "env": { "V3_PIPELINE_CONFIG": "/Users/server/apps/crawler-v3/private/worker.json" },
  "healthFile": "/Users/server/apps/crawler-v3/health/browser.json",
  "logs": {
    "out": "/Users/server/apps/crawler-v3/logs/browser.out.log",
    "error": "/Users/server/apps/crawler-v3/logs/browser.err.log"
  }
}
```

以下是 `worker.json` 的**合并片段**，保留其他 process、resourceKinds 和现有 DTC 站点配置。
CLI 路径需与本机安装一致；空间 ID 使用 owner 指定值。

```json
{
  "processes": {
    "browser": {
      "roles": [
        { "role": "browser", "taskQueue": "v3.browser.wholefoods.v1", "maxConcurrentActivities": 1 }
      ]
    }
  },
  "browser": {
    "ego": { "cliPath": "/Users/server/.local/bin/ego-browser", "taskSpaceId": 2 },
    "wholefoods": { "storeId": "10259", "label": "The Alameda", "postalCode": "95126" },
    "routeId": "server1-ego-space-2",
    "egressId": "server1-ego-space-2/1"
  },
  "resourceKinds": { "mini-ego-space-1": "browser" }
}
```

### Server 二：单 browser job 的 machine config

保存为 `/Users/server2/apps/crawler-v3/private/machine.json`。`<...>` 必须换为实际私有部署值，
包括工具绝对路径。这里只有一个 job，没有 API、没有 migrations；不传 `--migrate`，
也不需要 `V3_DATABASE_URL` 迁移凭据。

```json
{
  "machine": "server-two",
  "repository": "git@github.com:<owner>/<repository>.git",
  "root": "/Users/server2/apps/crawler-v3",
  "tools": { "node": "<absolute-node-path>", "pnpm": "<absolute-pnpm-path>", "git": "/usr/bin/git" },
  "pm2": {
    "file": "/Users/server2/apps/crawler-v3/live/ecosystem.json",
    "backups": "/Users/server2/apps/crawler-v3/manual-releases"
  },
  "jobs": [
    {
      "id": "browser-worker",
      "app": "worker",
      "process": "browser",
      "env": { "V3_PIPELINE_CONFIG": "/Users/server2/apps/crawler-v3/private/worker.json" },
      "healthFile": "/Users/server2/apps/crawler-v3/health/browser.json",
      "logs": {
        "out": "/Users/server2/apps/crawler-v3/logs/browser.out.log",
        "error": "/Users/server2/apps/crawler-v3/logs/browser.err.log"
      }
    }
  ],
  "health": { "attempts": 12, "intervalMs": 5000 }
}
```

Server 二 `worker.json` 的 browser-only 角色片段如下。另须配置公共 `storage` 与 `plan`；
`capture`、`label`、`processing` 可以省略，**不复制 ScraperAPI 密钥**。
`plan` 是 browser 商品抓取写入 DTC source plan 的必要配置：复制生产 `plan` 的 `text`、`ocr`、
`visionConfigFingerprint`（及已有 `factsPolicy`），这些是协议描述和指纹，不是模型凭据。
缺少 `plan` 会在启动时拒绝，不会等到商品 Activity 才失败。

```json
{
  "database": {
    "connectionString": "postgresql://v3_runtime:<URL-encoded-password>@192.168.68.70:55432/crawler_v3_dev"
  },
  "temporal": {
    "address": "192.168.68.74:7233",
    "namespace": "crawler-v3",
    "transport": {
      "mode": "mtls",
      "serverName": "temporal-server2.local",
      "caFile": "/Users/server2/apps/crawler-v3/private/temporal/ca.pem",
      "certFile": "/Users/server2/apps/crawler-v3/private/temporal/client.pem",
      "keyFile": "/Users/server2/apps/crawler-v3/private/temporal/client.key"
    }
  },
  "clusterId": "server2-temporal-local",
  "processes": {
    "browser": {
      "roles": [
        { "role": "browser", "taskQueue": "v3.browser.wholefoods.v1", "maxConcurrentActivities": 1 }
      ]
    }
  },
  "browser": {
    "ego": { "cliPath": "/Users/server2/.local/bin/ego-browser", "taskSpaceId": 6 },
    "wholefoods": { "storeId": "10259", "label": "The Alameda", "postalCode": "95126" },
    "routeId": "server2-ego-space-6",
    "egressId": "server2-ego-space-6/1"
  },
  "resourceKinds": { "server2-ego-space-6": "browser" }
}
```

`browser.dtc.sites` 按已批准的实际站点配置补入；省略时为空，不会自动启用 DTC 站点。
两台共用一个队列，应支持相同的任务/站点配置。保留 Whole Foods store 配置不代表其实页验收已完成。
`storage` 必填键为 `r2.{endpoint,bucket,prefix}`、`r2Credentials.{accessKeyId,secretAccessKey}`、
`journalRoot`、`cacheRoot`；R2 使用同一证据空间，本地两条路径改为 Server 二绝对路径。
按引用读取 R2 并缓存，不复制历史缓存或证据目录。完整角色要求见[部署 schema 说明](../../ops/deploy/README.md#browser-worker)。

### Browser 资源健康与容量

Server 一在现有 `resourceHealth.resources` 中合并这一项，保留其他资源、controller 和健康设置，
由现有 `resources` role 刷新：

```json
{
  "mini-ego-space-1": { "taskQueues": ["v3.browser.wholefoods.v1"] }
}
```

Server 二需要独立 `resource_capacity` 行：`resource_id=server2-ego-space-6`、`capacity=1`、
`controller=server2-browser-worker`，初始不健康，由健康循环建立新鲜 TTL。
`resourceKinds` 只声明种类，**不会创建容量行**；健康写入只 UPDATE ID/controller 匹配的既有行，
不会 INSERT 或夺取 controller。当前资源 API 没有创建容量行接口；主会话须通过受审查的迁移/应用服务
配置该行，不能声称加 JSON 就完成了注册。
在引用该 ID 的 API 配置中也须声明它的 `resourceKinds` 为 `browser`；本机声明不会自动更新其他服务。

最少新增进程的方案：仍然只有 `browser-worker` 一个 PM2 job，将 `resources` role 和 browser
放在同一 process；Server 二 browser 进程退出时自己的健康循环也退出。
将上面的 Server 二 `processes.browser.roles` 替换为以下两项，并添加 `resourceHealth`：

```json
{
  "processes": {
    "browser": {
      "roles": [
        { "role": "browser", "taskQueue": "v3.browser.wholefoods.v1", "maxConcurrentActivities": 1 },
        { "role": "resources", "taskQueue": "v3.resources.v1", "maxConcurrentActivities": 4 }
      ]
    }
  },
  "resourceHealth": {
    "controller": "server2-browser-worker",
    "intervalMs": 5000,
    "ttlMs": 15000,
    "minFreeBytes": 1073741824,
    "diskPath": "/Users/server2/apps/crawler-v3",
    "resources": {
      "server2-ego-space-6": { "taskQueues": ["v3.browser.wholefoods.v1"] }
    }
  }
}
```

也可独立增加 `resources-worker` job/process，但必须在 Server 二运行并使用本机健康配置。
纯 browser role 即使写了 `resourceHealth` 也不会运行监控。不要由 Server 一监控代写 Server 二健康：
`diskPath` 检查执行监控那台机器的磁盘。两机 resources role 可共用 `v3.resources.v1`，
处理共享数据库许可操作；健康循环各自只更新自己 controller 拥有的配置行。

**能力边界：** 现有探针检查队列有 activity poller、本机磁盘和（配置时）OCR，
不检查本机 Ego/空间所有权，也不按 poller 机器身份筛选。共享队列有 poller 不等于两个 Ego 都健康。
共享队列也不会将某个资源 ID 的许可自动绑定到对应机器；把两个 ID 同时列为 needs 意味着同时申请两者，
不是二选一。主会话须核验/补齐容量选择与执行机器绑定后才能宣称双空间调度完成。
本项只完成 job、角色配置与健康映射，不修改 workflow/API 调度；每机并发 1 只是本机 Activity 上限。

### Owner / 主会话手工部署与验收

1. 协调并行功能改动，合入 `main` 并推送 origin；本次不执行改变 Git 状态的命令。
   两机部署入口 checkout 从 origin `main` 获取：首次 `git clone --branch main <origin> <checkout>`，
   已有 main checkout 用 `git pull --ff-only origin main`。禁止 SCP 代码，私有 JSON/证书单独配置且 `chmod 600`。
2. Server 一保留六个 job 并追加 browser；Server 二使用上述单 job 配置，推荐同进程增加 resources role。
   落实 Server 二独立容量行与资源选择/执行绑定，核对两机空间 ID/名称，绝不使用 Server 二 `dtc-bridge`。
3. 经 API 暂停、排空涉及的任务/brand scans，确认任务页清理与许可释放。新 release 会改变整份 machine config
   内 job 的路径，所以 Server 一不能只排空 browser。按[部署说明](../../ops/deploy/README.md)完成旧进程交接，
   首次使用新的 ecosystem 文件。
4. 两机分别在自己更新后的 checkout 中执行下面命令。`<...>` 换为核验值；PM2 未安装时按 README 安装固定版本。
   Server 一使用 `/Users/server`，Server 二使用 `/Users/server2`。只手工启动，
   不运行 `pm2 startup`、`pm2 save` 或 `pm2 resurrect`。

```sh
export PM2_HOME="$HOME/apps/crawler-v3/pm2"
pm2 ping
R39_MACHINE_CONFIG="$HOME/apps/crawler-v3/private/machine.json"
R39_COMMIT='<full-40-character-commit-on-origin-main>'
pnpm --filter @crawl-automation/ops-deploy run deploy "$R39_MACHINE_CONFIG" "$R39_COMMIT" --dry-run
pnpm --filter @crawl-automation/ops-deploy run deploy "$R39_MACHINE_CONFIG" "$R39_COMMIT"
pm2 describe browser-worker
cat "$HOME/apps/crawler-v3/health/browser.json"
```

部署器从 Git 新建 release、安装锁定依赖、构建、生成 ecosystem、启动变更 job 并验健康。
R39 没有数据库迁移；Server 二不加 `--migrate`。其他迁移由主会话另按 Server 一流程处理。
若只在原路径修改私有配置，部署器不会识别文件内容变化；排空后手工重启准确 job：

```sh
pm2 stop browser-worker
pm2 start "$HOME/apps/crawler-v3/live/ecosystem.json" --only browser-worker
```

Server 一若修改原 `resources` 健康映射，另对 `resources-worker` 执行同样的 stop/start。
核对健康文件 `role=browser-worker`、`WORKER_RUNNING`、PID 与 PM2 一致、reportedAt 在本次启动之后且
不到 15 秒；核对日志及两台 Temporal poller 身份，通过资源 API 核对容量/健康和许可状态。
真实 Ego/provider 验收只在 Mini 上执行：每机先一项任务，确认准确空间、保留证据、关闭准确任务页并回查消失，
再核验许可结算。保持 intake 暂停到 owner 授权恢复，不重试历史 Review。

**09-24 11:02 最新状态：队列已恢复投放。** Windows 主管崩溃根因（状态文件 rename 撞上健康探针的 Get-Content → EPERM 未捕获）已修复并部署：Server 一健康服务运行于 `releases/fleet-20260924/source`（提交 `166c8c7`），Windows 运行新主管（PID 26416，Text/Vision 2/2，OCR 4/4）；人工 reconcile 释放 6 个许可后 canStart=true，running 80 / ready 20 / queued 243。队列 CLI 与 Amazon Worker 仍是 `local-temporal-20260923` 构建。[根因、修复与恢复记录](../quality/2026-09-24-windows-supervisor-crash.md)。

**09-24 09:32 最新状态：队列受清理故障阻断。** 昨晚追加 725 个：82 成功、261 Review、6 清理未结算、376 未执行。Windows Text/Vision 及主管实际进程已消失，状态文件停在昨晚 23:24；23:37 的 Windows 清理失败后守卫持续禁止进料。Server 一 90/90 ready、Windows OCR 4/4 healthy、Server 二 Temporal 服务正常；这些不能解释为任务仍在正常跑。本次只读检查，没有恢复或释放许可。[上午状态记录](../quality/2026-09-24-morning-status.md)。

**22:22 最新状态**：用户授权继续投放剩余可执行商品，替代此前 100 个总量限制。前 100 个已结束（9 成功、91 Review，资源均已释放）；通过现有控制器恢复 725 个 attempt=0 的未执行商品。22:22:36 验证 60 个执行中、20 个待投放、645 个排队，60 个均已在 Server 二 Temporal 启动，健康正常。历史 Review 不重跑，Brand 不重启。见[恢复执行记录](../quality/2026-09-23-remaining-products-resumed.md)。

**22:00 最新状态**：用户将单商品本轮限定为 **100 个总量**，已核对恰好 100 个不同商品全部连接 Server 二 Temporal；2 成功、31 Review、67 执行中。队列处于 draining，725 个未开始商品暂停，不再补入；33 个已结算请求的资源占用均为 0。Brand 原件离线分析完成，原结果仍为 325 verified / 1,026 Review，无新付费抓取或导入。见[本轮试跑及 Brand 分析](../quality/2026-09-23-brand-failure-analysis.md)。以下运行状态为历史快照。

**21:47 最新状态**：业务切换已完成。Server 一 90/90 就绪、Windows Text 4 / Vision 4 均连接 Server 二局域网 Temporal。首个原队列商品成功入库，存档及释放验收通过；原 ready 20/running 80 已恢复。快照：77 执行中、742 排队，健康检查无阻断。历史 Review 不重跑，未增加自启。见[业务切换记录](../quality/2026-09-23-local-temporal-cutover.md)。

**21:05 历史快照**：Server 二已部署独立 Temporal / PostgreSQL / UI / 认证网关，通过双节点局域网连接、重启续跑和备份恢复验证；**现有业务 Worker 与商品队列尚未切换**。Server 一 21:04 只读健康状态仍为 `CLEANUP_FAILED_MANUAL_REQUIRED`，不要沿用 18:17 队列已恢复的旧快照。Brand 搜索批次已于 17:59 自然完成，原件保留、不调查 Review。见[本地 Temporal 部署验收](../quality/2026-09-23-server2-temporal.md)。

## 三台当前执行设备

用户最新统一称呼：**Server 一** = 美国主 Mini；**Server 二** = 新 Mini（Temporal、Ego/browser Worker、按需 Brand 工具）；**Windows** = 美国 Windows。Server 二的自建 Temporal 已部署验收；browser Worker 双机配置见上方 R39，部署状态须另行核验。

| 固定称呼 | Tailscale 地址 | SSH 用户名 | 职责 | 已知状态与证据 |
|---|---|---|---|---|
| Server 一（美国主 Mini） | `100.76.126.12` | `server` | 产品数据库、单商品队列与 Worker、Ego/browser Worker | 历史队列状态如下；R39 browser Worker 部署待验收 |
| Windows | `100.114.3.97` | `rc-workstation\barry` | OCR HTTP 服务、Text / Vision Worker | Text 4 / Vision 4 已切换到 Server 二；OCR HTTP 保持原服务 |
| Server 二（新 Mini） | `100.84.91.3` | `server2` | 自建 Temporal 及专用数据库、Ego/browser Worker、按需 Brand 建档 | Temporal 已验收；R39 browser Worker 部署待验收 |

既有单商品队列仍由 Server 一管理；R39 新 browser Worker 在两台 Mini 上轮询同一队列，各用本机空间。
两机共用品牌身份、抓取证据与 Server 一生产数据库，不复制独立的生产产品数据库。

## 连接入口

以下是连接地址，不代表首次主机密钥已经核验。继续沿用已验证的主机密钥；新机器首次连接需核对主机身份，不关闭 SSH 主机密钥校验。

```sh
ssh server@100.76.126.12
ssh -l 'rc-workstation\barry' 100.114.3.97
ssh server2@100.84.91.3
```

美国 Windows 已由用户提供的 ED25519 主机密钥指纹：

```text
SHA256:G0nkbUe2En//nb9EO4/3L5fRxR6VgQKQ5Yck534UKqU
```

## 美国主 Mini

- 历史核验主机名：`servers-Mac-mini.local`。硬件核验记录为 Apple Silicon、16 GiB 内存、10 CPU（2026-09-21），不是新 Mini 的配置。
- 部署根目录：`/Users/server/apps/crawler-v3`。实际生效版本以该机部署清单与运行进程为准，不能用 MacBook 工作区的 HEAD 代替。
- Crawler 主数据库：该机 `127.0.0.1:55432/crawler_v3_dev`；容器 `crawler-v3-us-postgres-1`，持久卷 `crawler-v3-us-postgres18`。查询迁移后的生产业务记录应指向这里。
- 已用于局域网访问的 Node：`/Users/server/Applications/Crawler Node.app/Contents/MacOS/node`。
- 固定管理入口：根目录下 `crawler-queue`、`crawler-maintenance`、`manual-control.mjs`。操作前先核查现状及对应执行单。
- 2026-09-21/22 曾核验局域网地址 `192.168.68.55`、`192.168.68.70`；它们是历史观测，不能据此保证 DHCP 地址一直不变。
- 2026-09-23 13:18 恢复 4,057 个未执行单商品；13:21 快照为 running 79、queued 3,933、ready 20。此处记录恢复事实，实时剩余量须重新查询。[恢复记录](../quality/2026-09-23-single-products-resumed.md)
- 2026-09-23 17:34 只读核验：单商品队列被失败清理守卫阻止继续投放，queued 1,731、ready 20、cleanup pending 1；completed 累计 507、Review 累计 3,036。Mini 90/90 ready、OCR 4/4 健康；Vision 已结束任务仍持有一组 CPU/模型许可，17:13 自动清理失败后等待人工核对。本次未恢复。[状态记录](../quality/2026-09-23-single-products-status-1734.md)

## 美国 Windows

- 历史核验主机名：`RC-workstation`；项目根目录 `D:\crawlv3-cloud`。
- Node 路径：`D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe`。
- 美国主 Mini 到 Windows 的已配置 OCR 地址：`http://192.168.68.69:8081`，健康入口 `/health`，处理入口 `/ocr`。两机已有局域网连接时使用此地址。
- 该地址对应 Windows 的局域网转发及限定来源的防火墙规则。新 Mini 已观察到局域网地址 `192.168.68.74`，尚未测试它到 Windows OCR 的连接；Brand 入口建档本身无需 OCR。
- 保持 **OCR HTTP 服务**；此前无用的 Windows OCR Worker 已停用，不应为了建档重新启动。
- 最近一次恢复核验（2026-09-23 13:21）：OCR HTTP 实际为 4/4 CUDA 后端，Text / Vision 维持此前各 4 槽配置。美国主 Mini 的 OCR 许可上限是 6；许可数与实际 HTTP 后端数不同。
- Worker / OCR 按用户要求手动启动，不新增开机或登录自启。

## Server 二（Temporal、Browser Worker 与按需 Brand 工具）

- 用户已确认连接身份：`server2@100.84.91.3`。
- 2026-09-23 21:05（北京时间）：自建 Temporal 1.31.2、PostgreSQL 16.13、UI 2.53.3、Caddy 2.11.4 已部署验收。根目录 `/Users/server2/apps/temporal-local`；Worker 地址 `192.168.68.74:7233`（mTLS，校验名称 `temporal-server2.local`），业务 namespace `crawler-v3`；管理页 `http://100.84.91.3:8080`（Tailscale＋密码）。服务均手动启动，`restart=no`；两节点连接、同 Run 重启续跑、备份恢复及 Server 一备份副本均通过。[部署与运维记录](../quality/2026-09-23-server2-temporal.md)
- 2026-09-23 首次设置完成后：Docker Desktop 4.92.0 / build 240144 已安装至 `/Applications/Docker.app`，官方 SHA-256、签名、公证检查通过。Engine / CLI 29.8.0、Compose 5.5.1 正常；20:41:57（北京时间）启动的隔离容器、跨容器数据卷持久化和本机端口验收全部通过，测试容器及卷回查均为 0。当前 Docker VM 10 CPU / 约 7.75 GiB，`AutoStart=false`。**Docker 已验收；Temporal 尚未部署，旧队列未切换。**[Docker 安装记录](../quality/2026-09-23-server2-docker.md)
- 2026-09-23 接入检查：Tailscale 控制面中设备名为 `server2’s Mac mini`、系统 macOS、状态 online；Tailscale ping 成功，约 228 ms。初次 SSH 返回 `Connection refused`；用户随后确认开启 Remote Login 并允许 `server2`，再次握手成功，服务标识为 OpenSSH 10.2。
- ED25519 主机密钥指纹：`SHA256:+gdy3JeKFEL5heJJUFcP+g+xVXsGA2NDP10G5MPKOPc`。已首次固定到 MacBook 的 `/private/tmp/crawler-brand-mini-known-hosts`，未关闭主机密钥校验；这是首次信任固定，不冒充已完成独立带外核验。
- 用户成功追加公钥并返回 `SSH_KEY_READY` 后，已实际通过公钥登录。MacBook 公钥指纹为 `SHA256:OW6u+0wAoly8GKy4wa6C8xQar+89O8iWpyfosGJNNO8`。[接入检查记录](../quality/evidence/2026-09-23-brand-mini-preflight.json)
- 已核验 macOS 26.4.1（25E253）、arm64、Mac16,10、16 GiB 内存、10 CPU，初始约 190 GiB 可用磁盘；局域网地址 `192.168.68.74`。地址是本次观测，不保证 DHCP 永久不变。
- 用户安装 Apple Command Line Developer Tools 后，已核验 `/Library/Developer/CommandLineTools`、Git 2.50.1、Node 24.21.0、pnpm 10.14.0。Node / pnpm 位于用户目录，使用显式 PATH，没有新增自启。
- 历史 Brand 工具核验：浏览器 `/Applications/ego lite.app` 版本 0.5.1.11，CLI 为 `/Users/server2/.local/bin/ego-browser`。旧工具曾使用 TaskSpace 1；此记录不授权 browser Worker 使用它。R39 只用 TaskSpace 6 `crawler-browser-worker`，TaskSpace 1 `dtc-bridge` 禁止触碰。历史未知来源的空白页不当作任务页关闭。
- 代码目录 `/Users/server2/apps/crawler-brand-entry`；初始从 GitHub clone，后续通过临时 SSH 回环 Git 通道获取独立分支提交，并在目标机安装锁定依赖、构建。当前本地工具提交 `f55c70d`；本轮数据目录 `/Users/server2/brand-entry-runs/20260923`。
- 美国主 Mini 的导入器代码位于 `/Users/server/apps/crawler-v3/brand-entry/source`，当前已验证构建为 `0ffdc08`（后续 `f55c70d` 只增加收集命令，导入逻辑未改变）；现有单商品 release 未切换。
- 用户明确改为几个月运行一次的本地前置工具：**不接 Temporal / R2、不传入服务凭据、不新增数据库 schema、不安装常驻 Worker 或自启**。原凭据转移请求取消，不再等待批准。
- 新 Mini 仅收到 1,352 个公开商品链接和随机临时 ID；原数据库 ID 对应关系留在控制机和美国主 Mini。原始 HTML 存于新 Mini 本轮目录，完成后回传验证成功的证据和结果，Review 原文保留在新 Mini 按需读取。
- 2026-09-23 15:42 北京时间已核验停止：累计尝试 13 个候选，2 verified、10 Review、1 cancelled，1,339 未开始；运行锁已移除、执行/回传/导入进程均已退出，准确任务页全部消失。Ancient Nutrition 和 Nature’s Bounty 两条入口已经写入美国库，均为 `enabled=false`、revision 1。剩余候选不自动继续。
- 用户要求先讨论具体工具和流程；后续每次只选一个 Brand，结束后停下核对，不允许把整批任务排队后以并发 1 自动处理。独立的原单商品队列未因本次 Brand 暂停而改变。
- 当前操作与一次性收集进程见 [本地工具执行记录](../quality/2026-09-23-brand-entry-local.md)。
- 2026-09-23 17:22，北京时间：按用户新要求完成一个 Herb Pharm 的 ScraperAPI 搜索入口试验。美国主 Mini 用已有凭据抓取 2 页，新 Mini 离线核验原件与真实品牌筛选；结果保存在各机的 `20260923-scraperapi-herb-pharm` 独立目录。未迁移凭据、未部署新的批量采集器、未写数据库，旧批次继续暂停。当前交付项改为实际品牌名＋品牌筛选搜索 URL，不再必收店铺 URL。[试验记录](../quality/2026-09-23-brand-scraperapi-check.md)

## 另行保留的控制机与历史来源机

| 设备 | 地址 / 身份 | 当前作用 |
|---|---|---|
| 当前 MacBook | 当前项目工作区所在机器 | 开发、规划及远程操作；不运行浏览器、provider 或集成测试 |
| 原本地 Mac mini | `barry@192.168.0.25` | 旧库查漏与历史证据来源；不作为迁移后主数据库，不因查旧数据而重启旧业务 Worker |

原本地 Mini 的 `quant-pg` 中，`product_staging`、`railway_local_new` 等是本次品牌查漏使用的旧产品库；旧 Crawler 测试库另有 `127.0.0.1:32806/crawler_v3_test`。不能把旧产品库、旧 Crawler 库、美国主库混为一套数据库。[查漏记录](../quality/2026-09-23-local-product-brand-reconciliation.md)

## 维护约定与相关记录

- 后续报告使用上面的固定称呼，避免“那台 Mini”“本地 Mini”混淆。
- 运行数量、软件版本、IP、路径等变更，注明实际核验时间与证据；不要把计划写成已部署。
- 部署采用目标机 Git clone；私有配置单独处理，保留 R2 原件与既有 Review。
- 这份包含内部地址的清单保留在本地工作记录；本次未授权把它发布到公开仓库。
- [美国主 Mini 初始环境](../quality/2026-09-21-us-mac-mini-environment.md)是历史安装记录，其中“独立空库、未迁移”的描述已被后续迁移记录取代。
- [迁移进展与局域网 OCR](../quality/2026-09-22-us-migration-progress.md) · [单商品恢复记录](../quality/2026-09-23-single-products-resumed.md) · [部署纠正约定](../quality/2026-09-22-migration-corrections.md)
