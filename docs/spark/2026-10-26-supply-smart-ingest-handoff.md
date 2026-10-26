# 给 Supply Smart（supply-smart-mono）的接口任务：品牌原料与临床试验的定时推送（KAN-208）

2026-10-26。用户定的：爬虫这边的定时任务已上线（Server 一，周二、周五 19:00 美中），但只出文件，什么都没推。
要在 supply-smart-mono 里把接收接口写好，爬虫再接上推送（爬虫第四阶段）。这份文档是给 supply-smart-mono 那边的 session 的任务说明。

背景文档（爬虫仓库，只读参考）：
- 总方案：`docs/spark/2026-10-26-branded-ingredient-refresh-plan.md`（§2.6、§2.7、§4 是接口草案）
- 第一阶段实现：`tools/ingredient-intel/`（README.md 有文件格式），临床试验采集：`tools/clinical-trials/`
  （交付格式的 zod 定义在 `src/deliver/contract.mjs`，它是 supply-smart-mono
  `packages/product-db/src/clinical-trial-import.ts` 的副本，另加了还没有导入器的 `IngredientLinkSchema`）

## 1. 现状（supply-smart-mono origin/dev）

- 品牌原料的数据是 10-16 用一次性脚本 `packages/product-db/scripts/import-ingredient-intel.ts` 导进测试库的
  （迁移 `0077_ingredient_intel.sql`）：1,275 个 `branded_ingredient`，14,600 条 `branded_ingredient_ingredient`
  （品牌原料 ↔ Supply Smart `ingredient`），`ingredient_trial` / `clinical_trial` 是 supplier-intel 的试验结果。
- 临床试验另有 KAN-217 的导入：`packages/product-db/scripts/import-clinical-trials.ts`（迁移 0079，`company_trial`、
  `product_trial`，共用 `clinical_trial`），由人手工跑，读爬虫的交付文件夹。
- Regulatory 已经有服务 key 推送接口 `regulatory.ingest`（迁移 0080，`regulatory-dao.ts` 等），是本任务要照着做的样板。
- `branded_ingredient_ingredient` 没有来源、首次出现时间、撤销标记，没法增量维护。

## 2. 要做的接口（全部只允许服务 key，不进 `WEB_PRODUCT_DATABASE_ALLOWED_PROCEDURES`）

调用方式和 `regulatory.ingest` 一样：`POST {HOST}/api/database/rpc/<router>/<procedure>`，`x-api-key`，body `{"json": ...}`。
每次调用一个事务；支持 `dryRun`；同一 `runId` 下 `batchId` 唯一，同内容重发返回 duplicate、内容不同返回 409
（指纹规则照 regulatory）；有同步记录表（类似 `regulatory_sync_run`）。

### 2.1 `brandedIngredient.ingest`（这次只做两种记录，其他 kind 一律 400）

| kind | 自然键 | 字段 | 语义 |
|---|---|---|---|
| `alias_link` | (external_key, ingredient_id) | action `add`/`remove`，method `rule`/`manual`，rules_version，matched_text（原料名），detected_at | add：不存在就插入，`first_seen_at` 只在插入时写；已存在且被撤销过就恢复。remove：标记 `removed_at`，不物理删除；页面和查询只用未撤销的。 |
| `alias` | (external_key, alias) | source `model`/`manual`，reason，decided_by，detected_at | 给已有品牌原料加别名（显示和搜索用）。external_key 不存在 → 这条记 400，整批回滚。 |

- 需要迁移：`branded_ingredient_ingredient` 加 `method`、`first_seen_at`、`last_seen_at`、`removed_at`（已有 14,600 行回填
  `method = 'import-2026-10-16'`、`first_seen_at = created_at`），并在 (branded_ingredient_id, ingredient_id) 上加唯一约束
  （先查测试库有没有重复行，有就报告，别自己删）。
- 别名存在哪里，按 supply-smart-mono 现有的 branded_ingredient 别名字段/表来（先看清楚再决定，写进计划）。
- **不做**新建品牌原料：新原料候选要人工确认后才上（以后再加 `ingredient` kind）。
- 爬虫这边的映射变化文件就是 `runs/<id>/changes/alias_links.jsonl`，每行：
  `{kind:'alias_link', action, ingredient_id, ingredient_name, external_key, method:'rule', rules_version, reason?, detected_at}`。

### 2.2 `brandedIngredient.syncState`（读回，对账用）

分页（cursor）返回：每个品牌原料的 external_key、id、别名；以及全部未撤销的 (external_key, ingredient_id, method, first_seen_at)。
爬虫每次推之前先读回，和本地 `map.json` 对不上就停下报告。

### 2.3 `clinicalTrial.ingest`

把 `import-clinical-trials.ts` 的同一套逻辑包成接口，并加上品牌原料关联：
- 一次调用带若干个试验（≤ 200 个）连同它们的全部关联：`trials[]`（TrialRecordSchema）、`companyLinks[]`、`productLinks[]`、
  `ingredientLinks[]`（爬虫 `tools/clinical-trials/src/deliver/contract.mjs` 的 IngredientLinkSchema：nct_id, branded_ingredient_id,
  external_key, match_basis, matched_term, matched_field, evidence_quote, role, sponsor_is_supplier, confidence, review_note）。
- 语义和现有导入器一致：批里列出的试验是权威的，这些试验在库里多出来的关联对删除（或撤销），没列出的试验不动。
- 品牌原料关联写进 `ingredient_trial`（缺的列加迁移：match_basis、confidence、evidence 等，按计划定）。supplier-intel 10-16 导入的
  旧 `ingredient_trial` 行怎么处理（保留、标来源），写进计划让用户定。
- 一次交付现在约 3,128 个试验、2,782 条品牌原料关联、940 条公司关联、548 条产品关联；`raw` 字段大，注意请求体大小。

### 2.4 按标签成分查产品

`product.listAdvanced` 现在的 `ingredients` 过滤只查 `product_ingredient`（主成分）。要一个按标签成分（`product.formula_id` →
`formula_ingredient.ingredient_id`）过滤的方式，比如新过滤列 `formulaIngredients`（operator `includes`，值是 ingredient id），
或一个返回 `{ingredientId, mainProducts, labelProducts}` 的只读计数接口。选和现有代码最一致的，写进计划。
用途：爬虫算新原料候选"在多少个产品上出现"。

## 3. 规矩

- 先读 supply-smart-mono 的 AGENTS.md / CLAUDE.md，按那边的规矩做（分支、测试、迁移、提交）。
- 基于 `origin/dev`，worktree 分支 `KAN-208-branded-ingredient-ingest`。
- **先出计划，用户批准后再写代码**：计划里写清楚每个接口的输入输出 schema、迁移、复用 regulatory.ingest 的哪些部分、测试怎么做。
- 不碰测试库数据：不跑迁移、不推送、不部署，除非用户明确同意。只读查询可以（先打印目标库）。
- 接口上线后，不能再对测试库跑 `import-ingredient-intel.ts`（它会删光子表重插，`first_seen_at` 全丢）；在计划里写明怎么防。
- 做完后把最终的接口形状（procedure 名、输入输出 schema、错误码）告诉爬虫这边的 KAN-208 会话，爬虫照着写推送。
