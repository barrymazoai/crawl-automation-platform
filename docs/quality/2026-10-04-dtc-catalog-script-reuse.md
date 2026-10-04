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

7cfadc864bf120a7610b3c94c75280d2b384ecd5 已通过 pnpm check（22类型任务）及新增MJS
语法检查，经main push、Server二fresh Git clone/locked install/build于03:19:22Z部署，
仅更换空闲browser-worker。03:19:52Z Mini直接验证真实留存两页，逐URL集合相同、
标题品牌完整，当前页1/2、可用next控件1/0，输出
`manual-releases/catalog200-script-retained-7cfadc8/proof.json`。未调用浏览器或伪造新完成回执。

新实站scan `7ab75da9-9e62-42e6-ba88-877b0d22dfeb` 已单项入队，使用版本化候选。
商品队列仍paused，不把验证目录成功等同于所有商品处理完成。首轮结果与复用验证待追加。

首轮03:25:14Z complete/full=true、46项。实际点击已从第一页24项到第二页22项，
再经固定旧枚举器执行两轮24+22，第二轮growth=0，末页控件耗尽；同目录数量46/46。
公开脚本保存的SHA与实际执行源完全一致：
`f19defadef45bb3944467bcdd0dca152e3fbedaf04b0bad5409918d2cca38e1d`。
候选被原样复用，没有重新写成另一个翻页流程。36原件/6,093,939字节03:26:13Z全量R2
回读通过，03:26:23Z 1许可/4执行停止审计invalid=[]。新增46目录记录入商品队列，
该队列仍paused（688queued），不是46商品已处理完成。

03:27:03Z另建新scan `7c613ca7-e6e7-48d1-b38e-5c21da088421` 验证verified脚本复用，
待其终态再核对散列、重复入队和完整性。

该复用项正确加载verified脚本，未修改其源，但裸page.goto默认等load，在已提交且
interactive时超时，模型直接结束。03:29:21Z Review，尚未执行固定入口；不能说复用
完整采集通过。另由[202](2026-10-04-dtc-navigation-readiness.md)修正采前导航就绪边界。
12原件及1许可/4执行停止审计通过。后续HMW `f8cc235d-097e-4cbc-b1e3-d81c2c0a8b53`
03:29:26Z接续，沿既有6项小目录验证另一站点新建方法及固定入口。
