# Bella Grace wellness 分类真实采集验收

本轮已结束：**7 个目录商品，1 个入库、4 个待审、2 个组合装排除**。目录覆盖验证通过，13 个工作流全部 COMPLETED。业务存在待审，不应把 Workflow COMPLETED 解读为所有商品合格。

入口：https://shopbellagrace.com/collections/wellness。用户确认 Windows 部署完成后，经正常 Brand API 提交一次；执行时间为 2026-09-12 13:45:40.818–14:31:49.444 UTC（北京时间 21:45–22:31），约 46 分钟。

## 结果

| 商品 | 业务结果 | 原图数 | 说明 |
| --- | --- | ---: | --- |
| Elixir | 待审 | 9 | 原始证据齐备，因未保存站点方法 profile 返回待审 |
| RESTorative Sleep Gummies | 待审 | 3 | 标签图已保存；视觉含量状态冲突，文字回退引用也无效 |
| Bella Melts | 待审 | 1 | 漏采 INGREDIENTS 折叠区背标；文字引用无效 |
| BellaTrim | 入库 | 7 | 标签识别、组装和入库均完成 |
| Bella Melts 3-Bags | 排除 | 0 | bundle_or_pack，排除证明通过 |
| Healthy Weight Stack | 排除 | 0 | bundle_or_pack，排除证明通过 |
| The Confidence Reset | 待审 | 1 | 六款商品套装未识别为组合装，进入单品标签路径后待审 |

- 数据库有 8 条 Review 记录，对应 4 个商品：Elixir 1 条、Bella Melts 2 条、The Confidence Reset 2 条、Sleep Gummies 3 条。模块待审和最终组装待审分别留档，不能按 8 个商品计算。
- 84 个原始文件从 R2 逐一读回核对字节数及 SHA-256，包含 21 张原图、5 份商品 HTML、1 份目录 HTML、5 条原始商品记录及各 1 个真实变体。原始记录数不等于成功入库数。
- 最终业务记录引用的 48 个 R2 文件另行验证通过，与原始文件有重叠，两个数量不相加。
- 没有改写历史 Review、原始证据、资源许可或本轮结果，也没有重发业务任务。

## 通过的部分

目录实际 DOM 有 14 个链接，去重为 7 个；当前分类 `/collections/wellness/products.json` 第 1 页 7 项、第 2 页为空，`shopify-collection-products/1` 结束证明通过。目录 HTML 与截图已保留并核对，人工查看确认品牌及七款商品一致。

8 次 Codex 采集进程（目录 1 次、商品 7 次）最终全部退出 0、aborted=false，均保存了根目录约定脚本。保留日志未记录 file_change 失败；部分脚本中间有导入或参数错误，模型在同一任务内修正，未冒充从头到尾无错误。

BellaTrim 的标签策略已按真实历史核验：OCR 4 次、视觉 1 次，选中 `image-3`（第 4 张）完整标签后，余下三张图及页面保持 not_started，之后 OCR/视觉/文本调用均为 0。总 textCalls=0；入库记录哈希与工作流 receipt 匹配。

14:34 UTC 最终核对：Mini 90 个基础进程及 26 个 DTC 进程 ready，五项资源 healthy/fresh，held=0、source guard=0、active submission=null。Windows 节点仍 RUNNING，runId 与三个 poller 身份均与提交前相同。本轮未重启或重新部署。

## 待审原因与采集缺口

### Elixir：站点方法保存条件阻塞了采集交付

1 条商品、1 个变体（SKU `bg-elxr-wb`）、9 张原图、HTML 均已保存；harvest complete、verification pass。人工查看保存的 `Elixir_Back.png` 对应原始 WebP，确认包含 Supplement Facts 和其他成分。

代理最终 reasonCode 是 `profile_persistence_incomplete`：Shopify 路径没有生成可保存的有效视觉 selector profile，所以返回 needs_review。`packages/runtime/src/browser-capture-prompt.ts` 的 profileSection 确有“抓取通过质量门后必须保存 profile”要求。宿主忠实记录该结果，因此没有进入后续标签处理。

后续应明确区分本商品证据完整性与可复用方法的保存状态；方法验证失败不能靠编造 selector/profile 来通过，也不应含糊地归为“网站抓取失败”。

### Bella Melts：成分折叠区图片漏采

平台图库的唯一原图是正面图；保存的 HTML 在 `INGREDIENTS` 折叠区另有 `BM_ingredient.jpg` 的 img/src/srcset，但该图没有进入 gallery 和文件清单。`gallerySaved=1/1` 与 `extraFactsImages=0` 不能证明页面已没有其他标签图。

Mini 根据这份保留 HTML 中明确存在的 URL，另做了一次只读图片获取。HTTP 200，image/jpeg，299253 字节，SHA-256 `8d959726a44d541dc9431ba1bb03f9b35e8782584b1bdf1b3c57e82a21543ccc`。人工查看确认是包装背面，包含 Nutrition Facts、其他成分、用法与条码。

诊断图片保存在 `diagnostic-only/BM_ingredient.jpg`，没有追加到本轮业务采集包，不计入 21 张 Worker 原图。后续应覆盖商品详情中与当前商品有关的折叠内容和图像，并在结束浏览器阶段前保留这些证据。

### The Confidence Reset：组合装识别遗漏

原始描述明确为六款 Bella Grace 商品的组合，目录截图也展示多种不同商品；本轮却生成了一个 Shopify variant（SKU `confidencereset`）的单商品证据，未被组合装规则排除，继而进入 OCR/文本标签流程。

