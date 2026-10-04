# 固定目录启动器与已观察站点脚本复用

CRAWLV3-200 / 183 / 147 / 151。上一轮两页46项已实际取得，但临时enumerate封装将页面
记录当完成记录，后续从零观察又漏掉第二页。只补提示未使目录可靠，本轮对齐已在单品
使用的机制：宿主固定run-capture，模型只维护catalog-method的prepare/projectPage。

固定入口仍使用旧discoverCatalog/collectProductUrls，只负责遍历、保存原件与方法散列，
再从各页原件机械映射目录URL/标题/品牌。它不提取产品业务字段，不另建关键词提取器。
目录页投影须与本页发现URL精确相同，同目录可比数量每次从页面取，差额不能成为成功。
原有身份、页面、轮次、目录耗尽验证通过后才保存确切脚本，缓存按完整sourceUrl隔离。
失败候选不会替换已验收脚本，旧Review与档案不变。

Natrol候选脚本来自1ed4f3ac保存的真实两页：`.product-item a.h7`、`#pagination .next-page`
及末页`!pointer-events-none`状态；数量来自当前`span[x-text="count_products"]`，品牌
来自已观察的Corporation JSON-LD。不硬编码商品、46项总数或固定页数。通过版本化方法
登记交给新任务局部验证，仍标candidate；不是在Worker添加品牌专用判断分支。

计划在Mini先直接核对两页原件的链接/标题/品牌与控件状态，再做当前页面实际点击、
完整目录与脚本保存验证，最后新任务验证确切脚本复用。静态检查与实测结果待补充，
不新增或运行单元测试。
