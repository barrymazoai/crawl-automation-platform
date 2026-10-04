# DTC 母站拆分子品牌实测

CRAWLV3-147 / 151。此前已验证三个独立单品牌任务串行及超限拒绝，本轮补上同一母站
发现多个独立品牌的正例。母站官方入口为 https://www.vytalogy.com/portfolio ，其 Our Brands
指向 Natrol 与 Jarrow 的官方网站；此选样依据不替代 Mini 实际观察。

01:53Z 前项 Nature’s Truth 采集及下游全部停止、held=[] 后，首次创建分析
`71a66fca-3a0a-42d6-9b63-4d316b28d020`。仍使用现有 50 品牌/一层外域限制，Server 二
`41e4a5b` native Ego Worker；DTC 品牌与商品队列均保持暂停。未重新运行 Nutriessential
超限任务。Server 一留存 `multibrand147-vytalogy-{intent,request,start,latest}.json`。

至 01:58:30Z，模型分别保存母站、Natrol/Jarrow 官网、目录及各自代表商品的 HTML 和截图。
候选入口为 `https://www.natrol.com/collections/all-products` 和
`https://jarrow.com/collections/all`，来源均为母站原始品牌链接。候选结果尚不等于已应用，
只有正式 analysis completed、原件/清理核验后才使用原 apply/enqueue 创建独立目录任务。
计划验证同请求及不同请求幂等、父分析关联、独立串行任务及失败隔离；商品队列另行控制。

## 真实交接错误及留存验证

模型最终 complete，宿主却于 01:59:45Z 失败。Temporal 原因明确为 Zod：expected array,
received object。模型把 evidence-pages.json 按品牌分组，而原提示写“每个品牌保存”同名文件，
消费者只接受平铺数组；此外 Natrol 声明 domain=natrol.com 与实际目录 www.natrol.com
会触发严格字符串不等。没有应用失败分析或创建品牌任务。

CRAWLV3-198 修正材料表示边界：同一 Page schema 支持数组/品牌分组，去掉确切重复的
URL/文件对；保留真实页面、文件、来源与限额校验。仅兼容 www 与不含 www 的主机表达，
输出采用已验证目录实际 hostname，不接受不同子域/外域的身份替换。提示明确要求全任务
一份平铺数组，以及真实目录 hostname。

35 份原件共 9,356,807 字节在 02:03:44Z 全量 R2 回读校验通过；失败 Workflow、1 许可、
4 执行均先停止后释放，02:03:03Z invalid=[]，原失败记录保留。
验证工具 `tools/verify-dtc-retained-analysis.mts` 从 R2 下载这个明确样本，核对每个文件的
身份/大小/SHA、原请求 URL/限额，再调用同一分析转换函数；没有浏览器或模型调用。
可选 `--register` 只对未应用的失败分析，通过既有 SiteAnalysisService/Runner 登记一份
新的派生分析，附上原捕获/归档散列和派生证明，旧分析必须前后完全不变。它不自动 apply
或启动品牌/商品，后续仍走现有 API；这不是重新执行原业务或覆盖失败记录。
实际验证、派生分析和入队结果待追加。
