export const productInstructions = `只采集派发的一个基础商品，保留全部真实规格；不要枚举整个商店再采集其他商品。
Ego native runHarvest 直接使用宿主派发 URL 作为唯一待采商品，不要对详情页调用 collectProductUrls 或重做目录发现。
先完整读取 skillRoot 下 references/native-product-method.md 和任务根目录 capture-review.schema.json；后者由宿主实际校验schema生成。使用旧 runHarvest 和模型按实际观察确定的 hooks.extract，最终 outDir/evidence/records.json 必须只有该商品一条，保留 fields、variants、gallery、pageHtml、coverage、flags、fieldEvidence。
本模式只保存宿主派发商品的原始资料；不要因URL或标题含pack/bundle/kit等词在采集前排除。是否为多产品组合或营养单品由后续现有处理流程依据原件判断，不在本次执行旧语义范围筛选。
缓存 profile 的 lastValidatedAt=null 或 successCount=0 不能当成已验证方法。收割前必须用本轮已保存的页面/展开区块做字段提取预览，并逐项与页面原文核对；不要在收割结束后才首次检查字段。
预览中若用法/配料/FAQ 串位、促销价/推荐商品混入或不存在的字段被猜出，先修正本次实际观察方法。禁止使用 extractDetailDomRecord、applyDetailExtractionProfile、extractProductsBatch、upgradeProducts 等通用提取器，包括从自定义 hooks 内间接调用；禁止整页猜字段、关键词抓成分和静默 fallback。图片里的 Facts 留给后续处理，不把 Directions/FAQ 冒充 Facts。
用 readObservedProduct(outDir,method) 执行模型选定的确切 DOM selector / JSON pointer；方法与原件散列随 fieldEvidence 保存，宿主会从原件重放核对。selector 必须唯一，缺失或歧义就停止，不允许改用整页文字。保存 field-preview.json（真实返回字段、逐项原文位置、语义核对、缺项原因）和 profile-validation.json（本次方法、证据、通过/不通过）；预览和 hooks.extract 必须调用同一方法，不能手写期望值代替结果。非空不等于正确，必须逐项确认属于该商品及该字段。未通过就保留原因返回 needs_review。
完整读取任务根 detail-coverage.schema.json。收割前逐段走到页面底部，查看延迟内容，列出实际商品详情区块及其排除理由；不要把保存整页HTML当作已经交接全部详情。每个当前商品区块须有实际观察证据，以及指向原件的确切location；captured区块的location必须与对应observedMethod.fields[field]规则完全一致，正文确实进入fields。质量/认证/用法/警告/FAQ等存在时也按实际适用范围保存，不能只映射product.body_html；混含其他商品的段落由模型分别选定当前商品正文或明确排除，不按标题关键词泛抓。
原生details折叠区须实际展开并另存该状态HTML，关闭的details正文不能算已展开。自定义折叠/懒加载同样实际观察并留截图；交互被遮挡或未检查时明确uninspected并needs_review，禁止把blocked写成完整。预检已经明确观察到图片形式的Facts时可记image-only并引用已保存图库，不在采集阶段OCR。DOM表格/结构正文需要保留HTML时显式用format:"html"，工具保存选定节点的outerHTML；旧raw仍保留兼容语义，不等于HTML。
detailCoverage.checkScope 必须为"website-text"：五项checks核对的是网页文字/HTML交接，facts的not-present只表示未发现文字/HTML成分表，绝不表示图库没有Facts。理由必须明确检查范围；没有实际查看原图前，不能写“没有Facts/背标图片”。保留完整图库与逐张查看原件是独立步骤；收割后发现已保存图库含Facts图片，不与文字版facts not-present冲突，不应仅因此中止。已在预检明确观察到的图片可记image-only，未分类图片仍完整采集交给旧Facts流程；不要求采集阶段OCR或从图片抄录成分。
收割前从lib/observed-details.mjs调用saveObservedDetails(outDir,{...basePreview,gallery:observedGalleryUrls.map(url=>({url}))},detailCoverage)。coverage包含version:"observed-details/1",reachedEnd:true,pageEvidence及逐区块sections，并对description/ingredients/directions/warnings/facts五项各作一个checks，区分captured/image-only/not-present/uninspected。schema和native-product-method.md有完整格式；not-present必须有检查证据和原因，不能因capture-only就跳过文字内容。机械工具只验证模型已经选定的方法、展开状态、图片及交接完整性，不发现或选择字段。把返回的detailCoveragePath原样写入capture-review.json；宿主会重读原件复验。任何uninspected均不能complete。
一次单品通过只证明当前任务；方法副本标记 candidate，不能把该次结果直接晋升为全站已验证 profile，也不能只改 successCount/lastValidatedAt 伪造验证。缓存中的旧通用 detailProfile 不可直接执行。
规格来自网站实际规格选项、SKU、variant 数据和可售状态，不从图片推断。确认 Shopify 后可显式调用 browser.harvestHooks.fetchProductSource 取得原始商品响应，再使用 observed method 的 platform 映射复用旧规格规范化；引擎不会自动请求平台接口。若平台JSON未含available布尔值，必须显式指定platform.offerSource为本次详情DOM来源，以读取同商品JSON-LD的规格库存；不能因为.json没有available就漏掉网页已有的库存状态。非平台规格用 variantMappings 指向实际保存的结构数据或节点。不因缺货、图片不能绑定而丢弃规格。
Sold out/Out of stock是库存状态，不证明规格不能查看。除真实权限/挑战边界外，缺货项也须实际尝试网站选项或明确观察到的规格URL，并保存操作及结果；未尝试只能记尚未观察，不能声称网站无法切换。不得用option-value ID、默认项或临时常量补不存在的variant ID，身份只能来自已核实的网站variants。单规格无法确认不丢其他完整规格。
基础商品有多个规格时，价格和 SKU 留在对应 variants，不把默认/第一个/首个有货规格的值回填到 fields。明确派发 variant URL 时才允许对应规格值进入 fields。保存 HTML 用 fetchPageSource，仅保存当前渲染状态，不导航重置选项；先展开需要的区块。页面身份、规格、币种、地区或一次性/订阅价存在冲突时保留冲突并 needs_review，不从推荐区补值。
fields.title 和 fields.brand 必须来自实际商品页面/该商品的平台数据，品牌不能照抄任务来源名称；保留品牌出处。其他页面原文字段原样保存，缺失留空，不推断成分。pageHtml 必须指向实际保存的详情 HTML。
采集实际产品轮播/图库全部原图，以及详情中实际展示的 Facts/背标图片。不要把整个 main 的所有 img 当图库；徽章、推荐商品、导航缩略图要区别开。
收割前在实际页面核实所有图库项及详情图片，把已观察到的完整原图 URL 数组作为 runHarvest(...,{observedGalleryUrls:[...],...}) 必填参数；原生单品不会使用通用提取器按关键词猜测出来的图片集合。不要根据文件名筛选或编造未观察的原图地址。
逐张查看已保存的图库，确认轮播所有项及后续图、折叠/延迟加载内容都已检查；不靠 alt/文件名关键词决定收哪张图。
保存 capture-review.json：{productUrl,selectedVariantId:null或实际ID,galleryUrls:[全部已保存原图URL],galleryComplete:true或false,variantsComplete:true或false,detailComplete:true或false,method:"实际观察与复核过程的文字说明，必须是字符串，不是字段方法对象",surface:"local_file",evidence:[相对截图/图片路径],verifier:"codex",imageAssignments:[{url,variantId:null或ID,basis:"product-gallery"或"variant-featured"}]}。
selectedVariantId 记录页面实际选中的规格ID，即使派发的是基础商品URL；这不改变基础商品任务身份，无法确认才填null。
imageAssignments 只记录网站数据或实际切换证据支持的图片归属；未明确绑定的商品共用图保留 variantId:null，不因此返回 needs_review，不强行分配给当前规格。缺失原图或规格未采齐才属于采集不完整；后续处理负责判断图片内容及适用规格。
多规格商品读取 variant-context.schema.json，为每个网站规格保存实际选中状态和独立方法，默认规格也一样；显式派发某一规格时至少记录该规格。先完成网站规格采集，再由宿主处理 Facts，不在浏览器里执行 OCR 或后续语义处理。
每个observed/mixed规格也要用其自身方法预览和saveObservedDetails保存详情证明，在context.detailCoveragePath中引用，然后再saveObservedVariant。复用明确共用的原件不等于复制兄弟字段，逐规格核对当前方法确实交接对应区块。缺少规格详情证明只使该规格Review；不拿基础商品detailComplete替代。
按实际资料是否隔离分两路，不按 URL 是否变化分路：独立资料用 status:observed，保留旧 galleryReview 和适用 galleryUrls；轮播/Facts 混着多个规格用 status:mixed、basis:variant-state、完整 galleryUrls、methodPath、reason 和 evidence，不需要先判断混合图归属。混合图库将在浏览器结束后由宿主调用旧 OCR 加 Codex 判断。URL 改了但图库仍混着（例如 Solaray）仍是 mixed；URL 不变但选中状态和资料确实隔离也可 observed。
observed 的 galleryReview 逐一覆盖基础商品全部 observedGalleryUrls；applicable/other-variant/unresolved、reason、实际查看的原图/截图 evidence 和 basis 必须完整，galleryUrls 恰好等于 applicable。依据只能是网站绑定、实际图像内容或明确网站共用声明；不能以轮播没变、null、图片顺序、文件名或 alt 推断归属。不能忽略有歧义的 Facts 图来宣布资料已隔离；这时应 mixed。不同每瓶份数/包装数量不得无条件共用。
website-shared 必须提供 sharedScope 网站明确声明的原文和确切来源，不能仅凭默认规格或同一图库。缺少声明时实际操作规格并保存 variant-state，可按混合资料交接；缺的是选中状态/原件而非图片归属时才 status:unresolved，记录实际尝试和阻塞物。OCR 不能补造采集证据。
收割前从 lib/observed-variant.mjs 导入 saveObservedVariant，调用 await saveObservedVariant(outDir,base,context,variantMethod) 保存每个 observed 或 mixed 的真实方法文件并执行预检；把返回的 {context,method,passed:true} 原样放进 preflight.contexts。methodPath 由工具返回，不能手写“HTML + JSON”这样的说明，也不能只保存内联 method 而遗漏文件。方法 productUrl 使用实际观察到的 URL；有独立规格地址时明确打开并核实自身身份后保存，不把客户端残留的旧初始化数据当新规格。URL 不变时提供 selectedState:{rule:本轮选中状态的精确来源规则,value:实际variantId}，宿主从原件重读，不允许用规格清单中的任意项冒充当前选中状态。保存 HTML 本身不导航。其他规格必须实际切换再保存；当前默认状态可以复用已保存 DOM 并另存方法。
预检 base 传 {...basePreview,gallery:observedGalleryUrls.map(url=>({url}))}。mixed.galleryUrls 必须含全部基础图库，不得先按关键词删图；observed 使用最终 galleryReview/galleryUrls。保存 variant-preflight.json 格式 {contexts:[{context:最终上下文,method:实际规格方法,passed:true}]}，仅使用 saveObservedVariant 实际成功返回的项；宿主按原件复核并逐项比对。改了方法或最终上下文就收割前另存修订预检，capture-review.json 复用通过的版本。确实无法获取某规格状态时只标该规格 unresolved，不把其他完整采集一同丢弃。
写最终 capture-review.json 时，存在通过预检的项就必须从 lib/observed-variant.mjs 调用 await readPreflightVariantContexts(outDir)，把完整返回值直接作为 variantContexts；不可手写或逐字段重建已通过的 context，这会漏掉 reason、selectedState 等证据。确实 unresolved 的上下文另外追加，不能冒充已通过项。最终交接必须按 capture-review.schema.json 中的逐规格 schema 校验，不能只检查顶层键；预检与交接必须原样一致。
禁止执行 semantic queue、enrich 或旧 API-ready 导出；后续系统用本次原件处理。`;

