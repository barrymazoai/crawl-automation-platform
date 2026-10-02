export const productInstructions = `只采集派发的一个基础商品，保留全部真实规格；不要枚举整个商店再采集其他商品。
Ego native runHarvest 直接使用宿主派发 URL 作为唯一待采商品，不要对详情页调用 collectProductUrls 或重做目录发现。
使用旧 runHarvest 和按站点验证过的 hooks，最终 outDir/evidence/records.json 必须只有该商品一条，保留 fields、variants、gallery、pageHtml、coverage、flags。
缓存 profile 的 lastValidatedAt=null 或 successCount=0 不能当成已验证方法。收割前必须用本轮已保存的页面/展开区块做字段提取预览，并逐项与页面原文核对；不要在收割结束后才首次检查字段。
预览中若用法/配料/FAQ 串位、促销价/推荐商品混入或不存在的字段被猜出，先修正本次 profile 或使用 hooks.extract 从本轮实际观察的节点读取原文字段。不要沿用错误的通用 fallback；图片里的 Facts 留给后续处理，不把 Directions/FAQ 冒充 Facts。
保存 field-preview.json（实际提取函数返回的字段、逐项实际来源、对照结论）和 profile-validation.json（本次方法、证据、通过/不通过）；预览必须执行将用于 runHarvest 的同一 extract/upgrade 方法或对本轮保存 HTML 调用 applyDetailExtractionProfile，不能手写期望值代替实际提取结果。未通过就保留原因返回 needs_review。不要为通过而编造字段或只把 validation 计数改成成功。
规格来自网站实际规格选项、SKU、variant 数据和可售状态，不从图片推断。平台商品用原有商品数据路径保存完整 variants；平台数据不可用时按真实选择器逐项记录，不因图片不能绑定而丢弃规格。
fields.title 和 fields.brand 必须来自实际商品页面/该商品的平台数据，品牌不能照抄任务来源名称；保留品牌出处。其他页面原文字段原样保存，缺失留空，不推断成分。pageHtml 必须指向实际保存的详情 HTML。
采集实际产品轮播/图库全部原图，以及详情中实际展示的 Facts/背标图片。不要把整个 main 的所有 img 当图库；徽章、推荐商品、导航缩略图要区别开。
收割前在实际页面核实所有图库项及详情图片，把已观察到的完整原图 URL 数组作为 runHarvest(...,{observedGalleryUrls:[...],...}) 必填参数；原生单品不会使用通用提取器按关键词猜测出来的图片集合。不要根据文件名筛选或编造未观察的原图地址。
逐张查看已保存的图库，确认轮播所有项及后续图、折叠/延迟加载内容都已检查；不靠 alt/文件名关键词决定收哪张图。
保存 capture-review.json：{productUrl,selectedVariantId:null或实际ID,galleryUrls:[全部已保存原图URL],galleryComplete:true或false,variantsComplete:true或false,detailComplete:true或false,method,surface:"local_file",evidence:[相对截图/图片路径],verifier:"codex",imageAssignments:[{url,variantId:null或ID,basis:"product-gallery"或"variant-featured"}]}。
imageAssignments 只记录网站数据或实际切换证据支持的图片归属；未明确绑定的商品共用图保留 variantId:null，不因此返回 needs_review，不强行分配给当前规格。缺失原图或规格未采齐才属于采集不完整；后续处理负责判断图片内容及适用规格。
禁止执行 semantic queue、enrich 或旧 API-ready 导出；后续系统用本次原件处理。`;

export const catalogInstructions = `按旧采集流程先视觉确认站点身份和完整目录族，制定路线与终止契约，再用 discoverCatalog 复用旧 ENUMERATE 阶段及 Shopify 目录对账。普通目录按契约遍历至零增长；符合旧有界规则的 Shopify 单目录可用页面/目录结果/对应接口完整集合相同及空终页证明，不强制重复遍历。证明选择在采前完成。
只发现产品，不进入逐个产品采集和 OCR。商品必须来自实际目录/导航；平台 API 库存不能直接代替目录产品集。
保存 catalog.json：{pages:[{url,htmlPath,screenshotPath,entries:[{url,title,brand:null或页面品牌}]}],complete:boolean,termination:{proof:"enumeration"或"shopify",exhausted:boolean,reason:string,method:string,evidence:[相对路径],zeroGrowthRounds:number,oracle:{expected:number|null,observed:number,comparable:boolean}}}。
每页/每个加载阶段保留原始渲染 HTML；每个 seed 留截图，最后耗尽状态留截图。entries 只能列出该页实际出现的产品详情链接。
所有目标目录覆盖完整且选定的完成证明通过、可比 oracle 无缺口时才能 complete=true。Shopify的catalog-coverage.json和逐份原始响应由机械工具保存，不能手写对账成功；子目录不能用全店接口背书。达到预算、发现循环、漏页或差额时 complete=false 并说明原因，不伪造全品牌完成。
标题和品牌按页面原文保存；去重按真实规范产品 URL。保存 entry-decision.json、route-plan.json、termination-contract.json、验证查漏痕迹。
用户给的是一个已配置品牌来源，范围只限该来源；多品牌卖场不得把其他品牌放进来。`;

export const analysisInstructions = `分析入口属于官网、自营商店、直属品牌组合还是第三方卖场。视觉验证目录入口和至少一个真实商品，不使用固定选择器模板代替观察。
允许沿官方实际链接展开一层直属品牌，不递归。遵守 scope 中 maxBrands/maxPages/maxDomains 限额。
保存 analysis.json：{state:"completed"或"needs-review",brands:[{name,domain,platform:"shopify"或"woocommerce"或"jsonld",catalogUrl,productCount,countExact,wholeCatalog,discoveredFrom:{page,link},status:"verified"或"needs-review",reason:null或说明}],archiveKeys:[],reasons:[]}。
每个品牌保存 evidence-pages.json：[{url,htmlPath,screenshotPath}]，至少包含来源页、目录和代表商品的实际 HTML 与截图。
保存 analysis-verification.json：{method,surface:"live_site",evidence:[相对文件路径],verifier:"codex",limitsReached:boolean}。
platform 是实际观测，不凭URL猜；不支持的自建数据结构返回 needs-review，保留原因。不能只因公司同名就确认品牌。
完整枚举之前 productCount 只报实际观察数，countExact=false、wholeCatalog=false；平台库存数不能冒充完整目录数。
本站所有已发现直属品牌均被验证且预算未耗尽才能 state=completed。不要调用 apply 或自动启动商品采集。`;
