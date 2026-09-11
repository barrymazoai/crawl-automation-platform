# V3 Worker 共享运行层

Plane `CRAWLV3-9`：共享基础设施，不是产品流程或第二套队列。业务 DTO 继续放 `v3-contracts`；本包为 Node Worker 专用，可依赖 Temporal SDK，不应导入浏览器或 Workflow 沙箱。

## 边界

- `RoleRegistry`：代码显式注册一种能力，校验角色、契约版本、兼容组、实际构建指纹；不从环境变量加载任意 JS 文件、不自动扫描模块。
- `runRegisteredWorker`：每进程一个角色，组装/检查完成才启动；停止接单、等待排空、按所有权释放资源。
- `connectTemporal`：显式端点和 namespace 校验；远程必须 mTLS，明文仅回环。共享运行层不知道 Brand、OCR 提供商或产品写入。
- `checkedActivity`：输入/输出 schema 边界；无效输入在业务调用前拒绝，无效输出不重新调用模块。
- `workerProcess`：显式启用和配置文件，信号、启动/退出上限、身份日志。
- `artifactBuildId`：对实际入口 bundle 及所用 Workflow bundle 计算 SHA-256，不接受部署环境自称的版本号。

## 角色工厂与依赖注入

`RoleDefinition.prepare(config, signal)` 负责创建本角色所需的 Adapter/Client，返回二选一：

1. `kind: workflow`：只有已构建 Workflow bundle，不注册 Activity。
2. `kind: activity`：只有本模块的 Activity 函数，不注册 Workflow，禁止空能力假启动。

成功返回后，运行层负责调用 `dispose()`；工厂中途失败时，由工厂关闭尚未移交的资源。工厂可使用 Awilix 或普通函数注入；容器不传入业务核心。每次操作的上下文和证据恢复仍由原子模块实现，不能存在可变的全局产品对象。

本包不偷偷重试业务，也不在失败时切换模型或网络。**Temporal Activity 的服务端重试策略由 Workflow 决定**：注册新业务 Workflow 必须显式 `maximumAttempts: 1`，并审查其客户端隐式重试。不能因为运行器无 retry 循环，就宣称所有业务 Workflow 已禁用重试。测试流程已验证一次失败调用；真实流程在 25/36 等任务验收。

## 队列与版本

业务队列：`v3.<capability>.v<contractVersion>.<compatibility>`。
测试队列：`v3.test.<testSession>.<capability>.v<contractVersion>.<compatibility>`。

队列由已注册代码推导，配置不能任意覆盖。任务队列不绑定物理机器；同能力同兼容组可部署多个实例，每实例 identity 含 host / role / instance UUID / build SHA-256。

配置中的 `expectedBuildId` 必须匹配当前角色代码的真实指纹；`--list` 可查看已注册元数据。构建指纹用于身份及部署防误配；**它不等于跨实例版本隔离**：兼容组决定是否共用队列，不兼容变化必须新组/新队列并遵守在途升级策略。当前 `useVersioning:false`，不宣称开启 Temporal 服务端 Worker Versioning 或完成回放兼容验收。外部依赖按 lockfile/SDK 1.23.0 固定，bundle hash 不是整个操作系统或依赖树的完整证明。

Workflow `concurrency` 指 Workflow Task 执行槽，不是产品并发数；固定 sticky cache 下最少 2，低于此值启动拒绝，不静默提高。Activity 角色最低 1，最多 64，poller 数不超过执行槽。它不是共享账号的跨机额度控制；后者是任务 38。

## 退出与未知结果

先停止拉取，排空当前任务，再释放模块资源，最后关闭连接。仅释放本进程拥有的资源，不停止其他 Worker。SIGTERM 在连接/组装/创建 Worker 时到达也会被保留处理；启动与排空都有进程级硬上限。

如果 SDK 因强制超时/致命错误结束，但 JS Activity 仍可能运行，不调用模块 `dispose` 或关闭它正在使用的连接；进程出口记录未知状态后退出 1。不得因此宣称操作取消、释放全局写许可或重新调用 OCR。完成凭证恢复属于各模块与任务 10/16，强退不代替它们。

应用启动错误不输出原始配置或证书内容；第三方 SDK/模块日志另需模块侧脱敏，不能把本入口的安全日志当成所有依赖日志已审计。

## 验证

```sh
pnpm --filter @crawl-automation/v3-worker-runtime test
pnpm --filter @crawl-automation/v3-worker-runtime build
pnpm --filter @crawl-automation/v3-workers test:integration
```

本地验证入口、具体范围和未部署事项见 [Worker 工程](../../apps/v3-workers/README.md)。
