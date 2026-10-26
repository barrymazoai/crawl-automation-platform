# 品牌原料（Branded Ingredient）定时自动更新方案（KAN-208 后续）

> 状态：**方案，待用户拍板**（2026-10-26）。本轮只出方案：没有改代码、提交、部署，也没有写任何数据库。
> 查数只读：Supply Smart 测试产品库 `shortline.proxy.rlwy.net:56429/railway`，会话设为 `default_transaction_read_only=on`。
> 另读了 `~/Documents/supplier-intel`，以及 supply-smart-mono `origin/test` 上的 `ingredient-intel-schema.ts`、
> `import-ingredient-intel.ts`、`docs/spark/2026-10-13-ingredient-intelligence-data-model.md`、`regulatory-ingest.md`。

## 0. 结论

1. **可以做成和 Regulatory 一样的定时任务。** 每周两次（用户 2026-10-26 定：和 Regulatory 一样），跑在 Server 一（crontab），用 Supply Smart 服务 key 调一个**新的
   `brandedIngredient.ingest` 接口**推到**云端测试库**，推送前先 dry run，结果发飞书卡片。只推增量，不再整份重导。
2. **"新品牌开始用某个原料"不用爬。** 测试库里已经有 `product_ingredient` → `branded_ingredient_ingredient` → 品牌原料的链路
   （现在 1,204 个品牌原料连着 20,909 个产品、1,946 家公司）。由 Supply Smart 在库里直接算就行，爬虫只负责补
   "原料名 → 品牌原料"的映射。
3. **现在已经有一个缺口，和定时任务无关：** 映射是 10-16 一次性做的。10-16 之后测试库新增了 47,520 个 `ingredient`
   名字，其中 5,595 个带 ®/™。粗算约 3,600 个能对上已有品牌原料的别名（比如 BioPerine、FloraGLO、Reducose、Aquamin），
   但都还没进映射，所以这些产品**不会出现在原料页上**。另有约 1,500 个没见过的带标记写法，需要分类（比如 Slimbiotics、
   CaloriBurn GP、ProGBB、CyanthOx）。第一次运行要先把这段补上。
4. **Supply Smart 必须先改两件事，"最近的新东西"才查得出来：**
   (a) 现在的导入器每次都把子表**删掉重插**。测试库里 13 张表的 `created_at` 全在 10-13～10-18，当不了"首次发现时间"。
   每条记录要有一个在 upsert 时保留下来的 `first_seen_at`，加上"基线"标记。
   (b) 新增 ingest 接口（契约见 §4；页面不改，见 §5）。我们不改 supply-smart-mono，这部分要 jakarta 那边做。
5. **哪些步骤要模型判断：** 写法分类、论文是否是这个品牌原料本身的人体研究，以及新原料的供应商建档。
   这几步当时都靠 Codex（gpt-6.1-sol，medium）。检索、增量、去重、对账、映射这些可以全部用程序做。**模型已定（2026-10-26）：简单的用 Luna，复杂的用 Sol（§8 第 2 条）。**

## 1. supplier-intel 一次性流程拆解（10-13～10-16）

总量：测试库现有 branded_ingredient 1,275、ingredient_trademark 2,066、ingredient_study 8,386、research_paper 7,109、
supplier_cited_study 6,796、clinical_trial 3,862（ingredient_trial 2,386）、distributor 333（ingredient_distributor 800）、
regulatory_filing 303、branded_ingredient_statement 10,205、branded_ingredient_ingredient 14,600、
ingredient_label_use 11,799。当时由 Codex 读过的论文约 11,316 篇次，分类过的 ®/™ 写法约 4,731 个。