一个可售 variant 不代表一个独立配方。应依据商品内容识别套装，不能仅依赖标题或 URL 中是否有 bundle/pack。另两款组合装的范围证明正常通过；本轮没有人为把第三款改成 skipped。

### Sleep Gummies：图已抓到，结构化结果不一致

3 张原图、HTML 和 1 个真实变体（SKU `bg-sleep`）均保存，采集日志无失败工具事件。人工查看第 3 张图，Supplement Facts 和 Other Ingredients 完整可见，且与送入视觉模型的文件哈希一致。

模型输出第 4 行名称为 `Includes 3g Added Sugars`，同时给出 `amountStatus=printed` 和 `amount=null`，因此触发 `VISION.LABEL_AMOUNT_STATE_CONFLICT`。模型还把“Daily Value not established”脚注当成营养行并另建一列；这是另一个可直接从原始候选看到的结构错误。

后续需明确行名内含量、父子行与脚注的表示规则，保留当前一致性校验，不能把冲突结果强行当作完整标签入库。

### 三项文字回退：引用范围超过校验上限

原始输出中有以下 exclusion 引用，其行跨度超过 `packages/v3-text/src/extraction.ts` 的 50 上限：

| 商品 | 引用行范围 | 跨度 |
| --- | --- | --- |
| Bella Melts | 435–505；511–583 | 70；72 |
| The Confidence Reset | 361–489 | 128 |
| Sleep Gummies | 5–359；369–429；465–537 | 354；60；72 |

这些范围本身足以触发 `TEXT.CITATION_INVALID`。前两项原始文本输出同时为 formula=null、otherIngredients=null，所以仅修引用格式仍不能使其入库。文本 Prompt 应使用必要的短引用，避免把整段广告或页脚作为一条排除引用。

## 其他实际观察

- Elixir 与 Bella Melts 的临时脚本曾从错误模块调用 `validateHarvestPlan`；另有返回字段、枚举或 profile 结构用错后修正的记录。可通过明确已验证入口/返回结构减少重复脚本试错。
- 目录日志出现一次 PowerShell 读取中文 Skill 的乱码输出；目录最终成功，不能把乱码自动判为其他问题的根因。
- 三袋装日志记录一次对整个 `D:\crawlv3-dtc-v2` 的 rg 搜索，命中其他历史任务脚本，超出了 Prompt 的任务目录与公开 Skill 边界。当前所见命中不能证明读取了真实凭据；后续需要加强 Runner 的目录约束，不能仅依赖自然语言要求。

## 页面生命周期

七个商品均有正常 `closeDtcProductPage` 的 closed 回执；该实现返回前会核对目标不存在。宿主在证据采集完成后先关闭页面，再继续留存文件与后续处理，独立 close Activity 会再次复查。没有手工扩大清理范围、释放隔离许可或操作用户页面。

| 商品 | targetId | 回执 |
| --- | --- | --- |
| Elixir | `93B5247A9755DEE35B8CD82D4A658224` | closed |
| RESTorative Sleep Gummies | `5F550ED914529D26388CD436B6F1CD54` | closed |
| Bella Melts | `8B41B316A6F5175BBE14521ECA5F0278` | closed |
| BellaTrim | `0D11EDA2A3B219D7BCE8CE6BB997578F` | closed |
| Bella Melts 3-Bags | `5B215C9560EA60EC01E14795DB738F96` | closed |
| Healthy Weight Stack | `85E06FA0AE0795509054EA84082E7D78` | closed |
| The Confidence Reset | `567144C4A06BDBC92EE42097A5A06FBA` | closed |

目录 `readCatalogPage` 成功返回，已经经过部署中 `pages.using` 的关页与缺席复查路径。本轮没有另行登录 Windows 读取本地 closed.json 或做新的全局 CDP 清单检查；详细 taskId 与商品回执保留在公开摘要及 Temporal 历史中。

## 身份与证据

- requestId：`eaeca30d-0b75-42d7-bce4-7b5f98fd87fa`
- workflowId：`v3-collection-eaeca30d-0b75-42d7-bce4-7b5f98fd87fa`
- Brand：`901e4604-30e5-48b0-a55f-3c2d0e70ab1a`；Source：`180b41c1-1f92-4fa1-9672-b8025ca2a47b`，revision 2。
- 发布提交：`257f02ff6a0b6b431c762ac269c29d95042fd670`。
- Activity build：`3b705195988155f01befac765ec9708ba236d30c3dce88827cd0477aca017371`。
- Workflow build：`22f5c2817fa37833cbd7cb7fe60687d8eef9fe35240a95b0acc1e7cabbcd4644`。
- Windows runId：`01a095bd-afb7-7dc7-afc9-7ac332a3d855`。

[不含凭据的验收摘要](evidence/2026-09-12-dtc-bellagrace-trial/public-summary.json)包含各商品的完整 taskId、targetId、状态、证据 key、进程时间和标签调用数。

Mini 私有验收根目录：
`/Users/barry/apps/crawlv3-batch-a.UiA4dx/dtc-innerbody-v2-20260911/bellagrace-wellness-trial-20260912`

保留 `precheck.json`、`intent.json`、`submission.json`、`progress.jsonl`、`monitor.json`、全部 `.history.json`、`records.json`、`capture-summary.json`、`artifact-audit.json`、`single-label-policy-audit.json`、`model-validation-audit.json`、`final-health.json` 及逐商品 `capture-audit/`。

真实凭据、原始页面/图片和完整执行日志不入 Git。本轮只新增验收记录，没有修改采集程序、模型或部署配置。
