# V3 P0 · 单文件执行验证

这是新系统的第一个独立、可执行切片，不是旧 Worker 的改版，也不是生产爬虫。

```text
提交稳定 requestId
  → v3.p0.shared-v1.workflow          确定性编排 Worker
  → v3.p0.shared-v1.ocr.file.mock     单文件模拟 OCR Worker
  → 本地输出 + 完成凭证     P0 测试适配器
  → v3.p0.shared-v1.consume.mock      独立下游读取 Worker
异常 → v3.p0.shared-v1.handoff.local  只读核验 / 幂等记录被动 Review
```

## 运行测试

从仓库根目录执行：

```sh
pnpm --filter @crawl-automation/v3-pilot check-types
pnpm --filter @crawl-automation/v3-pilot test
pnpm --filter @crawl-automation/v3-pilot test:integration
```

普通测试不联网。集成测试构建运行入口，首次从 Temporal 官方下载 CLI 1.8.3，再启动仅监听回环地址、随机端口的临时 Temporal 服务。它还启动四个独立 Worker 进程并验证退出。结束后停止测试服务和 Worker。仅测试输出留在系统临时目录 `crawler-v3-p0-*`，不清理业务证据。

离线环境可设置 `V3_TEST_TEMPORAL_CLI` 指向已安装的 CLI；使用此覆盖时需自行确认版本。当前验证环境：Node 22.17.0 / macOS，Temporal SDK 1.23.0，CLI 1.8.3（Server 1.31.2），Awilix 13.0.5。Windows / Linux 运行能力尚未实机验证。

## 分别启动

从仓库根目录启动开发服务：

```sh
pnpm --filter @crawl-automation/v3-pilot server:local
```

服务监听 `127.0.0.1:7239`，Temporal UI 为 `http://127.0.0.1:8239`。数据库保存在本包 `.local/temporal-p0.sqlite`，只用于本地开发，不是 Railway / 生产部署配置。

另开四个终端分别运行（macOS / Linux）：

```sh
V3_ROLE=workflow pnpm --filter @crawl-automation/v3-pilot worker
V3_ROLE=ocr pnpm --filter @crawl-automation/v3-pilot worker
V3_ROLE=handoff pnpm --filter @crawl-automation/v3-pilot worker
V3_ROLE=consume pnpm --filter @crawl-automation/v3-pilot worker
```

Windows PowerShell 设置方式示例：`$env:V3_ROLE='ocr'`，然后执行相同 pnpm 命令。这只是启动语法，尚不代表 Windows 验收通过。

提交一份示例（不读取真实图片，不调用 OCR）：

```sh
pnpm --filter @crawl-automation/v3-pilot submit sample-001
```

稳定 ID 对应一次提交；同 ID 重复启动会被 Temporal 拒绝，不产生第二个 Workflow。主动新采集才使用新 ID。当前 CLI 不实现正式入口的丢失回执查询 API，该能力仍属于后续入口契约。

所有角色使用同一明确配置的 `V3_EVIDENCE_ROOT`（默认本包 `.local/evidence`）。`V3_CONCURRENCY` 默认 1；`V3_HOST_ID` 标记进程所属主机。P0 故意拒绝非回环 Temporal 地址；跨机必须先接入测试 R2 / 业务登记，不能把此本地目录适配器当成跨机交接实现。

Ctrl+C / SIGTERM：停止接单，有界收尾，释放本进程的客户端。没有任务租约续期、成功清理或未知操作重试。

## 代码职责

- `contracts`：重导出 packages/v3-contracts 的共享定义，仅保留 mock 部署策略与 Node SHA-256 wrapper；不再复制 DTO。
- `modules` / `ports`：业务函数及窄接口，无容器与 Temporal 依赖。
- `adapters`：无网络模拟 OCR、本地不可变证据存储。
- `bootstrap`：配置校验、显式工厂、每进程 Awilix 根容器与每操作独立上下文。
- `runners`：薄 Activity 和各角色独立启动入口。
- `workflows`：只安排 Activity 和等待结果，不读写文件、不调用模型。

## 恢复边界

相同 operation + 指纹 + 完整清单和校验通过的输出，直接返回原引用。已开始但无完整凭证、指纹冲突、损坏输出均不重新 OCR。业务 Activity `maximumAttempts: 1`；只读核验和幂等 Review 登记最多投递 3 次。Review 登记未成功时 Workflow 失败，不伪报已持久化 Review。

本地文件通过已同步的临时文件及排他链接发布；先保存不自动过期的执行意图，避免并发重复提交。此方案仅验证本机进程退出后的证据核验，**不提供 R2、数据库事务、跨主机一致性或断电持久性承诺**。原始 ArtifactRef 为假数据，模拟 OCR 不验证真实图片内容。输出 `processed` 只表示模拟下游已读取，绝不表示产品已入库。

CRAWLV3-14：已切换 [共享 Processing v1](../../packages/v3-contracts/PROCESSING.md)，14 单测、6 真实 Temporal 场景（含四个独立 Node 进程）通过。不兼容的版本在 Activity 前拒绝，不进入业务 Review。完成清单核验额外比较 request、实现、策略和配置版本。旧本地输入/清单不迁移、不自动恢复；新队列隔离于旧 v3.p0.*，请为本轮验证使用全新 evidence root。构建内联私有源码共享包，运行 dist 不需要 tsx；开发仍可直接 tsx 启动。
