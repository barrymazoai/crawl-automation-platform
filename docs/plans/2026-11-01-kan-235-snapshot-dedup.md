# KAN-235 快照三写去重

## 改动

- `packages/app/src/product-sync/sync-send.ts`：市场同步使用固定的 `crawl-automation:marketplace-sync-v2` 来源名，避开历史固定名及批次 hash 名；同一次同步的标签请求沿用该来源。
- `packages/app/src/product-delivery/delivery-service.ts`：DTC 投递的标签请求沿用批量观测的来源，保持标签、图片和商品字段的现有投递与回读流程。
- `packages/app/src/product-delivery/label-mapping.ts`：变更标签幂等 ID 版本，避免旧 ID 携带旧来源而引起正文冲突。
- 对应 `sync-send.test.ts`、`sync-service.test.ts` 和 `delivery-service.test.ts`：检查同一 listing、采集时间与来源组成一个快照键，且来源不随批次内容变化。

## 验证

运行相关 Vitest 单测和仓库 `pnpm check-types`。没有浏览器流程；不连接数据库，也不清理旧快照。
