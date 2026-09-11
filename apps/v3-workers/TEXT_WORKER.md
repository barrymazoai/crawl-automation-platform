# 独立 Codex 文本 Worker

入口 `src/text-worker.ts`，命令 `worker:text`。主流程模块，不是延期的网页配置功能。

2026-09-07：新分组配方协议可显式设置 `codex.extractionProtocol="label-extraction/1"`，生成 `codex-text/3 / label-text/1 / resultSchemaVersion=3`；不设置仍保留旧协议及指纹。任务参数须由该配置的 `CodexTextProvider.describe()` 生成，不能复用旧 operation 修改版本。执行、保存、登记和独立回执均按同一新解码规则核验；旧产品汇合仍拒绝新版本，尚未端到端切换。Mini 248 项隔离回归通过，未真实部署/调用模型；详见[本轮报告](../../docs/quality/2026-09-07-label-text-worker.md)。

2026-09-07：新增独立 [text-receipt Worker 与 PreparedTextWorkflow](TEXT_RECEIPT_WORKER.md)。已发布页面文本可由 Workflow 调度本角色，再交独立只读核验；不将核验责任放入 Codex 进程，不改变内部模型请求边界。HTML 整理、产品文本/图片汇合与保存仍待接入。

## 执行边界

一项业务 operation 只启动一次 Codex 执行；内部模型调用/恢复轮次归 Codex 管理。Worker 控制并发、总时限、取消、最终结果验证及证据交接，不因内部多轮判失败。失败和未知执行不会自动重开，交接失败不重新解释。业务操作防重依赖 R2 持久执行意图，不依赖进程内计数。

每个 operation 使用独占 Codex 进程和新工作目录；目录/结果证据不自动删除。模型/provider/effort 明确配置，运行配置版本与超时进入任务兼容指纹；修改 Codex 版本或提供商私有配置时同步更新 runtimeProfileVersion。默认 worker.ts 不注册此角色，避免意外领取任务。

## 配置

两份配置都通过绝对路径显式传入。私有配置文件要求普通文件、非符号链接、最大64KiB，POSIX权限600。Codex配置目录与工作根目录要求私有目录（700），Windows需部署者另设等价ACL。

业务配置示例是结构模板，不是可直接运行的真实配置：

```json
{
  "codex": {
    "settings": { "provider": "openai", "model": "your-selected-model", "reasoningEffort": "high" },
    "executable": "/absolute/path/to/codex",
    "codexHome": "/absolute/private/text-codex-home",
    "workRoot": "/absolute/private/text-work",
    "runtimeProfileVersion": "text-profile/1",
    "timeoutMs": 240000
  },
  "storageId": "your-r2-scope/1",
  "cacheRoot": "/absolute/private/artifact-cache",
  "ocrJournalRoot": "/absolute/private/ocr-journal",
  "textLocalRoot": "/absolute/private/text-evidence",
  "r2": { "endpoint": "https://ACCOUNT.r2.cloudflarestorage.com", "bucket": "BUCKET", "prefix": "PREFIX", "timeoutMs": 10000 },
  "r2Credentials": { "accessKeyId": "PRIVATE", "secretAccessKey": "PRIVATE" },
  "resultDatabase": { "connectionString": "PRIVATE", "tls": true },
  "reviewDatabase": { "connectionString": "PRIVATE", "tls": true }
}
```

这不是让用户重新提供R2密钥：已有 `.automation-state/secrets/.env.r2` 保留，部署装配时显式读取，不写入示例或Git。
Codex认证/提供商配置由部署者事先放入专用 codexHome；启动不会登录、导入个人配置或复制账号凭证。不要直接接入带活动MCP/插件的个人Codex配置；文本profile禁用命令、浏览器、外部应用和环境访问，并拒绝活动MCP。客户端授权/交互请求尚不自动处理，会结束本次执行并按异常归档；此限制属于无人值守权限边界，不是内部次数限制。
保留原 HTTP(S)/ALL_PROXY 等设置，不操作 Clash。业务DB/R2密钥不会传给Codex子进程。

```sh
pnpm --filter @crawl-automation/v3-workers build
V3_TEXT_LIVE_ENABLED=true V3_TEXT_CONFIG=/absolute/private/text.json node apps/v3-workers/dist/text-worker.js --list
```

`--list` 只读角色元数据和构建哈希，不启动Codex/Temporal/数据库/R2，不读登录凭证。将输出的 buildId、compatibility 填入既有 Worker 运行配置；角色为 `codex-text`、capability为 `codex.text`、contractVersion为1，队列由运行层派生为 `v3.codex.text.v1.<compatibility>`。不要自己猜哈希。

```sh
V3_WORKER_ENABLED=true V3_WORKER_CONFIG=/absolute/private/runtime.json V3_TEXT_LIVE_ENABLED=true V3_TEXT_CONFIG=/absolute/private/text.json pnpm --filter @crawl-automation/v3-workers worker:text
```

远端Temporal继续使用已有mTLS运行配置。启动会进行数据库表/模型能力只读检查，再开始领取任务；不自动迁移数据库或创建远端资源。数据库账号只需对应结果/Review表的SELECT/INSERT。OCR来源检查使用既有OCR登记/证据，不调用OCR接口。

注意当前 `textActivityOptions` 的 startToClose 为5分钟，生产采用示例240秒时限可留出交接空间；不要只调长Codex超时而不协调Activity时间和Worker停机策略。

## 验证范围

2026-09-06已追加[单样本真实Codex+R2验收](../../docs/plane/evidence/CRAWLV3-21/REAL_CHAIN.md)：`gpt-6-astra/high`，1次业务执行，Formula/Ingredients引用正确；空缓存新Worker恢复0新执行/0PUT。使用本机Temporal和临时PG，未跨机或生产部署。下方为此前模拟验证范围。

已实现真实本机Temporal+临时PostgreSQL+编译业务Worker子进程测试；Codex和S3是显式测试替身。测试脚本/Workflow/HTTPS重定向均不进入普通业务构建。

```sh
pnpm --filter @crawl-automation/v3-workers test:integration
pnpm --filter @crawl-automation/v3-text test
pnpm --filter @crawl-automation/v3-text test:integration
```

另有真实CLI+无凭证本机合成Responses服务测试，验证Provider内部多轮处理，不是调用真实收费模型。
单样本真实账号+真实R2业务链路已另行验收；Windows/Linux实机、跨机、真实并发和生产常驻部署仍待验。新ProductWorkflow/上游TextDocument装配仍由后续任务衔接。

真实验收脚本 `scripts/live-text.ts --authorized-one <全新运行目录> <R2私有env绝对路径> <已有auth.json绝对路径> <Codex可执行绝对路径> <model> <effort>` 需由本应用目录用 `node --import tsx` 显式运行。不是可重复调用的普通测试：重新运行会消耗新业务执行额度，失败先检查证据，不自动重跑。脚本生成600权限的临时登录副本，退出时删除副本；不导入个人运行配置。R2对象和结果证据保留，私有Worker配置不得提交或上传。运行前先 `pnpm build:test`，保护脚本可离线用 `node --test scripts/live-text-audit.test.mjs` 验证。
