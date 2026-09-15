# 云端模式 Worker（Windows）：OCR / 文字解析 / 图片解析，不连数据库

这份 release 只有一个入口 `channel-label-worker.js`，可以以三种角色启动：`channel-label-ocr`、`channel-label-text`、`channel-label-vision`。
私有配置里**没有** `database` 字段时，worker 进入云端模式：结果和完成标记写 R2，返回 `uploaded`，由 mini 上的回执步骤登记；失败 Review 也先写 R2。其他角色在没有数据库时拒绝启动。

## 安装

- Node.js 22.16 到 24。
- 把 release 目录放到 `D:\crawlv3-cloud\release`，在里面执行 `npm install --omit=dev`。Temporal 原生模块在本机安装，不要从 macOS 复制 node_modules。
- 私有目录 `D:\crawlv3-cloud\private`（NTFS ACL 限制到部署账号）放 mini 生成的运行配置、私有配置和 Temporal mTLS 证书。
- 文字/图片角色需要本机的 Codex CLI 和登录态；私有配置的 `codex.executable`、`codex.codexHome`、`codex.workRoot` 填本机路径（都放 D 盘）。
- OCR 角色的 `ocrProvider.endpoint` 指向本机 OCR 服务 `http://127.0.0.1:8081/ocr`。

## 启动

每个角色一个进程，环境变量：

```
V3_WORKER_ENABLED=true
V3_WORKER_CONFIG=D:\crawlv3-cloud\private\<role>.runtime.json
V3_CHANNEL_LABEL_ENABLED=true
V3_CHANNEL_LABEL_CONFIG=D:\crawlv3-cloud\private\<role>.private.json
```

```powershell
node D:\crawlv3-cloud\release\channel-label-worker.js
```

启动后进程会在 stdout 打印 `WORKER_RUNNING`，带 `buildId`、`taskQueue`、`identity`。`buildId` 必须等于 release 目录里 `BUILD_ID` 文件的值，也必须等于运行配置里的 `expectedBuildId`，否则进程会退出。

## 怎么知道成了

全部从 mini 侧看：Temporal 上该队列出现以本机 `hostId` 开头的 poller；提交一个商品后，对应活动的返回状态是 `uploaded`（OCR/文字）或图片解析的 `uploaded`，mini 的回执把它登记进账本，资源占用归零。

## 边界

- 不连数据库、不需要数据库凭据、不需要到 mini 的隧道。
- 只领 mini 生成的运行配置里那个队列的任务；账本容量和资源准入仍由 mini 统一管理。
- 不改 release 里的 `.js` 文件，改了 build ID 就对不上。
