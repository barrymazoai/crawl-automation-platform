# 旧 DTC 已使用 Ego：版本核对

2026-10-03，CRAWLV3-183 / 151。用户纠正的是旧完整采集流程早已使用 Ego，不能用后来新 Worker 的 Ego 接入情况回答。

## 已核实的版本线

| 时间（北京） | 代码 | 事实 |
| --- | --- | --- |
| 2026-09-28 09:40 | `2417085` | 旧 DTC node 支持 macOS，`tools/dtc-ego-bridge` 用 Ego TaskSpace 提供旧 worker_cdp 所需接口；仍调用 DtcLegacyCapture。 |
| 2026-09-28 11:05 | `20b09db` | 修正旧 capture 的 macOS sandbox 到本机浏览器接口的连接；没有重写采集方法。 |
| 2026-09-28 12:00 | `39169c2` | 合并 `feat/dtc-server2-ego` 到主线，提交说明为 DTC 在 Server 二通过 Ego Lite bridge 运行。 |
| 旧部署 | `b891f0d` | 已有部署记录指向 Server 二 `/Users/server2/apps/crawler-dtc/source`。本次 Git 对比确认，`39169c2` → `b891f0d` 的 `apps/v3-workers/src/dtc-legacy-capture.ts` 与整个 `crawl-products/` 无差异。 |
| 2026-09-30 | `5e3565b` / `723ade4` | 新 DTC adapter 引入共享 Shopify / WooCommerce / JSON-LD 读取器，接入新 Browser Worker；与旧 DtcLegacyCapture 调 Codex 执行完整采集 skill 是不同的实现。 |
| 2026-10-02 | `92d4cb3` | 后来恢复 Codex 自主采集并改走 Ego 原生 skill；这是另一轮改造，不是旧 DTC 第一次改 Ego。 |

旧 DtcLegacyCapture 调用模型执行完整 skill、runHarvest、站点 hooks 和浏览器补采；输出单个基础商品的 fields、全 variants、全 gallery、pageHtml、coverage、flags。其方法 profile 单独保存，采集不做 OCR 或最终 enrich。当前存档入口在 `archive/apps/v3-workers/src/dtc-legacy-capture.ts`。

另已确认 `b891f0d` → `fb0e886` 的 `crawl-products/` 无差异。`fb0e886` 只能称为后来的“原生 skill 恢复前”版本，不能称“Ego 接入前”。这些是代码和历史部署记录核对；本轮没有访问服务器或重跑旧版，不能据此声称旧版所有商品都正确、所有 profile 都有效。

## 对本次修复的约束

此前将 `92d4cb3` 作为用户所指旧版起点、将 9 月旧版仅列为次要追溯来源的判断撤回。以 9 月 28 日已接 Ego 的旧采集行为和输出为基准，对照后来新增的交接要求；继续复用现有 Ego 原生接口、原件归档和精确清理，不重建桥或再次做 Chrome → Ego 迁移。

后续顺序保持：旧采集独立输出 → DTC 采后混合变体判断 → 固定数据转换 → 既有 Facts / 商品处理。真实成功脚本与方法 profile 的复用情况、混合分支输入以及转换兼容仍待实现和验收，本次核对不将这些标为完成。
