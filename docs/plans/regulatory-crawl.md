# Regulatory 数据采集：首次全量报告（KAN-215）

2026-10-18。代码在 `tools/regulatory/`（用法见其 README），运行在 Server 一（`server@100.76.126.12`），手动启动，未安装定时任务。只写文件，不写任何数据库，不做实体匹配，没有使用 ScraperAPI 或其他付费线路。

## 1. 数据位置

Server 一 `/Users/server/regulatory-data/`：

| 文件 | 内容 |
|---|---|
| `warning_letter.jsonl` / `gras.jsonl` / `ndi.jsonl` / `lawsuit.jsonl` | 每类一个文件，每行一条记录，按 `source` + `source_key` 去重 |
| `manifest.json` | 各来源最近一次采集：状态、条数（新增/更新/不变/已消失）、时间覆盖、请求数与失败/被拦明细、字段完整率；每个来源注明它来自哪次运行（`run_id`） |
| `runs/<run-id>/` | 每次运行的 `run.log`、`manifest.json`，以及 `changes/<kind>.jsonl`（本次新增或有变化的记录，供以后增量入库） |
| `cache/` | 原始响应（gzip，共 42 MB），规则修改后用 `--offline` 重新抽取，不再请求网站 |

代码目录 `/Users/server/apps/regulatory`（从 origin `main` clone，当前 `82fe756`）。字段与主仓库 PLAN.md §2 的 `regulatory_event` 对齐：`source` 取值为 `fda_warning_letters` / `fda_gras_inventory` / `fda_ndi_list` / `ca_prop65` / `media:<outlet>`；诉讼类 `status` 一律为 `alleged`；全量核对时，来源里已消失的警告信、GRAS、NDI 记录写 `removed_at`，不删除。

## 2. 运行情况

| 运行 | 内容 | 请求 | 失败 | 被拦 |
|---|---|---|---|---|
| `2026-10-18T04-04-06-865Z` | 第一轮全量：下载全部警告信页面和 Prop 65 结果页。GRAS 因 CSV 引号格式解析失败；当时的规则和 `source` 名称也已作废。这一轮输出的 JSONL 挪到了该 run 目录的 `superseded-state/` 下，不作为结果 | 2,267 | 0 | 0 |
| `2026-10-18T04-43-46-235Z` | 第二轮全量（GRAS、NDI、Prop 65、媒体的最终结果）。警告信页面直接读缓存 | 1,440 | 0 | 0 |
| `2026-10-18T05-07-04-729Z`、`05-08-33-619Z` | 警告信离线重新抽取（应用两组抽样核对后修改的规则），无请求 | 0 | — | — |

节流：每个网站每秒最多 1 个请求；网络错误、429、5xx 最多重试 3 次；401/403/451 记为被拦且不重试，同一网站连续被拦 3 次就停止该来源。本次所有请求都是直接访问，没有被拦，也没有发生过一次重试。

## 3. 各类条数与覆盖范围

| 类型 | 条数 | 时间覆盖 | 说明 |
|---|---|---|---|
| 警告信 | 893（补充剂 187，食品 706） | 签发日期 2021-01-06 至 2026-09-29（补充剂类到 2026-08-24） | FDA 列表共 3,758 封；烟草、器械、生物制品、兽药四个中心的 1,571 封没有下载；读了 2,187 封原文，其中 1,294 封不在范围内（主要是 CDER 的药品信） |
| GRAS | 1,360 | 提交日期 1998-02 至 2019-10；结案日期 1998-05 至 2026-09 | GRN 614 以后的 682 条，FDA 没有公布提交日期（导出表和单条页面上都没有），`event_date` 留空 |
| NDI | 1,372 | 提交日期 1995-07 至 2026-02；FDA 回复日期 1995-08 至 2026-04 | 当前列表文件 `75-day-premarket-ndin-1995-to-present-260709.xlsx` |
| 诉讼 · Prop 65 | 846 | 通知日期 2025-10-03 至 2026-10-15 | 12 个月共 6,278 条通知，按产品词表留下补充剂类；其中 67 条已和解、39 条已起诉、1 条已判决 |
| 诉讼 · 媒体 | 5 | 2026-09-11 至 2026-10-14 | NutraIngredients 1 条、SupplySide 4 条；RSS 没有历史，见 §7 |

警告信状态：已签发 760，已结案（有 closeout letter）132，已公开回复 1。

