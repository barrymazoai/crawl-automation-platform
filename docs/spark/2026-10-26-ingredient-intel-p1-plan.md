# 品牌原料定时更新 · 第一阶段（P1）计划

> 总方案：[2026-10-26-branded-ingredient-refresh-plan.md](2026-10-26-branded-ingredient-refresh-plan.md) §9。
> 状态：**计划，待用户批准后写代码**（2026-10-26）。
>
> 用户已定：
> - 每周两次，和 Regulatory 一样；
> - Luna 做简单判断、Sol 做复杂判断，先用 Server 一 现有的 `gpt-5.6-luna` / `gpt-5.6-sol`，medium，并发 1；
> - 临床试验和品牌原料放在**同一个定时任务**里一起更新；
> - Supply Smart 页面本来就按时间排序，**不改 Supply Smart 的 UI**。

## 1. P1 做什么、不做什么

**做：**
1. 定时任务框架：结构照 `tools/regulatory`。
2. 临床试验增量。
3. 新原料名 → 品牌原料映射。
4. 新 ®/™ 写法分类（Luna），产出候选。
5. 产出要推送的变化文件，并发飞书卡片。

**不做：**
- 不推送：Supply Smart 还没有写入接口，留到 P4。
- 不做论文（P2）、USPTO 和建档（P3）、官网和 Claims（P5）。
- 不写任何数据库，也不改 supply-smart-mono。

## 2. 新原料名从哪里来（2026-10-26 查证）

用户的思路是：先拿最新产品的 ingredients 和 formula。查证结果如下（测试库只读，加上 Supply Smart 接口实测）：

- 测试库里，产品的原料列表（`product_ingredient`）来自爬虫同步时送的 `mainIngredients`；配方行（`formula_ingredient`）来自标签。
  两者都指向同一张 `ingredient` 名字表，新名字第一次出现时就会新建一行。
- 10-16 至今，新建了 5,674 个带 ®/™ 的名字行：4,682 个出现在产品原料列表里，5,604 个出现在配方行里，**没有一个是两边都不出现的**。
- 10-16 之后的新名字不只来自新产品。只看"新建产品"会漏掉老产品重新抓取后带来的新名字：例如 link-monitor 来源的老产品
  在这段时间带来了 12,360 个新名字行。另外，爬虫同步台账 `product_sync` 上周有 42k 行更新，大多数只是价格之类的变化，
  拿它当触发条件太粗。

**所以取法是：以"新出现的名字"为准，再查回使用它们的产品。** 这和"拿最新产品的原料和配方"效果一样，而且不漏、不多。

1. `ingredient.listAll`：一次调用拿到全部名字（实测 212k 行，56 MB，28 秒），每行带 `createdAt`。
2. **映射每次全量重算**：用当前全部别名去匹配全部名字，再和上次的映射对比，只输出变化。
   这样即使以后新确认了一个品牌原料、别名变多了，老名字也会被补上。
3. **只为"上次之后新出现、带 ®/™、又对不上现有别名"的名字查产品**：用 `product.listAdvanced` 的原料 id 筛选拿到产品、品牌和数量；
   每次运行抽前几个产品调 `product.getDetail`，拿配方行原文作为模型的上下文。只出现在配方行里的名字（约 1 千个），
   名字本身就是整行标签文字，直接作为上下文。

以上接口都已经用服务 key 实测能调（`test.supplysmart.net`）。

### 2.1 先复用当时的判断，模型只处理没见过的写法（用户 2026-10-26 问）

**当时怎么判断是真的品牌原料（三层）：**
1. 模型分类：Codex 当时用 gpt-6.1-sol medium，读每个 ®/™ 写法和最多 5 段标签上下文，分成 6 类，只保留 `supplier_ingredient`
   （原料公司卖给多个品牌的原料）。共判过 4,731 个写法：supplier_ingredient 2,282、product_brand_own 1,438、unsure 379、
   company_or_brand_name 307、fragment_or_noise 215、certification_or_packaging 110。
2. USPTO 商标权利人：1,275 个里，权利人是原料公司的 919 个、查不到的 232 个、是成品品牌的 21 个、是个人的 3 个。
3. 供应商官网：模型去官网核实，权利人不符或只是某个品牌自己的名字时，写 `ownership_note`。