| # | 步骤（task / script） | 数据来源 | 产出 | 能否程序化 | 当时靠模型的部分 |
|---|---|---|---|---|---|
| 1 | 收集候选写法 `marked_tokens.py` / `ss_marked_candidates.py` | Server 一 标签语料（OCR 62k、网站文字 5.9k、旧库配方 36.7k），以及 Supply Smart 165k 个 ingredient 名 | 3,622 + 398 个带 ®/™ 的写法，附上下文 | **能**（正则加规则，排除认证、胶囊词） | — |
| 2 | 写法分类 `tasks/candidates.md` | 上一步的写法和标签上下文 | supplier_ingredient / 产品自有名 / 认证包装 / 公司名 / 噪声，以及 canonical、供应商猜测 | 已分类过的写法可以直接复用 | **要模型**：判断是不是"供应商卖给多个品牌的原料" |
| 3 | 合并与计数 `candidate_list.py` / `merge_new.py` | 分类结果 | 908 + 398 个品牌原料、别名、产品数 | **能** | — |
| 4 | USPTO 商标 `tasks/uspto*.md`、`uspto_via_server.py` | tmsearch 后端（类 1/5/29/30/32） | 商标、权利人；判断权利人和供应商是否一致 | 检索**能**（MacBook 被封，只能走 Server 一，每 3 秒 1 次） | 判断权利人是不是供应商、统一供应商名（部分要模型） |
| 5 | 供应商官网 `tasks/suppliers*.md` | 官网产品页、规格书 PDF、science 页 | 剂量、标准化、声明、认证、引用研究、公司信息、经销商 | **很难**：每个网站结构不同 | **要模型 + 联网浏览**（最贵的一步） |
| 6 | PubMed / Europe PMC `tasks/pubmed*.md` | E-utilities（有 key）、Europe PMC（含全文检索） | 784 个原料共 79,944 条论文行，其中品牌命中 6,693 行 | **能**（`collect.py`、`finalize.py` 的歧义规则） | — |
| 7 | PubMed 以外的文献 `tasks/lit_more*.md` | OpenAlex、Semantic Scholar、Crossref，以及供应商引用研究的解析 | 候选论文、cited_resolved | 检索和解析**能** | 少量判断 |
| 8 | 读论文 `tasks/pubmed_extract*.md`、`lit_more_extract.md` | PMC 全文 XML 或 PDF、摘要 | 是否人体临床、研究产品是否含该品牌、设计、n、剂量、结论、资助方，每项附原文引用 | 下载和定位引文页码**能**（`locate_quotes.py`） | **要模型**：逐篇阅读，按规定不许用关键词程序批量填 |
| 9 | 品牌角色 `tasks/study_role.md`、`apply_roles.py` | 第 8 步的结果和全文 Methods 部分 | role / isolates_brand。只有 isolates_brand=true 才计入"Human Studies" | 计数**能** | **要模型**：区分单独成分 / 主成分 / 增效剂 / 各组都有 |
| 10 | 临床试验 `tasks/ctgov*.md` | ClinicalTrials.gov API v2 | 品牌命中的试验、发起方是否为供应商 | **能**（菌株代码要求和菌种同时出现） | 歧义命中才需要 |
| 11 | FDA GRAS/NDI、展会、经销商目录 `tasks/fda*.md`、`market.md` | FDA 清单、展会名录、经销商产品线 | regulatory_filing、展会、经销商 | 清单**能**（Regulatory 爬虫已经在抓 GRAS/NDI） | 名字匹配判断 |
| 12 | 健康功能 `tasks/health_area.md` | 通用名、声明、研究终点 | health_area | — | **要模型**（新原料才需要） |
| 13 | 标签剂量与映射 `label_doses.py`、`ss_ingredient_match.py` | 标签语料、Supply Smart ingredient 名 | label_doses、`ss_ingredient_brand_map.csv` | **能**（别名加标记、大写规则） | — |
| 14 | 导出与导入 `export_for_supply_smart.py` → jakarta `import:ingredient-intel` | `out/final/dataset_all.json` | 写进测试库（直连数据库，整份删除后重插） | 要改成走接口增量推送 | — |

**定时任务里继续要模型的只有 4 处：** 第 2 步新写法分类、第 8/9 步新论文阅读和品牌角色、第 5/12 步新确认原料的建档。
其余都改成程序，按增量运行。

## 2. 定时更新设计

### 2.1 总体

- 代码：爬虫仓库新增 `tools/ingredient-intel/`，结构照 `tools/regulatory`（复用 `lib/http`、`lib/codex`、`lib/supply-smart`、
  飞书 `tools/notify`）。部署走 git clone/pull，不复制旧目录。
- 状态：把 MacBook 上 supplier-intel 的**最小必要状态**迁到 Server 一，用 scp 传，不进 git：
  `dataset_all.json`（58 MB）、已分类写法、原料与别名表、歧义规则、已知论文键。**16 GB 的 raw 不搬**，PDF 已经在 Supply Smart R2 里。
