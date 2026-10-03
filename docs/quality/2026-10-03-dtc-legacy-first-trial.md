# DTC 旧输出优先：第一版直接实测

父票 CRAWLV3-151；采集/方法复用183，固定转换184，混合图库155/178。

## 最新纠正：仅采集，产品内容留给后续解析

2026-10-03 用户明确：“只让他采集，不要直接把产品数据解析出来了”。以下6170cfa实现记录是历史试验，不代表已接受的设计：其采集提示仍要求抽取fields正文，post-capture又增加第二次Codex检查HTML/原图、选择逐规格字段及原文子串，重复了产品内容处理，必须移除。仅删除第二次模型调用还不充分，采集端也应遵守此边界。

采集保留页面HTML、完整原图、网站实际规格及其页面/材料对应关系；转换只整理后续流程需要的材料结构与引用，不提取配料、用法或Facts等业务内容。已讨论的混合图库归属只条件式触发，不扩展为所有商品强制复核。此次纠正已在工作区实现：删除post-capture模型调用和字段/子串选择；采集出口限制为身份元数据、原始HTML/原图与材料索引；转换原样传递商品HTML并复用已有混合/下游处理。完整pnpm check通过，未新增或运行单元测试。adce017已部署并直接采集；后续57b1d72修复元数据兼容，留存材料交接通过，具体边界见下。

HMW第5项试跑于08:23:23Z请求取消，08:26:36Z的runs.get确认Workflow=CANCELLED、heldPermits=[]，回执为Server一 `manual-releases/dtc-native-20261002/legacy183-hmw5-{cancel,cancel-status}.json`。已进一步核对：进程08:23:44Z停止、任务页及round08:23:45Z结束，许可08:23:55Z释放，stopBeforeRelease=true，回执legacy183-hmw5-stop-proof.json。保留历史原件及Review，不自动重试。183/184已补充用户纠正。

用户明确：复用9月28日已经使用Ego的旧采集行为，不重复迁移浏览器；原始输出之后再判断混合，然后转换下游。2026-10-03追加要求：不写单元测试，直接在Mini测试。本轮没有新增或运行单元测试，进行了必要的静态/类型检查与服务器构建。

## 简化版部署与首次实测

`adce0177778966225d2b34840767c68d4205046b` 已提交并push origin/main，完整pnpm check通过。Server二于08:39:59Z完成fresh Git clone、locked install、build和browser-worker ready。Server一既有处理流程未更换。

08:41:04Z启动唯一尚未尝试的HMW第6项 `/products/hmw-method-perform-strawberry-kiwi-creatine-chews-coming-soon`，run `ce451185-d317-48d1-99c7-f34510842f45`；attempt0→1，1/1投送后立即drain，5项历史Review保留，没有剩余queued。回执Server一 `manual-releases/dtc-native-20261002/materials183-hmw6-{preflight,start}.json`。08:46:02Z浏览器采集完成，fields仅title/brand/images，保存完整页面与30,560字节商品区域原样HTML、1张实际图库原图、网站1规格。交接因SKU=null被旧VariantSchema拒绝进入Review，未执行任何Facts子流程；options数组/available=null也需规范为下游元数据格式。此为转换兼容缺陷，已修复本地，使用留存原件验证，不重抓或改写原件。71个R2文件共5,812,616字节全部回读hash/大小匹配；进程08:46:02Z、任务页/round08:46:03Z停止，许可08:47:10Z释放，held=[]。

旧HMW5的7个R2文件、1,106,582字节已全部回读，大小和SHA-256全部匹配；回执 `legacy183-hmw5-r2-proof.json`。

## 元数据修复与留存材料直接验证

修复 `57b1d7239317b8b4ca56d50ce6ee65a107cfb909` 已通过 main→origin/main→Server二fresh Git clone/locked install/build，于08:52:01Z就绪。转换只规范网站元数据：null保持缺失，选项数组映射成有序option键，数字转字符串；网站提供命名选项时保留名称。不改变原件、不补默认SKU/库存/币种。

