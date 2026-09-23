# Crawler 执行设备清单

更新日期：2026-09-23。此文件是设备身份、连接地址与职责的统一入口。地址、用户名和运行状态分开记录；收到 Tailscale 地址不等于已验证 SSH 或已部署服务。本文不保存密码、令牌、私钥或数据库连接串。

## 三台当前执行设备

| 固定称呼 | Tailscale 地址 | SSH 用户名 | 职责 | 已知状态与证据 |
|---|---|---|---|---|
| 美国主 Mini | `100.76.126.12` | `server` | 已迁移的 Crawler V3 主数据库、现有单商品队列与 Worker | 已完成 SSH、数据库迁移和业务运行验证；2026-09-23 13:18（北京时间）恢复剩余单商品队列 |
| 美国 Windows | `100.114.3.97` | `rc-workstation\barry` | OCR HTTP 服务、Text / Vision Worker | 已验证 SSH；2026-09-23 13:21 的恢复快照显示依赖正常运行 |
| Brand 专用新 Mini | `100.84.91.3` | `server2` | 独立执行 Amazon Brand 店铺及目录入口建档 | IP 与用户名由用户于 2026-09-23 提供；SSH、公钥认证、主机身份、所在地、局域网地址、硬件及运行环境尚未验证；尚未部署 Brand 前置程序 |

新 Mini 不接管美国主 Mini 的单商品任务。两条工作线分别推进，共用同一份品牌身份与抓取证据，不复制一份独立的生产产品数据库。

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

## 美国 Windows

- 历史核验主机名：`RC-workstation`；项目根目录 `D:\crawlv3-cloud`。
- Node 路径：`D:\crawl-automation\tools\node-v22.17.0-win-x64\node.exe`。
- 美国主 Mini 到 Windows 的已配置 OCR 地址：`http://192.168.68.69:8081`，健康入口 `/health`，处理入口 `/ocr`。两机已有局域网连接时使用此地址。
- 该地址对应 Windows 的局域网转发及限定来源的防火墙规则。新 Mini 的所在地和局域网尚未确认，不能假设它可访问同一个 `192.168.68.*` 网段；Brand 入口建档本身无需 OCR。
- 保持 **OCR HTTP 服务**；此前无用的 Windows OCR Worker 已停用，不应为了建档重新启动。
- 最近一次恢复核验（2026-09-23 13:21）：OCR HTTP 实际为 4/4 CUDA 后端，Text / Vision 维持此前各 4 槽配置。美国主 Mini 的 OCR 许可上限是 6；许可数与实际 HTTP 后端数不同。
- Worker / OCR 按用户要求手动启动，不新增开机或登录自启。

## Brand 专用新 Mini

- 用户已确认连接身份：`server2@100.84.91.3`。
- 接入后的顺序：验证主机身份和 SSH → 只读盘点系统、剩余资源与浏览器 → 在目标机 Git clone 并构建已确认版本 → 配置必要的最小权限连接 → 手动运行独立建档任务。
- 代码、浏览器运行目录及主机密钥指纹只有实际验证后才补记；不复用美国主 Mini 的用户名、路径或硬件数据。
- 按任务引用从 R2 读取所需证据，不搬运历史图片、缓存或模型工作目录。
- 具体工作边界见 [Brand 入口前置建档设计](../spark/2026-09-23-amazon-brand-entry-preparation-design.md)。本记录不代表新机已上线。

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
