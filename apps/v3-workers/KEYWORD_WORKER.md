# 独立关键词 Worker

入口 `src/keyword-worker.ts`，构建后 `pnpm --filter @crawl-automation/v3-workers worker:keywords`。

默认关闭，需要 `V3_KEYWORD_LIVE_ENABLED=true` 和绝对路径 `V3_KEYWORD_CONFIG`；仍需通用 `V3_WORKER_ENABLED=true` / `V3_WORKER_CONFIG`。配置文件为私有普通文件（POSIX 0600），拒绝符号链接。

私有配置字段：`storageId`、`cacheRoot`、`ocrJournalRoot`、`keywordLocalRoot`、`r2`、`r2Credentials`、`resultDatabase`、`reviewDatabase`。结构与视觉入口的存储/数据库配置一致，**没有 codex 配置或账号依赖**。数据库建议结果只读、Review 仅 SELECT/INSERT。

角色 `ocr-keywords`、能力 `ocr.keywords`，契约版本 1；兼容标识由固定首版关键词策略指纹生成。`node dist/keyword-worker.js --list` 获取运行所需 buildId/compatibility，仅列元数据，不连接任何服务。

Activity `screenImageKeywords(OcrRegistration)`：

1. 复验原图、OCR 结果、完成凭证及结果登记。
2. 使用确定性首版策略筛选，**不调用 OCR 或 Codex**。
3. 私有 journal 保留，再原子发布 `v3/keywords/<OCR operation>/<policy fingerprint>.json`，回读核验。
4. 返回命中/未命中、原图/来源引用、命中词和证据 key，不返回 OCR 全文，不自行调下游。

已发布重投只读；未命中也保留证据。上游未验证、内容冲突、发布未完成进入分类 Review，不伪装成未命中。Review 持久化失败则 Activity 非重试失败，不伪报成功。原始数据与本机 journal 不自动删除。

产品多图编排由 `packages/v3-product` 提供，等待由 Workflow 承担。当前关键词入口已在隔离真实 Temporal/临时 PG 中用独立子进程验证；未部署 Railway/Mac 常驻服务，未做关键词入口的真实 R2 专项。
