# 保存的 Ego GNC 证据续接下游

一次性受限验收入口，不是常驻采集服务。沿用已发布 sourcePlan，启动现有 `GncStreamingLabelWorkflow` 的 `start:saved-plan`，不重写工作流，也不连接浏览器。仅本次613701页面/四图、Mini、Luna/medium、测试R2/隔离PG。

新角色 `file-receipt`：capability `file.receipt`，队列 `v3.file.receipt.v1.acquisition-v1`，Activity沿用 `acquireSourceFile` 输出契约。`ResolveAcquiredFile` 只注入 `inspect`，核验既有完成记录和原字节后返回durable；无下载、PUT或Review写入端口。没有记录则失败，不能从“缓存缺失”转入下载。

现有 acquisition Worker 外壳仍统一检查R2/Review数据库及私有配置；只读角色不构造 `StaticDirectSources`，`sources`省略。这里的“只读”是模块运行行为，**不是宣称已为R2凭据实施GET-only IAM策略或完全解除外壳的Review启动依赖**。

```sh
# 在项目apps/v3-workers中构建；不会执行业务
node --import tsx scripts/build-gnc-live.ts
node --import tsx scripts/build-ego-tests.ts
node --import tsx scripts/build-batch-one-tests.ts
node --import tsx scripts/build-quality-check.ts
```

同步构建到Mini后，在**新建、尚不存在live子目录**的受限根下显式运行：

```sh
node <build>/gnc-live/mini-gnc-live-run.js --authorized-ego-downstream \
  /Users/barry/apps/crawlv3-gnc-saved.<new-id>/live
```

入口固定验证已保存的capture/plan/SKU，私有配置沿用Mini已有位置；每次新运行产生新label操作/namespace/隔离库。**不得把这个命令作为轮询重试脚本。** 本轮已经成功，后续默认只读验收，不需再调用OCR或模型。

新Workflow包含page/core、四份file/OCR/keyword、单来源准备、文字/视觉、回执、汇合与保存。每个角色独立进程；Workflow只等待数据，不占上游Worker。异步支线可先完成，最后汇合必须覆盖全部声明来源；未匹配关键词与缺失证据不是同一种状态。

退出停止且保留本轮容器/数据/日志，不清理R2，也不关闭原Ego页。旧Review、旧操作记录不动。真实记录、只读重放/质量核验位置与边界见[本批报告](../../docs/quality/2026-09-09-batch-one.md)。