- 每次运行写 `runs/<run-id>/changes/*.jsonl`，内容是新增或变化的记录，各自带 `first_seen_at`。原始响应用 gzip 存，按期清理
  （Server 一 出过两次磁盘满）。
- 以测试库为准：每次运行开始先通过接口读回测试库现有的品牌原料、别名和映射（§4.2），再和本地状态对账。

### 2.2 发现新的品牌原料

三个入口，从便宜到贵：

1. **标签里新出现的名字（主入口，免费）。** 取上次运行之后新增的 ingredient 名，来源有两个：Supply Smart 的 ingredient 名（全渠道），
   以及爬虫 Server 一 的标签文字（带上下文，方便模型判断）。
   - 名字能按现有别名规则（短别名和菌株代码要求同时有 ®/™ 或菌种）对上已有品牌原料的，**直接**生成映射 `alias_link`，不用模型。
   - 对不上的 ®/™ 写法，先去掉已分类过的写法和认证、胶囊、公司词，剩下的交给模型按 `tasks/candidates.md` 的口径分类。
     首次补课预计约 1,500 个写法，之后预计每次运行 50～100 个（随品牌扫描节奏变化）。
2. **已知供应商的新商标（USPTO，免费）。** 每次运行按约 470 个已知供应商的权利人名，在类 1/5/29/30/32 里查"申请日晚于上次运行"的新商标。
   这是"竞争对手有新原料"最早出现的信号，往往比产品上市早几个月。走 Server 一，每 3 秒 1 次，约 30 分钟。
   未知公司的新商标量太大（类 5 每周几千件），不查。
3. **行业新闻（第二期）。** Regulatory 已经在读 NutraIngredients / SupplySide 的 RSS，可以加一个"新原料发布"分类，
   由模型判断标题和摘要，命中后进候选。

新原料的状态：

- `candidate`：先不在页面显示。
- `confirmed`：满足以下任一条件。①模型判为 supplier_ingredient，且至少 2 个产品在用或 USPTO 权利人是原料公司；②你抽查通过。
- 确认后补一份**轻量档案**（供应商、通用名、健康功能、USPTO、文献和试验检索），只用 API 加一次模型调用。
  **完整档案**（官网剂量、标准化、声明、引用研究）作为单独的模型任务排队，频率和范围由你定（§7）。

### 2.3 新研究

**检索（程序，每次运行）：** 每个已确认原料用它的别名查询，只看上次运行之后的窗口：

| 来源 | 增量方式 | 量（1,275 个原料） |
|---|---|---|
| PubMed E-utilities（有 key） | `esearch` 用 `datetype=edat` 加 `mindate/maxdate`（入库日期），再 `efetch` | 约 4～6k 次请求，7 次/秒，约 15 分钟 |
| Europe PMC（含 OA 全文检索） | 查询加 `CREATION_DATE:[上次 TO 今天]` | 约 3～4k 次，≤3 次/秒，约 25 分钟 |
| ClinicalTrials.gov v2 | **复用爬虫仓库已有的 `tools/clinical-trials`（KAN-217）的 `incremental` 模式**，见 §2.7 | 每次几页，几分钟 |
| OpenAlex | `filter=from_publication_date:` 加检索词 | 约 3k 次。**OpenAlex 近来改了 key 和额度政策，上线前要核实** |
| Semantic Scholar | 无 key 的共享池常返回 429 | 建议每月一次，或者申请免费 key |
| 供应商引用研究 | 跟着官网复查（§7 问题 5） | — |

**判断是不是"这个品牌原料本身的人体研究"（三道关）：**

1. **规则预筛（程序）：** 标题、摘要或 OA 全文里有该品牌别名；歧义别名（S7、NEM、LGG、菌株代码、Spectra、ribose）沿用
   `finalize.py` 的上下文规则（220 字内要有菌种、供应商或通用名）；还要像人体研究（Humans MeSH、临床或 RCT 类型，或者摘要里
   提到受试者）。没通过的写进 dropped，留作抽查。
2. **模型阅读：** 只读通过预筛的新论文。读摘要，有 OA 全文时读 Methods 和干预部分，按 `pubmed_extract_new.md` 和
   `study_role.md` 原有的口径给出：is_human_clinical、studies_branded_ingredient（研究产品真的含该品牌，不能只靠供应商名单）、
   设计、n、剂量、结论、资助方，以及 **brand_role / isolates_brand**。每项都要附原文引用。