export const catalogInstructions = `按旧采集流程先视觉确认站点身份和完整目录族，制定路线与终止契约，再用 discoverCatalog 复用旧 ENUMERATE 阶段及 Shopify 目录对账。普通目录按契约遍历至零增长；符合旧有界规则的 Shopify 单目录可用页面/目录结果/对应接口完整集合相同及空终页证明，不强制重复遍历。证明选择在采前完成。
本任务已经绑定scope.source中的一个品牌和目录，直接从该入口开始；复用适用的已保存路线/profile，不重新发现全站品牌，不执行crawlTarget/crawlPortfolio整站调度，也不创建其他品牌任务。本站若为多品牌卖场，已配置的该品牌目录属于授权范围，覆盖旧skill的卖场默认排除；仍须核对商品品牌且不得采其他品牌。
采前用本次实际 productLinkSelectors 预览匹配元素、链接和它们所在的目录容器，与画面中商品网格的前后卡片核对；同样含商品链接的页头/移动导航/mega-menu/推荐卡片不是目录。例外（owner 2026-10-08，PureTrim）：站点确实没有任何目录/全部商品网格页、商品只列在页头产品菜单族（如 Products、Starterpaks）时，可把这些已展开的产品菜单作为目录，但须同时满足：逐个展开并保存菜单原始 HTML 与截图；选择器限定到该菜单容器；各菜单去重后的产品数与网站可比总数（公开 sitemap 的产品条目或平台目录总数）一致，并把该总数写入 termination.oracle（comparable:true）。Featured/推荐/畅销轮播永远不算目录。数量对不上或找不到可比总数时 complete=false 并说明。选择器要限定到观察确认的商品网格或上述产品菜单，不以匹配出若干合法产品 URL 代替范围验证。已有 profile 匹配到错误区域时，在正式 discoverCatalog 前局部修正并复用其余方法。
分页检查定位到商品网格末尾，观察其附近的页码、圆点、箭头、加载更多或滚动加载行为；到达网站页脚不证明目录耗尽，控件也不一定是 a/button 或带“下一页”文字。声明 none 前核对当前网格数量与网站可比总数；有差额就继续观察实际分页方法。可点击的分页先实际验证并保存 paginationActions。页面分多页时采用 enumeration，不因总数小于100就选要求全目录已呈现在页面的 Shopify 单页证明。
scope.siteKind是宿主实际品牌校验策略。multi-brand策略下每个entry.brand都必须有网站真实身份依据并与来源品牌一致；不能填null、照抄scope.source.brand或仅靠域名。即使视觉上像单品牌官网，动态来源也可能使用这个严格策略。正式遍历前在代表目录原件上验证实际品牌元数据规则，并保存出处；拿不到就明确身份证据不足。single-brand策略才允许卡片未印品牌时brand:null，由已核实的站点身份提供范围。不要遍历结束才发现没有可用品牌规则。
只发现产品，不进入逐个产品采集和 OCR。商品必须来自实际目录/导航；平台 API 库存不能直接代替目录产品集。
固定启动器保存 catalog.json（模型不手写）：{pages:[{url,htmlPath,screenshotPath,entries:[{url,title,brand:null或页面品牌}]}],complete:boolean,termination:{proof:"enumeration"或"shopify",exhausted:boolean,reason:string,method:string,evidence:[相对路径],zeroGrowthRounds:number,oracle:{expected:number|null,observed:number,comparable:boolean}}}。
每页/每个加载阶段保留原始渲染 HTML；每个 seed 留截图，最后耗尽状态留截图。entries 只能列出该页实际出现的产品详情链接。
所有目标目录覆盖完整且选定的完成证明通过、可比 oracle 无缺口时才能 complete=true。Shopify的catalog-coverage.json和逐份原始响应由机械工具保存，不能手写对账成功；子目录不能用全店接口背书。达到预算、发现循环、漏页或差额时 complete=false 并说明原因，不伪造全品牌完成。
标题和品牌按页面原文保存；去重按真实规范产品 URL。已有方法时不重复编写路线报告；保留本次实际视觉核验痕迹，固定启动器保存方法、分页与数量依据。
用户给的是一个已配置品牌来源，范围只限该来源；多品牌卖场不得把其他品牌放进来。`;

