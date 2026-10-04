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
## 留存验证与独立品牌入队

Server 二于 02:09:00Z 经 origin main 全新部署 `99c716d`，只切换 browser Worker。
验证工具首次运行遇到本地材料缓存键缺少命名空间的问题，在任何分析登记前停止；
`54c6bbd` 修正工具缓存前缀，失败输出目录保留，没有重跑浏览器或模型。
Server 一从 Git 新建验证 checkout 并完成锁定依赖安装、构建；常驻 API/Worker 未切换。

修正工具后，母站 35 份原件的身份、大小、SHA 全部通过；同一转换函数得到 completed、
两个品牌。另用 Nature’s Truth 旧平铺数组样本验证，25 份 / 4,616,065 字节全部通过，
仍为 completed、一个品牌。未增加或运行单元测试。

通过现有 SiteAnalysisService/Runner 登记新的派生分析
`50b6b4f8-cd20-4517-879e-14ed93fc0f86`，旧失败分析前后完全相同。
派生出处保存在 `v3/dtc-retained-analysis/50b6b4f8-cd20-4517-879e-14ed93fc0f86/provenance.json`。
Server 一验证输出分别为 `manual-releases/analysis198-vytalogy-54c6bbd` 和
`manual-releases/analysis198-nature-54c6bbd`。CRAWLV3-198 已进入 Review；这只表示修正已供复核，
不表示全部 DTC 验收完成。

02:13:05Z，通过原 apply/enqueue API 创建两项独立目录任务：

| 品牌 | scan ID | 目录 |
| --- | --- | --- |
| Jarrow | `16d8f89e-71a4-4d94-b3cb-c986be79ec3a` | `https://jarrow.com/collections/all` |
| Natrol | `78b25d2d-944d-43ca-911a-b411ffe82e2b` | `https://www.natrol.com/collections/all-products` |

同一 requestId 重复 apply 的结果完全一致；新 requestId 再 apply 也复用相同 source 和
scan ID，没有新增任务。两任务均能从父分析查询到。证据为 Server 一
`dtc-native-20261002/multibrand147-vytalogy-apply-{intent,first,proof}.json`。

确认 held=[]、cleanupPending=0 后手工启动品牌目录队列，并发 1；商品处理队列保持暂停。
02:16:56Z：Jarrow running、Natrol queued，未发布目录结果；discovered=0 是尚未完成时的
状态值，不能解释为网站没有商品。02:17:24Z 只读执行材料显示 Jarrow 已保存实际目录、
分页和代表商品预检 HTML/截图，正式目录尚未结束。串行衔接、最终完整性和清理证据待任务结束核验。

Jarrow 于 02:20:42Z 进入 Review：模型的 setup-preflight.mjs 提前写入
catalog-method-profile.json，与 discoverCatalog 自动留存的同名不可覆盖输出冲突，尚未开始
翻页即 EEXIST。CRAWLV3-199 单独修正提示中的双重写入职责，不新增品牌专用逻辑。
26 份原件共 4,644,255 字节于 02:23:15Z 全量 R2 大小/SHA 回读通过；失败 Workflow、
1 个许可、4 个执行在 02:23:07Z 停止审计 invalid=[]，旧 Review 与证据保留。
Natrol 随后于 02:20:47Z 自动开始独立目录任务，证明前品牌失败没有阻断后项领取；
这一时序仍需与确切释放时间一起核验。详见 [199 修复记录](2026-10-04-dtc-catalog-profile-owner.md)。