3. **程序核验：** 引用必须逐字出现在原文里，否则丢弃该字段（Regulatory 已有同样的检查）；用 `locate_quotes` 定位 PDF 页码和矩形框；
   PDF 只取 PMC OA S3 或 OpenAlex 的 OA 链接。**只有 isolates_brand=true 才计入 Human Studies**；
   只出现在供应商名单里、全文又读不到的，算 `supplier_attributed`，不计入主数字（沿用 10-15 的规则）。

量级：测试库里 2022～2026 年读后保留的研究每年约 450 条，其中品牌人体研究约 200 条，品牌本身研究约 150 条。
所以每周约 9 条要保留，送模型阅读的候选预计每周 20～40 篇，每次运行 10～20 篇。

### 2.4 新品牌开始用某个原料（不用爬）

- 在 Supply Smart 库里算：`branded_ingredient_ingredient → product_ingredient → product → company`。
  按（品牌原料, 公司）记**首次关联时间**。是否单独存一张表由 Supply Smart 决定，页面不改（§5）。爬虫只负责补映射（§2.2-1）。
- **要分清"新发现"和"新上市"。** 测试库 148,472 个产品里只有 59,411 个有 `first_seen_at`，34,946 个渠道行有 Amazon
  `listed_at`（Date First Available）。NIH 和旧导入来的产品没有时间。另外 8～10 月爬虫每轮都会"首次看到"上万个老产品，
  映射一补也会冒出大量老关联。所以：
  - 上线日之前的关联一律算**基线**，不算"新"；
  - 上线之后出现的（原料, 公司）关联，再按证据分两类：
    ①**新上市**：产品 Amazon `listed_at` 在近 90 天内，或者渠道 `listing_new` 事件，或者老产品的配方从不含变成含（配方变更）；
    ②**新发现**：其余情况，即我们新抓到或新映射上的。
  - 页面默认只把①当作"新品牌开始使用"，②作为"新收录"单独筛选。

### 2.5 频率与机器

- **每周两次，和 Regulatory 同一天（用户 2026-10-26 定）**：周二、周五 19:00 美中时间，比 Regulatory 的 18:00 晚一小时
  （它约 3 分钟跑完），两边的 Codex 调用不会撞在一起。卡片到群里是北京时间周三、周六早上 8 点（美国 11 月 1 日起改冬令时，
  北京时间各晚一小时：Regulatory 变成 8 点，这条线变成 9 点）。每次只查上次运行之后的窗口，预计耗时：检索约 1 小时，模型部分取决于并发。
  另加每日超期检查（照 `check-sync.mjs`，超过 102 小时没完成一次完整同步就发红卡）。
- **Server 一**：能访问 USPTO，已经登录 Codex，有 crontab 和飞书卡片，也有服务 key 的 env。
  NCBI key 要从 MacBook `.env.ncbi` 复制一份到 Server 一 私有目录，不打印、不进 git。
- 第一次运行做"补课"：10-16 至今的映射加新写法，再查文献和试验一年的窗口。量比平时大，建议分批，并先 dry run。

### 2.6 写进云端测试库

- 只推**测试库**（和 Regulatory 一样），不推本地库和正式库。正式库另行决定。
- 新接口 `brandedIngredient.ingest`，契约见 §4。走服务 key，不直连数据库。上线后**不能再对测试库运行一次性导入器**，
  否则子表又会被删光重插，`first_seen_at` 全部丢失。
- GRAS/NDI 不再由这条线推：Regulatory 已经把它们作为 `regulatory_event` 推上去了，请 Supply Smart 把 regulatory_event 也链接到
  branded_ingredient（复用它已有的 ingredient 匹配），`regulatory_filing` 以后不再更新。

### 2.7 Claims & specs 和 Clinical Trials（用户 2026-10-26 问）