主要字段完整率（全部取自 `manifest.json`）：

- **警告信**：地址 100%、网站 24%、违规类型 99%、成分 26%、summary 100%。网站和成分是"信里提到才有"。
- **GRAS**：申报方 99.9%、地址 99.8%、FDA 结论 100%、回复信链接 95.9%（49 条 pending 没有回复信）。
- **NDI**：公司 100%、提交日期 99.9%（2 条原表日期写错：`5/3/20201`、`10/282024`，原值保留在 `raw`）、回复日期 100%；FDA 结论 0%，表里没有，不猜。
- **Prop 65**：原告、被指控方、化学物质、产品描述、通知 PDF 链接 99%+；法院为空，60 天通知还没有进入法院。

## 4. 警告信：筛选和抽取规则

全部是规则匹配，没有用模型。每个判断都在 `details.evidence` 或 `details.scope_quote` 里附上信中原句。规则在 `tools/regulatory/src/sources/warning-letter-rules.mjs`。

**列表来源**：任务说明里的 XLSX 实际只有 1,000 行（2022-01 至 2024-06，顺序也乱），而且没有信件链接和 Excerpt 列。所以改用同一页面背后的 DataTables 数据接口，该接口列出全部 3,758 封，每封都带链接。

**不下载的发信部门**：Issuing Office 匹配 `tobacco products | devices and radiological | biologics evaluation | veterinary medicine`。

**范围判断**（按顺序，命中即停）：

1. `dietary_supplement`：信件页面的 Product 字段含 "dietary supplement"（95 封）；或 Subject 含 "dietary supplement"（10 封）；或正文有句子直接说收信方的产品是 / 被当作 / 不能算膳食补充剂（82 封）。正文用的说法有：`marketed|labeled|sold|promoted|represented|offered|distributed as a dietary supplement`、`your … dietary supplement(s)`、`dietary supplement product/manufacturing/facility/firm/distributor`、`adulterated/misbranded dietary supplement(s)`、`is not a dietary supplement`、`definition of a dietary supplement`、`cannot be marketed as a dietary supplement`、`CGMP requirements for dietary supplements`、`21 CFR Part 111`。判断前先去掉 FDA 机构名称（如回复地址里的 "Division of … Dietary Supplements"），否则食品信也会被误判。
2. `food`：Product 字段是食品或饮料、且不是动物用品（701 封）；或者发信部门是 Human Foods Program / CFSAN（5 封；它们只管食品和补充剂，即使 Product 字段写的是 "Drugs"）。
3. 其余不收。

**违规类型**（句子级正则，每类最多附 2 句原文）：

| 类型 | 判定说法 |
|---|---|
| `cgmp` | CGMP / cGMP、current good manufacturing practice、21 CFR 111 / 117 / 110 / 210 / 211 |
| `disease_claims` | "cure, mitigation, treatment, or prevention of disease"、"intended for use in the diagnosis/cure/treatment…" |
| `unapproved_new_drug` | unapproved new drug、"new drug" under section 201(p)、505(a)（不含 FSVP 的 21 CFR 1.505(a)） |
| `prohibited_ingredient` | 201(ff)(3)(B)、excluded from the definition、is not a dietary ingredient、does not qualify as a dietary ingredient、unsafe food additive、402(a)(2)(C)、402(f)、section 413、new dietary ingredient…notification、undeclared drug / active pharmaceutical ingredient、hidden drug、FDA laboratory analysis…confirmed |
| `labeling` | misbranded … under section 403（产品本身被判错标；FSVP 信中引用 403(w) 的要求条文不算）、21 CFR 101.x |
| `other` | FSVP、HACCP、402(a)(4) / insanitary conditions、failure to register、Section 5 of the FTC Act |

**成分**：一份约 110 种的固定词表，包括违禁兴奋剂、SARMs、药物掺假（sildenafil 类、sibutramine 等）、大麻类、高风险草本，以及常见补充剂成分（维生素、矿物质、spirulina、CoQ10、whey protein 等）。匹配前先去掉网址、"Not a significant source of…" 标签声明和营养标示条文。这是"信里提到了哪些成分"，不代表每个成分都是违规成分。

## 5. Prop 65 与媒体的筛选词表