**这些判断记录只在 MacBook 的 `supplier-intel` 里**，Server 一 上没有。测试库里也只有通过的那部分（1,275 个原料、别名，
以及 14,600 条"名字 → 品牌原料"），被否掉的 1,438 个品牌自有名等判断不在测试库里。所以 §6 要把 `classified.jsonl`
（含否掉的）整份迁到 Server 一。

**复用是按写法，不是按整个名字：** Supply Smart 只在名字是新字符串时才新建一行，所以新名字几乎不会和老名字完全相同
（10-16 之后 5,595 个新的带标记名字里，规范化后和已映射名字完全相同的只有 1 个）。真正能复用的是 ®/™ 旁边那个词：

| 10-16 之后 5,595 个带 ®/™ 的新名字 | 个数 | 处理 |
|---|---|---|
| 标记词命中现有别名 | 3,674（66%） | 直接映射，不用模型 |
| 标记词全部是当时判过的写法 | 816（15%） | 沿用当时的判断，不用模型（其中 390 个当时判为品牌自有名） |
| 至少有一个没见过的标记词 | 1,082（19%） | 只把没见过的词交给 Luna |

**长名字也不用整句去判断：** 程序先把 ®/™ 前面的词抽出来，例如 "Tocotrienols (as DeltaGOLD® containing 90% …)" 抽出
"DeltaGOLD"，再查别名和历史判断。只有没见过的词才交给 Luna，整行名字作为上下文一起给。没有任何 ®/™、
也对不上别名的长名字，和当时的做法一样不进候选。

补课量：没见过的标记词约 925 个（去掉 DRcaps、VeganCaps 这类胶囊和认证词以后会更少），约 18 次 Luna 调用；
之后每次运行约几十个。当时判为 `unsure` 的 379 个写法不重复问，只有在新产品里又出现 2 次以上时才再判一次。
当时判为 supplier_ingredient、但现在不在任何品牌原料别名里的写法（这次有 175 个名字命中），单独列出来人工看。

### 2.2 判断缓存与对比机制（用户 2026-10-26："做成缓存或对比机制，避免大量重复处理"）

三份本地文件，放在 `~/ingredient-intel-data/state/`，原子写入，写法照 Regulatory 的 `lib/store.mjs`：

| 文件 | 键 | 内容 | 什么时候重算 |
|---|---|---|---|
| `verdicts.jsonl`（写法判断缓存） | 规范化后的写法（小写，去掉非字母数字，和当时的 `key()` 相同） | class、canonical、对应的 external_key、供应商、来源（`supplier-intel-2026-10-15` / `luna:<run-id>` / `manual`）、模型和 effort、prompt 版本、判断时间、见过的次数、最多 5 段上下文 | **不会自动过期**。只有两种情况重判：`unsure` 在新产品里又出现 2 次以上；你手工改了（`manual` 优先于模型）。prompt 改版也不批量重判，除非明确执行 `--redo-class` |
| `names.jsonl`（名字结果缓存） | Supply Smart `ingredient.id` | 名字、`createdAt`、结果（对上哪个品牌原料，或者没对上及原因）、规则版本 | 名字的 id 对应的文字不会变，所以每个名字只处理一次。只有别名表或规则版本变了，才对全部名字本地重跑一次（纯程序，几秒，不用模型） |
| `map.json`（上次映射） | ingredient.id → external_key | 上次输出的映射 | 每次和新结果对比，只把**差异**写进 `changes/alias_links.jsonl`（P4 起只推差异） |

**每次运行的查找顺序（从便宜到贵）：**
1. 名字缓存：老名字直接跳过。
2. 别名索引：用的是已通过的品牌原料，每次先从 Supply Smart 读回别名，以测试库为准。
3. 写法判断缓存：包括当时否掉的写法。
4. 都没有命中，才交给 Luna。同一次运行里，同一个写法出现在多个名字中也只问一次；每批答案马上写回缓存，中途失败也不会重复问。

首次补课时，5,595 个新的带标记名字里，前三层能解决约 81%，只剩约 925 个写法交给模型。之后每次运行只看水位线之后的新名字，
缓存会越来越大，命中率也会更高。