**Clinical Trials：包含，而且不用新写。用户 2026-10-26 定：试验要跟着定时任务一起更新（每周两次）。**
- 爬虫仓库 main 上已经有 `tools/clinical-trials`（8a28f49，KAN-217）。它的 `incremental` 模式读的是"上次之后有更新的全部试验"
  （按 `LastUpdatePostDate`），再加上对 Supply Smart 新增公司和品牌原料的定向检索，所以新登记的试验、状态变化、结果发布都能抓到。
  它输出试验与公司、产品、品牌原料三种关联，其中 `trial_ingredient_links.jsonl` 就是品牌原料 ↔ 试验。
- **现状：** 代码只是随 git 拉到了 Server 一（`~/apps/regulatory/tools/clinical-trials`），**从没在 Server 一 跑过**
  （没有 `~/clinical-trials-data`），也没有 crontab。它的交付方式是生成文件，由 Supply Smart 手工运行 `import:clinical-trials` 导入；
  品牌原料关联那份文件是 KAN-214 的草案契约，Supply Smart **还没有导入器**。
- **方案：** 把它的 `collect --mode incremental` 加 `deliver` 放进同一个定时任务（周二、周五），作为一步运行；首次需要先做一次
  `backfill`（约 610 页、6.4 GB，跑完只保留压缩归档）。交付改成和 Regulatory 一样走接口推送：请 Supply Smart 提供
  `clinicalTrial.ingest`（把现有 `import:clinical-trials` 的同一套逻辑包成服务 key 接口，含品牌原料关联），或者把试验并入 §4 的
  `brandedIngredient.ingest` 的 `trial` 类型。这样试验数据只保留一个来源，不再由 supplier-intel 那份 `ctgov*` 结果更新。
- **为什么要更新：** Robert 要的"新的临床研究"里，新登记的试验是最早的信号，通常比论文发表早 1～3 年；
  已有试验的状态也会变（招募中 → 完成 → 发布结果）。另外，产品页和品牌页上 KAN-217 的试验数据本身也会过期，
  不管 KAN-208 怎么定都要更新。
- **页面：** 原料页的试验面板在 KAN-208 页面精简（10-15）时去掉了，现在试验显示在产品页和品牌页（KAN-217）。
  要让用户在原料页看到"新试验"，原料页要重新显示试验（至少在"最近变化"里显示），需要和 Robert、Supply Smart 确认。
  数据这边两种都能支持。

**Claims & specs：包含，但不在每周两次的检索里。**
- 这些是供应商官网上的句子（声明、认证、标准化、剂量、形态、专利，`branded_ingredient_statement`，现有 10,205 条），
  来自 supplier-intel 第 5 步：模型联网读官网。它们没有可增量查询的公开接口，只能重新读网页。
- **方案：**
  1. 新确认的原料：完整建档时一起抓 Claims（Sol）。
  2. 现有原料：按 §8 第 5 条定的频率复查官网。先用程序比对产品页内容的哈希，页面没变就跳过；页面变了才交给模型重读，
     并把新增或消失的句子作为变化推上去（消失的打 `removed_at`，不删除）。
  3. 顺带修复 10-18 记下的问题：约四分之一的句子引用的是同站别的页面。复查时每句都记录它实际所在的页面 URL。

## 3. 每次运行的流程（伪代码顺序）

1. 读回测试库状态（品牌原料、别名、映射、各类自然键的 `first_seen_at`）→ 与本地状态对账，不一致就停止并报告。
2. 新名字 → 规则映射（`alias_link`）；对不上的写法 → 模型分类 → 新候选。
3. USPTO：已知供应商的新商标，以及候选写法查权利人。
4. 文献和试验增量检索 → 规则预筛 → 模型阅读 → 引用核验 → 品牌角色 → 重算受影响原料的汇总数。
5. 生成 `changes/`，切成 ≤500 条的批次 → 全部 dry run → 没有 400/409 才正式推送 → 读回总数对账。
6. 写 `last-sync.json`，发飞书卡片（新原料、新研究、新试验、新商标、新映射的数量和问题）。
   任一步出问题只记录，不阻塞后面不依赖它的步骤。

## 4. 给 Supply Smart 的接口契约（草案：`brandedIngredient.ingest`）

照 `regulatory.ingest` 的做法：`POST {HOST}/api/database/rpc/brandedIngredient/ingest`，`x-api-key` 用服务 key，
body 是 `{"json": ...}`，只允许服务 key（不进 `WEB_PRODUCT_DATABASE_ALLOWED_PROCEDURES`）。

### 4.1 请求