**Prop 65 产品描述**（`prop65-rules.mjs`，按 6,278 条真实通知调整过）：supplement、vitamin、multivitamin、protein powder/shake/drink/bar/blend/mix、soy/pea/plant/hemp/rice/vegan protein、whey、collagen、capsule、softgel、caplet、tablet、herbal、ashwagandha、turmeric、curcumin、moringa、spirulina、chlorella、maca、kratom、kava、elderberry、probiotic、creatine、pre-workout、BCAA、amino acid、electrolyte、greens powder、superfood、lion's mane、reishi、cordyceps、chaga、ginseng、ginkgo、shilajit、sea moss / irish moss、kelp、psyllium、meal replacement、nutrition shake、gainer、ketone、detox、cleanse、(flower/root/leaf/herb/seed/bark/berry) extract、CBD、cannabidiol、prenatal/postnatal、lactation、adaptogen、nootropic、fiber powder、(sleep/immune/joint/gut/liver/digestive/energy/focus/stress/mood/hydration) support/health/boost/formula/blend/powder、tincture、wheatgrass、barley grass、beet root powder、mushroom extract/blend/complex/gummies。排除词：宠物用品、shampoo、lotion、serum、cream、receipt。

**媒体**（`media-rules.mjs`）：标题或 RSS 摘要含 lawsuit、sue/sued、class action、settlement、litigation、court、judge、jury、verdict、FTC、attorney general、DOJ、indicted、pleads guilty、sentenced、injunction、consent decree、seized、warning letter、Prop 65、enforcement、crackdown、fines/fined、charged with。`lawsuit_type` 按 class action → FTC → attorney general → Prop 65 → other 的顺序判定。媒体只存标题、RSS 自带的摘要和链接。

## 6. 抽样核对（人工逐封读原文）

两组，每组随机抽 8 封补充剂类 + 2 封食品类。第一组用于发现规则问题，修规则之后，再抽一组事先没看过的信作为独立检验。

| | 第一组（修规则之前） | 第二组（新样本，修规则之后） |
|---|---|---|
| 范围判断正确 | 10/10 | 10/10 |
| 地址 / 网站正确 | 10/10 | 10/10 |
| 违规类型完全正确的信 | 5/10 | 9/10 |
| 违规类型准确率（标出的对不对） | 15/17 = 88% | 22/22 = 100% |
| 违规类型覆盖率（该标的标没标） | 15/19 = 79% | 22/23 = 96% |
| 成分准确率 | 10/12 = 83% | 19/21 = 90% |
| 成分覆盖率 | 约 40% | 约 39%（19/约 49） |

第二组逐封结果（规则标出 → 人工核对）：

| 信 | 违规类型 | 成分 |
|---|---|---|
| Eden's Answers（CGMP） | cgmp, labeling ✓ | 无；漏 catnip、chamomile、hops、passionflower、lemon balm、peppermint、licorice 等约 9 种 |
| Chill6 | disease_claims, unapproved_new_drug, prohibited_ingredient ✓；漏 labeling（"would be a misbranded food under section 403(a)(1)"，已修） | phenibut ✓；漏 L-taurine |
| Genesis Ultra Slim | unapproved_new_drug, prohibited_ingredient ✓ | sibutramine, phenolphthalein, garcinia ✓；漏 konjac、pineapple、green apple |
| Biomic Sciences（ION） | cgmp, labeling, other ✓ | 无；漏 humic extract |
| Max Muscle | prohibited_ingredient ✓ | hordenine ✓；漏 octopamine、bitter orange |
| BioDrive | prohibited_ingredient ✓ | 无；漏 EV1-Peptide |
| MYA International | cgmp, disease_claims, unapproved_new_drug, labeling ✓ | 11 个对；iron、vitamin D 误判（营养标示条文，已修）；漏约 12 种 |
| Nupack | cgmp, disease_claims, unapproved_new_drug ✓ | maca ✓；漏 psyllium |
| Life Leaf（Delta-8，食品） | prohibited_ingredient, other ✓ | delta-8 THC, THC ✓ |
| Distribuidora Jocorena（FSVP，食品） | other ✓ | 无（进口的是普通食品）✓ |

第一组发现并已修复的问题：

- `"new drug"`（带引号）和 "sections 301(d) and 505(a)" 两种写法没匹配上，漏判 `unapproved_new_drug`；
- 不认识 "unsafe food additive" 和 FTC 那一段；
- "(that are not dietary ingredients)" 和 FSVP 信里引用的 403(w) 要求条文造成误判；
- 网址里的 "CBD" 被当成成分；
- 信里的列表（`<li>`）没有读到。

