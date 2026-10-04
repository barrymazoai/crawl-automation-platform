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
Jarrow 的 Codex/任务页/round 在 02:19:57Z 停止，Activity 在 02:20:11.998Z 结束，
许可在 02:20:42.138Z 释放。Natrol 随后于 02:20:47.254Z 自动开始独立目录任务，
先清理后领取、前品牌失败未阻断后项的时序成立。详见
[199 修复记录](2026-10-04-dtc-catalog-profile-owner.md)。

Natrol 于 02:25:47Z Review：选中了导航菜单中的 17 个产品，真实网格第一页 24 个、
同 collection 接口 46 个，且漏判图形分页；完整集合校验正确拒绝。
[200 记录](2026-10-04-dtc-catalog-region.md)保存具体选择器、区域与分页事实。
33 原件 / 3,927,142 字节 R2 全量通过，1 许可 / 4 执行先停止后释放，invalid=[]。
两旧 scan 和父分析关联保持原样，不能把它们改写成目录成功。

199/200 修正已于 02:29:55Z 随 f844eb3 经 main Git 部署 Server 二。手动创建两项新的
受控目录验证，原失败不重排，商品处理保持 paused：
Jarrow `5f83464f-a782-4cb2-8911-99e1acb589f0`、Natrol
`8917c5a0-e373-463c-b9bf-56c2e539cae4`。前者 02:33:20Z 因模型流连接中断在预检时结束，
未到正式目录，不能判断补丁正向通过；12 原件 / 1,010,983 字节全部 R2 校验通过，
1 许可 / 4 执行停止审计 invalid=[]。后者 02:33:25Z 接续开始，结果待核验。
这些是同一已核实品牌来源的修复验证，不冒充原父分析任务首次就已完整成功。

后项 8917c5a0 于 02:39:18Z Review，仍复用先前错误目录候选，17/46；
[201](2026-10-04-dtc-catalog-method-promotion.md) 已修正候选过早写入公共缓存。
05e8445 上的新验证 1ed4f3ac 已发现两页 46 项，但模型多写了一层遍历/完成回执聚合，
将普通页面记录当作完成记录，仍 Review。该任务的 30 原件已全部 R2 回读，停止审计通过，
没有把失败方法再次写进公共缓存。新的 9c51e7a 直接指导复用旧默认枚举器，已于
02:56:43Z 部署，仅单项 Natrol `cf03ab1c-d195-4bda-a42b-957d9df35b45` 在受控验证。
此时母站拆分、幂等、串行及失败隔离已验证；不能声称两个品牌的完整目录均通过。

cf03ab1c 最终03:08:57Z Review，分页预检再次误判，虽已复用默认枚举器仍只观察24项；
详见200。所有33份R2原件与1许可/4执行停止审计通过，两个队列已paused、held=[]。
本轮未继续原样增加失败尝试；199/201修正交Review，200目录完整性仍未通过。