```jsonc
{
  "run": { "runId": "2026-11-02T07-00-00Z" },
  "batchId": "0001",                // 同 runId 下唯一；同内容重发 → duplicateBatch，内容不同 → 409
  "dryRun": false,
  "records": [ /* 1–500 条，混合 kind */ ]
}
```

每条记录都带 `kind`、自然键、`source_url`、`first_seen_at`（爬虫首次发现的时间），可选 `removed_at`（不删除，只标记）
和 `content_hash`（用来判断是否变化）。

| kind | 自然键 | 主要字段 |
|---|---|---|
| `ingredient` | `external_key`（ING…，新原料继续编号） | name, generic_name, **generic_key**（同一通用原料的分组键，用来找"竞争原料"）, aliases[], health_functions[], status `candidate`/`confirmed`, supplier {name, website, country}, product_page_url, science_page_url, trademark_owner, 汇总数（§4.3）, discovered_via `label`/`uspto`/`news`, evidence[] |
| `statement` | (external_key, kind, text_hash) | kind, text, source_url |
| `alias_link` | (external_key, ingredient_id) | ingredient_id = Supply Smart `ingredient.id`; method `rule`/`model`; matched_text |
| `study` | (external_key, paper_key) | paper {pmid, pmcid, doi, title, journal, pub_date_text, pub_year, pdf_sha256}，研究字段与 `ingredient_study` 相同，brand_role，evidence[] {field, quote, location, section, page, rects} |
| `cited_study` | (external_key, pmid 或 doi 或 normalized title) | title, year, journal, design, listed_on_url |
| `trial` | (external_key, nct_id) | 与 `clinical_trial` 列相同（含 first_posted / last_update / overall_status），sponsor_is_supplier |
| `trademark` | (external_key, serial_number) | mark, status, owner_name, filing_date, registration_date, classes |
| `distributor_link` | (external_key, distributor name) | role, region, evidence_quote, seen_date |

另需 PDF 上传：`brandedIngredient.paperPdfUploadUrl({paperKey, sha256, bytes})`，返回预签名 PUT 地址；
上传完成后 `study.paper.pdf_sha256` 对得上，才设置 `pdf_key`（sha256 相同就跳过）。

### 4.2 读回（爬虫对账用，只读、仅限服务 key）

- `brandedIngredient.syncState({cursor})`：分页返回 external_key、别名、status、各子表的自然键、`first_seen_at`、`content_hash`。
- `ingredient.listSince({createdAfter, cursor})`：新增 ingredient 的 id、name，以及使用它的产品数。如果你不同意加这个接口，
  就继续用只读直连测试库（10-12 的例外），但今天连接断了 3 次，不建议给定时任务用。

### 4.3 语义（照 regulatory.ingest）

- 按自然键幂等 upsert；**`first_seen_at` 只在插入时写，以后不改**，取库内已有值和请求值中较早的那个。
  `last_seen_at` 每次刷新；不在批次里的记录不动、不删。
- 一次调用一个事务；有 dry run；同步记录表（类似 `regulatory_sync_run`），每个 batchId 只计一次（指纹规则相同）。
- paper 合并：DOI 先入库、后来拿到 PMID 的论文，要合并成同一行，不能另建一行（现在的已知问题）。
- 汇总数（branded_human_studies 等）：**建议由爬虫按现有 `apply_roles` 规则算好后随 `ingredient` 一起推送**，
  Supply Smart 原样存。也可以改成由 Supply Smart 从行数据重算（§7 问题 8）。
- 首次推送是"基线"：现有 1,275 个原料的所有行以 `first_seen_at = 原 data_as_of` 推上去，并带 `baseline: true`。

## 5. 页面需求：不做（用户 2026-10-26 定）

Supply Smart 页面本来就按时间排序，新的研究、试验、产品自然排在前面，**不改 Supply Smart 的 UI，也不提页面需求**。
对 Supply Smart 只提写入接口（§4）。接口要保证重复推送时不删掉已有的行、不改变已有的 id，这样页面上的时间顺序和链接才稳定。
（原先这里列的"最近变化"查询、`first_seen_at` 列、列表筛选等页面需求，已经撤回。）

## 6. 成本与风险