修复后，用缓存重新处理了全部 893 封，其中 253 封的判断有变化。

**结论**：规则版的违规类型已经可用（第二组准确率 100%、覆盖率 96%）。成分字段标出的基本是对的，但只能找到约四成：词表认识的成分才能找到，信里的其他草本、氨基酸、新成分都会漏掉。这个字段如果要可靠，需要换方法（见 §9）。

**Prop 65 抽查**（各随机 20 条）：留下的 20 条里，18 条明确是补充剂类，1 条误收（植物肉粉 "Beef Free Pea Protein Dry Mix"），1 条边界（"Turmeric powder"，可能是香料）。排除的 20 条里，漏掉 1 条（"The Fittest Queen Supports Optimal Hormones"，描述里没有任何关键词）。按这个比例粗估，排除的 5,432 条里可能还有几十到两百多条补充剂类没收进来，样本小，估计误差大。

**媒体**：5 条全部看过。4 条是明确的诉讼 / 执法新闻（法院禁令、专利判决、最高法院案、FTC 罚款），1 条只是在介绍州 EPR 法时提到相关诉讼，属于边界。

**GRAS / NDI**：只解析结构化字段，没有判断规则。抽查 GRN 1100、1300、700，与原页面一致。

## 7. 被拦或缺失

- **被拦**：无。fda.gov、hfpappexternal.fda.gov、oag.ca.gov、两个 RSS 均可直接访问。regulations.gov 没有访问（NDI 的链接指向那里，只作为 `source_url` 保存）。
- **媒体没有历史**：NutraIngredients-USA 已并入 nutraingredients.com，feed 只给最新 20 条（约 3 天）；Natural Products Insider 已改名 SupplySide Supplement Journal（supplysidesj.com），feed 只给最新 50 条（约 7 周），`?page=N` 无效。两者都没有分类 feed。所以媒体无法回填，只能从现在起积累。
- **媒体记录没有公司名和事件日期**：RSS 里没有，`raw_company_name`、`event_date` 留空，只有 `published_date`。
- **GRAS 提交日期**：GRN 614 以后 FDA 不再公布，682 条为空。
- **NDI 结论**：表里只有回复日期，没有"不反对 / 有异议"，`fda_response` 为空。
- **警告信回复信链接**：FDA 很少公开回复信，`response_letter_url` 只有 0.1% 有值；closeout letter 有 14.8%。
- **食品类警告信的成分**：仍有一些是营养标示里的维生素和矿物质（如 vitamin D 21 次），准确率比补充剂类低，使用时注意。

## 8. 定时运行建议（尚未安装）

| 来源 | 频率 | 命令 |
|---|---|---|
| 警告信 | 每周两次 | `--mode incremental --sources fda_warning_letters`（4 个列表请求 + 新信件页面） |
| GRAS、NDI | 每月 | `--mode incremental --sources fda_gras_inventory,fda_ndi_list` |
| Prop 65 | 每周 | `--mode incremental --sources ca_prop65`（最近 45 天，约 10 个请求） |
| 媒体 RSS | **每天**（与原定"诉讼每周"不同） | `--mode incremental --sources media`。NutraIngredients 只保留约 3 天，每周跑会漏 |
| 全量核对 | 每月一次 | `--mode backfill`：重读完整列表，标记 `removed_at`，Prop 65 重读 12 个月以更新进展；信件页面用缓存，`--refetch-pages` 可强制重读 |

增量运行时，新增或有变化的记录写在 `runs/<run-id>/changes/`。

## 9. 待决定

1. **成分（以及 Prop 65 的漏收）要不要加 AI**：可以只对补充剂 / 食品类警告信（约 900 封）让模型读全文，输出违规类型和成分，每一项必须附原句；程序再核对那句话确实在原文里，对不上的丢掉。Prop 65 可以只把关键词判断不了的产品描述交给模型。需要先确定用哪个模型账号、什么时候跑（Server 一的模型账号与商品队列共用，上限 10）。
2. **食品类警告信是否保留**：目前收了 706 封，标为 `details.scope = "food"`，可以在入库时只取 `dietary_supplement`。
3. **Prop 65 的边界产品**（花草茶、香料类姜黄粉等）是否收窄。