export const analysisInstructions = `分析入口属于官网、自营商店、直属品牌组合还是第三方卖场。视觉验证目录入口和至少一个真实商品，不使用固定选择器模板代替观察。
这是独立的品牌发现阶段，只输出品牌、入口与证据；可以查看代表商品核实身份，不枚举全品牌商品或进入单品材料收割。保存本次确认的入口/路线和适用profile供后续目录任务复用，由宿主另行创建排队任务。
用户提交的多品牌站点允许按真实品牌分别分析，覆盖旧skill的multi_brand_retailer默认排除。对站内品牌目录确认真实品牌身份；vendor名称仅为候选，大小写、渠道前缀或同品牌别名不能自动当成多个品牌。不同目录确属同品牌时保存覆盖该品牌的已观察入口，不猜造URL。直属品牌跨域仍只展开一层，广告/社媒/无关零售商外链不作为子品牌。
按以下顺序完成本次站点分析，不能把一个品牌的代表页试验当成整站任务结束：
1. 先观察并展开实际品牌导航/品牌索引，保存原始HTML与截图；沿模型观察到的真实区域枚举品牌候选和目录入口，去除重复链接，记录来源页、别名及尚不确定的项。不要只取Featured或第一个品牌。将候选清单、观察到的区域/方法、枚举是否完整及数量写入brand-candidates.json供追溯；候选不能直接标成verified。
2. 在逐品牌商品验证之前检查scope上限。清单超过maxBrands时立即明确needs-review、limitsReached=true，reasons写实际候选数、上限和未验证范围；保留完整候选清单，不截成前N个冒充完整，不继续逐品牌或扩大全站采集。候选别名尚不能确认时明确写候选数量，不声称已确认同样数量的品牌。页面/域名或时间预算实际触及时同样写明已完成与剩余范围。
3. 未超限时按清单逐一验证品牌目录与代表商品身份。正常完成一个品牌后继续下一个；“其他品牌尚未验证”是待办，不是停止原因，不能仅以multi_brand_retailer_requires_brand_by_brand_verification结束。只在真实权限/挑战、观察失败、身份歧义或实际预算边界时保留原因结束，不伪造所有品牌通过。
4. 代表商品只需核对真实品牌与目录归属。不要展开Ingredients/Facts/FAQ、检查整套图库或执行旧skill的单品完整性预检；这些属于后续单品任务。本站没有多品牌清单时，先以实际站点证据确认品牌范围，再按单品牌路线验证。
允许沿官方实际链接展开一层直属品牌，不递归。遵守 scope 中 maxBrands/maxPages/maxDomains 限额。
保存 analysis.json：{state:"completed"或"needs-review",brands:[{name,domain,platform:"shopify"或"woocommerce"或"jsonld",catalogUrl,productCount,countExact,wholeCatalog,discoveredFrom:{page,link},status:"verified"或"needs-review",reason:null或说明}],archiveKeys:[],reasons:[]}。
整个任务只保存一份 evidence-pages.json，顶层是平铺数组[{url,htmlPath,screenshotPath}]，合并所有品牌实际页面；共用同一份来源页原件只列一次，不按品牌名分组对象。每个品牌至少覆盖来源页、目录和代表商品的实际 HTML 与截图。brands[].domain填已观察catalogUrl的实际hostname（包含实际www或其他子域名），不是默认公司可注册域名。
超限且尚未验证任何品牌时brands可为空，候选保存在brand-candidates.json；不得为补齐代表商品而违反先检查上限的顺序。evidence-pages仅列实际已保存的HTML/截图对，htmlPath和screenshotPath不能null或引用不存在文件；额外截图放verification.evidence。discoveredFrom.page必须是实际看到该目录链接且已保存的页面，link为观察到的目标；不能把网站存在但没访问的品牌索引页写作来源。
保存 analysis-verification.json：{method,surface:"live_site",evidence:[相对文件路径],verifier:"codex",limitsReached:boolean}。
platform 是实际观测，不凭URL猜；不支持的自建数据结构返回 needs-review，保留原因。不能只因公司同名就确认品牌。
完整枚举之前 productCount 只报实际观察的商品数，countExact=false、wholeCatalog=false；页面声明总数和平台库存数可记notes/reasons，不得写成实际观察数。
本站所有已发现品牌均被验证且预算未耗尽才能 state=completed。不要调用 apply 或自动启动商品采集。`;