**外部 API（都免费，按限速）：** 每次运行 NCBI 约 5k 次、Europe PMC 约 4k 次、ClinicalTrials.gov 约 3k 次、OpenAlex 约 3k 次、
USPTO 约 600 次，总耗时约 1～1.5 小时（每个原料每次都要查一遍，所以请求次数不随频率减半，只是每次的新结果少一半）。
供应商官网不跟着定时任务跑。

**模型用量（走 Server 一 已登录的 Codex，占你的额度）：**

| 用途 | 首次补课 | 之后每次运行（每周两次） |
|---|---|---|
| 新写法分类（每次 50 个写法） | 约 1,500 个写法，约 30 次调用 | 50～100 个写法，1～2 次调用 |
| 论文阅读和品牌角色（每篇一次，摘要加全文 Methods，约 1～3 万 token 输入） | 一年的窗口约 300～500 篇 | 10～20 篇 |
| 新原料轻量建档（每个一次，不联网） | 视确认数量，约 100～300 个 | 3～10 个 |
| 新原料完整建档（联网读官网，最贵） | 按你定的范围 | 按你定的频率 |

**风险：**
- 基线一大批老关联被误当成"新"：靠基线标记，加上"新上市"和"新发现"分开来解决（§2.4）。
- 短别名和菌株代码误连：沿用现有歧义规则，拿不准的交给模型，并抽查 dropped。
- Supply Smart 子表删除重插会让时间字段失效；ingest 上线前不能开始定时推送。
- USPTO tmsearch 是非公开后端，可能改版或返回 429；OpenAlex 和 Semantic Scholar 的政策可能变。都要做降级：
  单个来源失败只记录，不阻塞其他来源。
- Server 一 磁盘：raw 用 gzip 存并按期清理；PDF 推到 Supply Smart R2 后，本地只保留 manifest。
- Codex 额度和其他任务（Regulatory、品牌建档）抢：并发设为 1，错开时间，模型显式传入（照 `codexJson`）。
- 测试库直连不稳（今天 3 次断开）：定时任务只走 API。

## 7. 上线步骤

1. 你拍板 §8 的问题。
2. 在 Plane 建工单（爬虫侧），并把 §4 给 jakarta 那边，由他们在 supply-smart-mono 写正式契约和实现，先部署到 test。
3. 爬虫侧：按阶段出计划，你批准后在 `tools/ingredient-intel/` 实现；把 supplier-intel 的最小状态 scp 到 Server 一。
4. **基线推送**：把现有数据以 baseline 推一遍（先 dry run，再正式推），然后读回总数，和测试库现有行数对账。
5. **补课运行**：10-16 至今的映射和新写法，加文献和试验一年窗口。只用 dry run 出报告，你抽查样本后再正式推。
6. crontab（周二、周五 19:00 美中）先跑 1～2 周纯 dry run（飞书卡片报数），确认后切到正式推送。加每日超期检查。
7. 第二期：新闻 RSS 新原料、供应商官网定期复查、正式库同步（另行决定）。

## 8. 要你拍板的问题

1. ~~频率~~ **已定（2026-10-26）**：每周两次，和 Regulatory 一样；时间为周二、周五 19:00 美中（晚 Regulatory 一小时）。
2. ~~模型~~ **已定（2026-10-26）：简单的用 Luna，复杂的用 Sol，effort 都是 medium，并发 1，模型和 effort 显式传入
   （照 `codexJson`，Codex 报告的模型不符就拒收答案）。**
   - **Luna**：新写法分类、新原料轻量建档（健康功能、通用名、供应商名统一）、试验和 USPTO 的歧义命中、新闻标题分类。
   - **Sol**：论文阅读（字段加原文引用）和品牌角色判断、新原料完整建档（联网读官网）。
   - **先用 Server 一 现有的版本（用户 2026-10-26 定）：Sol = `gpt-5.6-sol`，Luna = `gpt-5.6-luna`**，和 Regulatory 同一套。
     背景：用户原本要用最新的 `gpt-6.1-sol` / `gpt-6-luna`。2026-10-26 实测 MacBook（Codex CLI 0.159.3）能用，
     Server 一（CLI 0.154.0）被拒，返回 `400 model_not_found: not supported when using Codex with a ChatGPT account`。
     以后如果升级 Server 一 的 Codex CLI，再改用最新版；模型名放在配置里，换的时候不用改代码。
