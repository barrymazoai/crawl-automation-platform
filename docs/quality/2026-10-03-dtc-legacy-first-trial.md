# DTC 旧输出优先：第一版直接实测

父票 CRAWLV3-151；采集/方法复用183，固定转换184，混合图库155/178。

## 最新纠正：仅采集，产品内容留给后续解析

2026-10-03 用户明确：“只让他采集，不要直接把产品数据解析出来了”。以下6170cfa实现记录是历史试验，不代表已接受的设计：其采集提示仍要求抽取fields正文，post-capture又增加第二次Codex检查HTML/原图、选择逐规格字段及原文子串，重复了产品内容处理，必须移除。仅删除第二次模型调用还不充分，采集端也应遵守此边界。

采集保留页面HTML、完整原图、网站实际规格及其页面/材料对应关系；转换只整理后续流程需要的材料结构与引用，不提取配料、用法或Facts等业务内容。已讨论的混合图库归属只条件式触发，不扩展为所有商品强制复核。此次纠正已在工作区实现：删除post-capture模型调用和字段/子串选择；采集出口限制为身份元数据、原始HTML/原图与材料索引；转换原样传递商品HTML并复用已有混合/下游处理。完整pnpm check通过，未新增或运行单元测试，尚待部署和真实验收。

HMW第5项试跑于08:23:23Z请求取消，08:26:36Z的runs.get确认Workflow=CANCELLED、heldPermits=[]，回执为Server一 `manual-releases/dtc-native-20261002/legacy183-hmw5-{cancel,cancel-status}.json`。已进一步核对：进程08:23:44Z停止、任务页及round08:23:45Z结束，许可08:23:55Z释放，stopBeforeRelease=true，回执legacy183-hmw5-stop-proof.json。保留历史原件及Review，不自动重试。183/184已补充用户纠正。

用户明确：复用9月28日已经使用Ego的旧采集行为，不重复迁移浏览器；原始输出之后再判断混合，然后转换下游。2026-10-03追加要求：不写单元测试，直接在Mini测试。本轮没有新增或运行单元测试，进行了必要的静态/类型检查与服务器构建。

## 实现与部署

`6170cfa61dba9abcf25b79b02795be5df675ac80` 已提交并push origin/main。完整 `pnpm check` 通过。Server二于2026-10-03T08:18:29.468Z完成全新Git clone、locked install、build及browser-worker ready；Server一仍为9c8b107，既有Facts和混合图库工作流不改。

- 固定 `site-capture.mjs` 调旧runHarvest。宿主派发单商品，不重做目录；模型只维护已观察验证的站点方法，输出原来的fields/variants/gallery/pageHtml/coverage/flags。
- 原始采集成功后先精确关页、存档，再开启只读原件的采后复核；不再要求采集前写新版detail-coverage、variant-preflight。完整性、原件散列、任务范围仍核对；历史带fieldEvidence的证据照常复验。
- 采后复核由模型判断原文字段和图库适用范围；固定转换只拷贝已有字段或逐字核对的子串，逐规格使用网站自身SKU/价格。混合图库仍交原有OCR+Codex分配，再回旧Facts处理；无法确认的规格单独Review。
- 原件与派生复核分开保存。通过复核的实际执行方法按散列留在原有profileDir下，后续同站任务自动得到该方法；一商品通过不等于全站验证。后续商品是否实际复用仍待实测。

## 真实任务

| 项目 | 状态 |
| --- | --- |
| HMW第5项 `/products/perform-creatine-chews-single-serve-pack` | 2026-10-03T08:19:44.462Z 首次开始，run `98a7e067-dba7-427f-b5b7-5c63b54ebb57`，尚待结果 |
| 排队控制 | ready=1 / running=1；投送后立即drain，1queued / 4历史Review / 1running |
| 实测前许可 | held=[] |
| Space 6 | agent所有；仅原有unknown空白页 `2B17A86DBCA4F3AC717200EF04BD6BA4`，保留不动 |

Server一回执位于 `manual-releases/dtc-native-20261002/legacy183-hmw5-{preflight,start}.json`。不自动重试前四项或改写历史Review。

尚未验收：本项原件/归属/下游结果、方法下一商品复用、当前版本混合多规格重放和独立多规格实站例；不能将代码检查通过写成全链路通过。