现有 `verify-dtc-retained-scope.mts` 直接读取新materials出口并使用原样商品HTML。第一次命令在仓库根找不到tsx，未启动工具或业务；随后使用ops-deploy现有tsx入口，原件不变。输出目录Server二 `manual-releases/materials184-57b1d72-live/`，日志 `manual-releases/dtc-mixed-852546a/materials-retained-ops-cli.log`。

- 71个本地/R2原件、5,812,616字节全部校验一致。
- 既有组合商品分类 `dtc-scope-accept-9a533c04-f608-4570-b98b-11ebb28e954e` 判为single_product。该步骤只判断商品范围，不解析配料或Facts；不是已删除的强制采后字段复核。
- 实际材料→完整采集交接校验结果captured，1个projection；网页30,560字节原样HTML与下游detailsHtml逐字相等，1张原图和网站规格54759816167790/价格35.99保留。SKU缺失未猜值；原始capture fields仅title/brand/images。
- 第一次下游 `dtc-retained-single-16411ab5-97bb-4653-bd1a-6421b2935548` 已结束，Label子流程返回 `CHANNEL.LABEL_NO_SOURCE`，没有完整产品/enrich结果。原图已视觉查看，为包装正面，无Facts表；原始Review和本次派生Review均保留，不自动重试。
- 组合判定模型与图片OCR均有停止证明，2个许可全部在实际执行结束后释放，held=[]。临时验证Worker已停止。回执Server一 `manual-releases/dtc-native-20261002/materials184-hmw6-{workflows,projection-proof,stop-proof}.json`。

本轮通过的是：只采集材料、直接转换（含空SKU/数组选项）、原件完整性和清理；不是所有DTC链路验收通过。当前新版多规格独立/混合分路、同站脚本跨商品实际复用仍待实站验证，不能借旧Solaray成功证明新版已全部通过。本轮采集原件/实际方法已归档；原任务在兼容错误处结束，未完成其正常方法缓存步骤，不能声称这次已验证缓存复用。

## 第一版历史实现与部署（方向已纠正）

`6170cfa61dba9abcf25b79b02795be5df675ac80` 已提交并push origin/main。完整 `pnpm check` 通过。Server二于2026-10-03T08:18:29.468Z完成全新Git clone、locked install、build及browser-worker ready；Server一仍为9c8b107，既有Facts和混合图库工作流不改。

- 固定 `site-capture.mjs` 调旧runHarvest。宿主派发单商品，不重做目录；模型只维护已观察验证的站点方法，输出原来的fields/variants/gallery/pageHtml/coverage/flags。
- 原始采集成功后先精确关页、存档，再开启只读原件的采后复核；不再要求采集前写新版detail-coverage、variant-preflight。完整性、原件散列、任务范围仍核对；历史带fieldEvidence的证据照常复验。
- 采后复核由模型判断原文字段和图库适用范围；固定转换只拷贝已有字段或逐字核对的子串，逐规格使用网站自身SKU/价格。混合图库仍交原有OCR+Codex分配，再回旧Facts处理；无法确认的规格单独Review。
- 原件与派生复核分开保存。通过复核的实际执行方法按散列留在原有profileDir下，后续同站任务自动得到该方法；一商品通过不等于全站验证。后续商品是否实际复用仍待实测。

## 真实任务

| 项目 | 状态 |
| --- | --- |
| HMW第5项 `/products/perform-creatine-chews-single-serve-pack` | 2026-10-03T08:19:44.462Z 首次开始，run `98a7e067-dba7-427f-b5b7-5c63b54ebb57`；后于08:23Z取消，详见上方清理证据 |
| 排队控制 | ready=1 / running=1；投送后立即drain，1queued / 4历史Review / 1running |
| 实测前许可 | held=[] |
| Space 6 | agent所有；仅原有unknown空白页 `2B17A86DBCA4F3AC717200EF04BD6BA4`，保留不动 |

Server一回执位于 `manual-releases/dtc-native-20261002/legacy183-hmw5-{preflight,start}.json`。不自动重试前四项或改写历史Review。

尚未验收：本项原件/归属/下游结果、方法下一商品复用、当前版本混合多规格重放和独立多规格实站例；不能将代码检查通过写成全链路通过。