3. **新原料是否自动上线**：满足 §2.2 的确认条件就直接显示（带"新"标），还是全部先进候选、等你确认？
4. **新原料建档深度**：先只做轻量档案（建议），完整的官网建档按需排队；还是每个新原料都做完整建档？
5. **供应商官网复查**（Claims & specs 的新句子、新引用研究、新经销商，见 §2.7）：每月、每季度，还是暂时不做？
6. **"新品牌使用"由 Supply Smart 在库里算**（建议），可以吗？`ingredient_label_use` 这张静态表以后不再更新，
   剂量改从产品配方读，可以吗？
7. **新 ingredient 名的来源**：请 Supply Smart 加 `ingredient.listSince` 接口（建议），还是继续只读直连测试库？
8. **汇总数**（Human Studies 等）由爬虫按现有规则算好推送（建议），还是由 Supply Smart 重算？
9. **Semantic Scholar**：每月跑一次，还是申请免费 key 后每周跑？OpenAlex 如需 key，是否申请？
10. Supply Smart 侧由哪个 jakarta 会话或谁来实现 §4？爬虫侧工单要不要现在就建？

## 9. 开工：分阶段计划（用户 2026-10-26："先做"；试验和品牌原料放在同一个定时任务里）

还没拍板的问题先按建议执行：新原料先进候选，满足 §2.2 的确认条件后再显示；先只做轻量档案；"新品牌使用"由 Supply Smart 算；
汇总数由爬虫算；官网复查放到第 5 阶段，频率到时再定。

| 阶段 | 内容 | 依赖 Supply Smart？ |
|---|---|---|
| **P1**（详细计划：[2026-10-26-ingredient-intel-p1-plan.md](2026-10-26-ingredient-intel-p1-plan.md)） | `tools/ingredient-intel` 骨架（照 `tools/regulatory`）：`sync.mjs` 作为定时入口，`runs/<id>/changes`，飞书卡片，超期检查。**试验一步**：子进程调用已有的 `tools/clinical-trials`（`collect --mode incremental` + `deliver`），不复制代码。**原料名一步**：`ingredient.listAll`（已有接口，含 `createdAt`）→ 取水位线之后的新名字 → 别名规则映射（从 `ss_ingredient_match.py` 移植）→ 对不上的 ®/™ 写法交给 Luna 分类 → 候选。从 supplier-intel 迁最小状态到 Server 一。crontab 周二、周五 19:00，**先只出 dry-run 报告，不推送** | 不依赖（只读现有接口） |
| P2 | 文献增量：PubMed（edat 窗口）、Europe PMC（CREATION_DATE）、OpenAlex → 规则预筛 → Sol 读论文 → 引用逐字核验和 PDF 定位 → 品牌角色 → 重算汇总 | 不依赖 |
| P3 | USPTO：已知供应商的新商标；新原料轻量建档（Luna） | 不依赖 |
| P4 | 接 Supply Smart 的 ingest 接口：基线推送 → 补课 → 每次正式推送（试验也走接口） | **依赖 jakarta 实现 §4 和 `clinicalTrial.ingest`** |
| P5 | 供应商官网复查（Claims & specs）、完整建档（Sol，联网） | P4 之后 |

同时把 §4 和试验接口整理成给 jakarta 的交接文档，放在爬虫仓库 docs 里（我们不改 supply-smart-mono）。

**用到的库（按规定先查过）：**
- 沿用 regulatory / clinical-trials 已在用的：`@orpc/client`（Supply Smart）、`p-throttle`、`p-retry`、`execa`（Codex）、`zod`。
- PubMed：npm 上的 `node-ncbi` 最后更新在 2022 年，也没有按入库日期窗口查询的封装，所以在现有 `lib/http` 上写一层很薄的 E-utilities 调用。
- OpenAlex：2026-02-13 起所有请求都要 API key，免费 key 每天 $1 额度，需要用户在 openalex.org 注册一个 key。

**P1 验收：**
1. 在 Server 一 手动跑一次 dry run：试验增量跑完，交付文件通过契约校验。
2. 10-16 至今的新原料名，映射数和候选数和本方案的估算（约 3,600 / 1,500）在同一量级；抽 30 条人工核对。
3. 飞书卡片发出。
4. `pnpm` 检查通过，每个阶段完成后做一次独立代码审查。