同样的做法在后面的阶段继续用：P2 论文按 `paper_key` 加正文哈希加 prompt 版本缓存阅读结果，同一篇论文不读第二次；
P3 的 USPTO 查询按请求内容缓存响应。

## 3. 每次运行的步骤（`src/sync.mjs`，crontab 周二、周五 19:00 美中）

| 步 | 做什么 | 产出（`~/ingredient-intel-data/runs/<run-id>/`） |
|---|---|---|
| 0 | 加文件锁；读状态（品牌原料登记表、别名规则、已分类写法、上次映射、水位线） | — |
| 1 | **试验**：用子进程调用已有的 `tools/clinical-trials`：`collect --mode incremental`，然后 `deliver`（数据目录 `~/clinical-trials-data`）。不复制它的代码 | 它自己的 `deliveries/<run-id>/`，本步记录计数和路径 |
| 2 | **映射**：`ingredient.listAll` → 全量规则匹配 → 和上次对比 | `changes/alias_links.jsonl`（新增和取消，§4 的 `alias_link` 格式） |
| 3 | **新写法**：新名字里带 ®/™、又对不上的 → 抽出写法（移植 `marked_tokens.py` 的规则）→ 去掉已分类过的 → 查产品和品牌 | `candidates_input.jsonl` |
| 4 | **Luna 分类**：每 50 个写法一次，口径同 `tasks/candidates.md`，结构化输出；校验返回的写法确实在输入里 | `changes/candidates.jsonl`；已分类库追加 |
| 5 | 汇总：`last-sync.json`、`summary_text`，发飞书卡片（照 Regulatory：紫色是总结，红色是问题）；水位线前移 | — |

- 任一步失败只记录，不影响不依赖它的步骤（试验失败不影响映射）。水位线只在该步成功时才前移。
- 另加每日超期检查（照 `check-sync.mjs`，超过 102 小时就发红卡）。

## 4. 别名匹配规则（从 supplier-intel 移植，不改口径）

来源是 `scripts/ss_ingredient_match.py`，也就是 10-16 生成那 14,600 条映射时用的规则：
- 每个品牌原料的全部别名加 canonical 名字，统一规范化（小写，去掉非字母数字）后匹配。
- 短别名（不超过 3 个字母且不含数字）、只在带标记时才算的别名、其他原料通用名里的词：只有后面紧跟 ®/™/(R)/(TM)，
  或者在原文里是整词大写（NEM、LGG、ZMA）时才算。
- 原来那 100 个原料保留审核过的别名；`ribose`、`spectra`、`s7` 必须带标记。
- 菌株代码要同时出现菌种名。

**验收：** 用这套 Node 规则对 10-16 的名字重跑，结果要和 `ss_ingredient_brand_map.csv`（14,603 行）一致；有差异就逐条列出，
先改到一致再往下做。

## 5. 复用什么、新写什么

| 用途 | 做法 |
|---|---|
| Supply Smart 调用 | 照 `tools/clinical-trials/src/supply-smart.mjs`（`@orpc/client`、`p-throttle`、`zod`），加 `ingredient.listAll`、`product.listAdvanced`（原料 id 筛选）、`product.getDetail` |
| Codex | 复用 `tools/regulatory/src/lib/codex.mjs` 的 `codexJson`：显式传模型和 effort，Codex 报告的模型不符就拒收。导入方式照 `tools/notify/feishu.mjs` 的共享做法，不复制一份 |
| 飞书 | `tools/notify/feishu.mjs` |
| 日志、锁、命令行 | `pino`、`proper-lockfile`、`node:util` 的 `parseArgs`（和 Regulatory 相同） |
| 多别名匹配 | `modern-ahocorasick`（npm，有 TS 类型，同时提供 ESM 和 CJS）：先对规范化后的文本找出所有别名命中，再按 §4 的上下文规则过滤。理由：212k 个名字 × 约 5k 个别名，逐个跑正则太慢 |
| 新写的 | `tools/ingredient-intel/`：自己的 `package.json` 和 lockfile；`src/sync.mjs`、`src/names.mjs`（映射和写法）、`src/classify.mjs`（Luna 分类）、`src/check-sync.mjs`、`README.md` |

