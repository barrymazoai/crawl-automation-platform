# V3 shared contracts

新系统的请求、响应、分页、校验与推导类型的唯一来源。Web 和 V3 API 都通过 `@crawl-automation/v3-contracts` + `workspace:*` 消费，禁止跨 `apps` 目录导入或复制 DTO。

目前含 Brand / 来源、提交输入/快照/回执、版本化 `CollectionWorkflowInput` 和 `DeliveryReceipt`。提交只允许指定已存来源的 revision；入口回执 `PENDING_DELIVERY` 是接收事实，当前交接状态用独立的 DeliveryReceipt。稳定 Workflow ID 必须与 request ID 对应；CLOSED 必须有匹配终态证据字段。14 项契约测试通过，开放边界见 [V3 提交入口](../../apps/v3-api/SUBMISSIONS.md)与[投递核验](../../apps/v3-api/DELIVERY.md)。

依赖方向：`apps/web → packages/v3-contracts ← apps/v3-api`。本包只依赖 Zod；无 Node globals、数据库驱动、React、Temporal SDK、环境变量或凭证。数据库行到 JSON DTO 的转换由 API storage adapter 负责；UI 文案、fetch、sessionStorage 属于 Web；repository port 和 mutation 回执内部结构属于 API。

这是私有源码导出包，开发/测试由 Vite、tsx、Vitest 处理，应用构建由 bundler 内联，避免开发期间使用过期 dist。`build` 仍输出 ESM 和类型用于检查。不能直接把此源码包放进未构建的纯 Node 生产入口；若将来单独发布，再增加发布用 exports/版本策略。

```sh
pnpm --filter @crawl-automation/v3-contracts check-types
pnpm --filter @crawl-automation/v3-contracts test
pnpm --filter @crawl-automation/v3-contracts build
```

旧 `packages/contracts` 保持 V2 契约，不导入、不兼容。将来稳定的 Worker 输入/输出、ArtifactRef 可以拆成独立子入口；业务模块、Adapter、Workflow 代码按职责另立包，不能塞入 contracts。当前不提前创建空的通用 utils/core 包，也不把仅被单个应用使用的实现全部上移。

CRAWLV3-14 已加入 [Processing v1](PROCESSING.md)：Observation / OperationIdentity、单文件 ArtifactRef/PDF 页关系、OCR 输入/输出、规范指纹材料、完成凭证、被动错误与显式 reusedFrom。P0 已通过 workspace:* 消费，不再复制 schema；Node 哈希留在运行层。共享契约累计 36 测试通过；真实本地四进程及 Workflow 回放见 [验收记录](../../docs/plane/evidence/CRAWLV3-14/README.md)。
