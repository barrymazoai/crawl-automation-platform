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