## 6. 状态迁移（MacBook → Server 一，scp，不进 git）

从 `~/Documents/supplier-intel` 只带这些：
- 品牌原料登记表：由 `dataset_all.json` 和 `ingredients_ss.csv` 导出成 `registry.json`，包括 external_key、名字、别名、规则标记。
  测试库现有 1,275 个，导出后先和接口读回的列表对一遍。
- `input/aliases_extra.csv`。
- 已分类写法：`out/candidates_*/classified.jsonl`，共 4,731 行。
- 基线映射：`out/label/ss_ingredient_brand_map.csv`。

**16 GB 的 raw 不搬。** 导出用一个可以重复跑的命令（`src/import-supplier-intel.mjs`），不写一次性脚本。

## 7. 首次运行（补课）

- 水位线从 2026-10-16 开始。预计：映射新增约 3,600 个名字（之前粗算），先复用历史判断（§2.1），剩下没见过的标记词约 925 个，约 18 次 Luna 调用。
- 试验：`tools/clinical-trials` 从没跑过，要先做一次 `backfill`：约 610 页，**归档约 6.4 GB**。跑之前先看 Server 一 磁盘，
  不够就先不做试验这一步，单独问你。
- 全部只出文件和卡片，不推送。

## 8. 验收

1. Node 版规则重跑 10-16 的映射，结果和 14,603 行一致，差异逐条说明。
2. 在 Server 一 手动跑一次完整的 dry run：
   - 试验增量和 deliver 完成，交付文件通过它自带的契约校验；
   - 映射新增数和候选写法数与估算在同一量级；
   - 抽 30 条映射、30 条分类结果人工核对；
   - 飞书卡片发出。
3. `pnpm` 检查通过，跑完后做一次独立代码审查。
4. 验收通过后，crontab 由你确认再装（生产机器上的定时任务）。

## 9. 风险

- Server 一 磁盘（试验归档 6.4 GB，加每次 56 MB 的名字表）：名字表只保留最近两份，用 gzip 存。
- 规则移植有偏差 → 用 §8 第 1 条的逐行对比来把关。
- `ingredient.listAll` 体积会随名字增长：现在 28 秒，可以接受；以后太大了，再请 Supply Smart 加按时间分页的接口。
- Codex 额度：首次约 30 次 Luna 调用，之后每次 1～2 次；时间排在 Regulatory 之后一小时。

## 10. 实现情况（2026-10-26，代码在 `tools/ingredient-intel/`，还没提交）

和计划不一样的地方：
- **不单独存"名字结果缓存"**：全部 21.3 万个名字每次重新匹配一遍只要约 1 秒，所以每次都全量重算，再和 `map.json` 对比，
  只输出差异。"哪些名字已经处理过"改用 `seen-names.json.gz`（以 10-16 导出的 164,954 个 id 为起点）；名字里还有写法在等判断的，
  不记为已处理，下次接着处理。
- **旧判断按标准名对回登记表**：10-15 早期几批分类时，大部分原料还没建出来，所以很多旧判断没有 existing_id。现在按 canonical
  名字对回登记表；名字已经通过别的写法连上的，就不再处理（这次有 89 个）。
- 写法判断缓存、按产品查品牌数、"拿不准的写法在 2 个以上产品出现才重问"都按计划做了。

本机验证（只读 test.supplysmart.net，结果写在 scratchpad）：
1. 规则移植：10-16 的 164,954 个名字 → 14,600 条映射，和 Supply Smart 导入的**逐条一致，0 差异**。
2. 映射：213,468 个名字，10-16 之后新出现 48,722 个；映射 14,600 → 19,375（新增 4,775，取消 0），9 秒。
3. 写法：新写法 2,488 个，其中现有别名 833、沿用旧判断 470、要问模型 1,185（24 批）；
   旧判断里 89 个已被覆盖、28 个待人工看、4 个是新原料候选。
4. Luna（`gpt-5.6-luna` medium）试跑 1 批：50 个全部有回答，用了 45.6k token、约 3 分钟；人工抽查结论合理；
   新增 2 个别名（Cran d'Or、ERr 731），映射随之多了 2 条。

还没做：在 Server 一 跑完整的一次（含试验）、独立代码审查、crontab。
