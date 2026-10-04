# 目录区域与图形分页预检

CRAWLV3-200 / 147 / 151。Natrol scan `78b25d2d-944d-43ca-911a-b411ffe82e2b` 在
`99c716d` 上于 02:25:47Z 进入 Review，原因 DTC.CATALOG_END_UNVERIFIED。
只读 Mini 留存 HTML 确认，实际选择器 `a.rounded-nl[href*='/products/']` 匹配 34 个
页头/移动 mega-menu 链接，去重 17 项，main 内命中 0。真实 main 第一页有 24 个产品；
同一 collection 原始接口第一页 46 项、第二页空，说明保存的 17 项不能算完整目录。

实际 `#pagination` 含两个图形页码、可用 next-page div 及 onclick 分页行为。
模型却声明 paginationMode=none；listing-end.png 实际仅为网站页脚，未验证商品网格
末尾的图形分页。Shopify 完整集合校验正确阻止了不完整结果入队。

修正已有目录采前指令：用实际选择器预览目录区域与画面卡片对应，排除导航与推荐；
检查商品网格末尾的实际分页，不能仅凭网站页脚或没有文字按钮声明 none。可比数量有差额
时继续采前观察，保存实际点击方法；分多页使用原 enumeration。沿用既有模型判断、方法
profile 与预检文件，不增加通用关键词提取器、品牌专用分支、强制采后审核或业务字段解析。

失败任务 1 Workflow / 1 许可 / 4 执行停止审计 02:27:40Z invalid=[]；原失败保留。
33 份原件 / 3,927,142 字节于 02:27:44Z 全量 R2 大小/SHA 回读通过，证据位于 Server 一
`dtc-native-20261002/catalog-78b25d2d-944d-43ca-911a-b411ffe82e2b-{r2,stop}-proof.json`。
部署和新 Mini 受控实测结果待追加；不新增或运行单元测试。

f844eb3 于 02:29:55Z 完成 Server 二 Git 部署。新 Natrol scan
`8917c5a0-e373-463c-b9bf-56c2e539cae4` 仍用旧导航选择器并把图形分页当滚动加载，
02:39:18Z 以 17/46、oracle_mismatch 结束 Review。实际 prompt.txt 已包含新指令，
不能把已部署提示称为该问题已修好。候选方法在采集通过前就写进公共缓存的具体缺陷
另由 [201](2026-10-04-dtc-catalog-method-promotion.md) 修复。1 许可 / 4 执行停止审计
02:43:39Z invalid=[]，本轮旧任务不自动重试。

撤下失败缓存后，05e8445 上的新 scan `1ed4f3ac-79ca-45b9-8fc7-d1fc827ed630` 已正确选择
`.product-item a.h7`，两页分别 24、22 项，唯一总数 46；02:52:16Z 仍 Review。
实际 run-capture.mjs 另写 enumerateObservedPages，将 onListingPage 页面对象（无 status）
与两个 status=complete 的 seedReports 混合，再 every 判 complete，故产生假 incomplete。
也不应把多页目录拆成 maxPagesPerSeed=1 的手写遍历回调。现有 collectProductUrls 已支持
观察到的点击分页和独立完成回执，改为明确复用默认旧枚举器并提供最小参数调用参考，
不另加品牌引擎、不改变已保存的失败结果或完成判据。实站验证待新修正部署后执行。

此失败 30 原件 / 2,716,842 字节 R2 全量回读通过，1 许可 / 4 执行停止审计 invalid=[]。

9c51e7addc027204d1c43d000aaa0f07b7f71b9b 已于 02:56:43Z Git fresh clone/build 部署
Server 二，pnpm check 通过，无单元测试。新 scan `cf03ab1c-d195-4bda-a42b-957d9df35b45`
02:57:32Z 启动。实际脚本已不重写 enumerate，但模型又把 footer 当分页检查位置，声明
scroll、paginationActions=[]。只读下载并实际查看 preflight-pagination-4.png，内容确实是
网站页脚而非商品网格末尾；命名不能作为已观察分页的证明。

03:06:44Z 默认旧枚举器重复第一页，机械零增长完成但只有 24 项。模型随后 catalog.json
如实 complete=false、expected=46、observed=24；公共 profile 此时仍不存在。额外读取
`/collections/all/products.json` 和 `/products.json` 得到 48 项，它们不是派发的
`/collections/all-products`，不应把 46/48 称为同范围官网冲突。上轮保存的正确两页 46 项
与早先同 collection 响应逐 URL 比较 missing=[]、extra=[]，证明问题仍在路线判断。

本轮不能交付 200 已修好。最小默认调用参考解决了多余 wrapper，却不足以使采前观察可靠。
后续应复用已验证的网格/分页观察并局部修正方法，不能每次丢弃有效步骤、重新发现后再
把页脚当目录耗尽；也不能仅以模型写入 verifiedVisually=true 宣布已验收。旧失败与原件
保留，本轮结束后先完成归档/停止审计，不继续原样增加失败尝试。

03:08:57Z 此项终态 Review / DTC.CAPTURE_REVIEW。03:09:58Z 全部33份原件 /
2,735,107 字节 R2 大小与SHA回读通过；03:10:06Z 1 Workflow / 1许可 / 4执行停止审计
invalid=[]。03:10:48Z 公共 profile 不存在，实际脚本确认没有自定义 enumerate。
目录与商品队列均 paused、held=[]、cleanupPending=0。200 保持 In Progress，未宣称通过。
