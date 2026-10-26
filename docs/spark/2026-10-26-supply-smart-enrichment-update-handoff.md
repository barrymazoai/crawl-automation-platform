# 给 Supply Smart（supply-smart-mono）的接口任务：更新已有产品的剂型、功效、主成分

2026-10-26。用户定的：不改现有的 `labelObservation.ingest`，在 Supply Smart 新加一个接口，专门更新已经入库产品的
剂型（form）、功效（health function）和主成分（product_ingredient）。这份文档是给 supply-smart-mono 那边 session 的任务说明。

## 1. 为什么要这个接口

- 爬虫的产品补全升级到 product-enrichment/4：功效从整句（"support optimal protein synthesis and recovery"）改成短类别名
  （"Muscle Recovery"），剂型补全了 caplets、soft chews、drink mix 等写法，原来没送的推断功效也送了。约 4.9 万个已入库产品要更新。
- 重发 `ingest` 走不通：同一个 `operationId` 换了请求体就返回 `idempotency_conflict`（10-26 验证时 83 行里 33 行如此；
  Whole Foods 从 10-17 起也已有 770 行同样的失败）。用户不想改 `ingest` 或爬虫的 operationId 规则，以免引出新问题。
- `enrichProduct` 对 form / health function / ingredient 只追加（onConflictDoNothing），旧的错误剂型（如 Maxi Health Yummie Calm
  的 Tablet|Chewable）和旧的整句功效都删不掉。
- 现在的 `removeProductHealthFunction` 只能一条一条摘，剂型和主成分没有对应的批量方式；`deleteHealthFunction` 在测试库是
  级联删除（`product_health_function` 外键 ON DELETE CASCADE），爬虫绝不调用。

## 2. 要做的接口（只允许服务 key，不进 `WEB_PRODUCT_DATABASE_ALLOWED_PROCEDURES`）

调用方式和现有服务 key 接口一样：`POST {HOST}/api/database/rpc/product/<procedure>`，`x-api-key`，body `{"json": ...}`。

### 2.1 `product.updateEnrichment`

一次调用改一个产品，一个事务；支持 `dryRun`（默认 false 即可，爬虫自己先预览）。

输入（字段名可按 supply-smart-mono 习惯调整，写进计划）：

| 字段 | 类型 | 语义 |
|---|---|---|
| `productId` | uuid | 必须存在，否则 404 类错误（不要当成功）。 |
| `add.productForm` | string \| null | 和 `enrichProduct` 一样 findOrCreate（不区分大小写匹配已有 form），挂到产品上；已挂着就不动。 |
| `add.healthFunctions` | string[]（≤ 30） | 同上，findOrCreate health function 后挂上。允许新建名字。 |
| `add.mainIngredients` | EnrichIngredientSpec[]（≤ 50） | 和 `enrichProduct` 的 `ingredients` 同一套解析（name / substance / form / category）。 |
| `remove.forms` | string[] | 按名字（不区分大小写、空白归一）找到产品上**已挂着**的 form，摘掉链接。没挂着的忽略。 |
| `remove.healthFunctions` | string[] | 同上，只摘 `product_health_function` 链接。 |
| `remove.mainIngredients` | string[] | 同上，只摘 `product_ingredient` 链接（按 ingredient 名字）。 |
| `dryRun` | boolean | true 时只算结果不写。 |

规则：
- **只摘链接，绝不删除** form / health_function / ingredient 本身的行。
- 同一个名字同时出现在 add 和 remove：以 add 为准（保留）。
- 幂等：同样的调用第二次应当什么都不改，返回全是 unchanged。不需要 operationId，也不进 ingest 的请求台账。
- `remove` 里的名字由爬虫算（爬虫以前给这个产品送过、这次不再送的名字），Supply Smart 不用判断来源；人工录入或旧导入的、
  爬虫没送过的名字爬虫不会放进 remove。
- 不碰产品的其他字段（名称、公司、配方、listing、图片）。

输出：

```json
{
  "productId": "…",
  "dryRun": false,
  "forms":           { "added": ["Tablet"], "removed": ["Chewable"], "unchanged": [] },
  "healthFunctions": { "added": ["Muscle Recovery"], "removed": ["support optimal protein synthesis and recovery"], "unchanged": [] },
  "mainIngredients": { "added": [], "removed": [], "unchanged": ["Magnesium"] },
  "created": { "healthFunctions": ["Muscle Recovery"], "forms": [], "ingredients": [] }
}
```

`added` / `removed` 填 Supply Smart 里实际的名字（大小写以库里为准）；`created` 是这次新建的行。

### 2.2（可选）批量版本

如果方便，加一个 `product.updateEnrichmentBatch`：`items[]`（≤ 100 个上面的输入），每个产品各自一个事务，返回每个产品的结果或错误，
一个失败不影响其他。不方便就只做 2.1，爬虫逐个调。

## 3. 规矩

- 先读 supply-smart-mono 的 AGENTS.md / CLAUDE.md，按那边的规矩做（分支、测试、迁移、提交）。
- 基于 `origin/dev`，worktree 分支例如 `crawler-enrichment-update`。
- **先出计划，用户批准后再写代码**：计划里写清楚 schema、复用 `enrichProduct` 里哪些 findOrCreate、名字匹配规则、测试怎么做。
- 预计不需要迁移；如果需要，写进计划。
- 不碰测试库数据：不跑迁移、不部署，除非用户明确同意。只读查询可以（先打印目标库）。
- 做完后把最终接口形状（procedure 名、输入输出、错误码）告诉爬虫这边（爬虫仓库 worktree `bs-product-data-quality`），
  爬虫照着接：已入库产品的 enrichment 更新改走这个接口，不再重发 ingest。

## 4. 爬虫这边接上后会怎么用（参考，不用 Supply Smart 做）

- 对每个已入库、已有 /4 补全的产品：`add` = 当前补全要送的剂型、功效（印的，没有就推断的）、主成分；`remove` = 以前的补全送过、
  这次不送的名字。按 Supply Smart 产品 ID 分页，先 dryRun 抽查，再真跑。
- 爬虫现有的 `productSync.cleanHealthFunctions`（逐条 `removeProductHealthFunction`）会被这个接口取代。
- 没有任何产品再用的功效名（约 4.6 万个整句名）由 Supply Smart 自己清理，爬虫不删。
