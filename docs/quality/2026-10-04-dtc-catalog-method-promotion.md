# 目录方法在完整性通过后才保存复用

CRAWLV3-201，关联 183/199/200/147/151。Natrol 新验证
`8917c5a0-e373-463c-b9bf-56c2e539cae4` 在 f844eb3 上仍使用失败缓存里的导航选择器，
发现 17 项、页面总数 46，于 02:39:18Z Review/oracle_mismatch。新提示确实进入任务，
只改文字未使真实目录通过。199 的同名文件冲突没有复发，200 的网格/分页问题仍未通过。

代码核实 retainCatalogProfile 在枚举之前就 saveSiteProfile，失败候选因此覆盖了公共
方法。修正不增加模型复审：入口仅写本任务候选与散列回执；原 DtcAgentBrandScan 的
身份、页面、目录/轮次/总数校验通过且 complete=true 后，宿主才保存这个确切版本。
不完整、Review、异常路径不更新公共方法。catalog 模型不再获得公共 profile 写目录授权，
仍能读取方法并在当前任务局部修正；产品/分析的原有行为保持。

真实失败证据及停止证明全部保留。新验证工具
`tools/verify-dtc-catalog-profile.mjs` 只在 Mini 的独立缓存使用真实 Natrol/HMW 原件，
检查候选不创建公共条目、不替换已有条目的字节/文件身份，以及已验收 HMW 方法精确保存。
没有网络采集、模型请求、单元测试或历史业务结果改写；不把这个验证冒充实站目录成功。
pnpm check 已通过（22 类型任务），部署/留存验证和新的实站验证结果待追加。

05e8445 于 02:45:27Z 经 main Git fresh clone/locked install/build 部署 Server 二，只切换
browser-worker。02:45:44Z 上述 Mini 真实留存验证全部通过，proof 位于
`manual-releases/catalog201-retained/proof.json`。失败候选 SHA 为 09b440fb…，成功 HMW
方法 SHA 为 fcd279b3…；检查未调用浏览器/模型，未写生产方法缓存。

原 Natrol 公共 profile 与失败回执完整 SHA 09b440fb65b761d044ae6b08f1df0658eedb3c9d13c566e1b649017580c80b35
相同，02:45:20Z 已保存完整备份 `manual-releases/catalog201-invalid-natrol-profile.json`
及同名 receipt 后撤下其活动路径，确认不存在；只撤下这个已证实无效的目录方法缓存。
旧捕获及 R2 未改。随后手工创建新的单项 Natrol scan
`1ed4f3ac-79ca-45b9-8fc7-d1fc827ed630`，商品队列仍 paused，实站验收待其终态。

该 scan 于 02:52:16Z Review，实际发现主网格两页 24+22=46 项；失败发生在模型自写
enumerate 的完成回执聚合，详见 200。公共 Natrol profile 在执行中及 Review 后均仍
不存在：失败候选 SHA bf11d243…只留在本任务，没有晋升。02:53:54Z 全部 30 个文件 /
2,716,842 字节 R2 大小与 SHA 回读通过；02:54:09Z 1 Workflow / 1 许可 / 4 执行的停止
审计 invalid=[]。两队列 paused，held=[]。这证明真实失败路径不会污染公共缓存；
正向晋升目前仅 Mini 已验收 HMW 原件隔离缓存验证通过，不能说新的 Natrol 完整目录已通过。

9c51e7a 上的第二个新 scan `cf03ab1c-d195-4bda-a42b-957d9df35b45` 于03:08:57Z
仍 Review（分页判断缺陷200）。03:10:48Z 再次确认公共 profile 不存在，候选
`9a782d6efdbe4de224ca4439fecb1e8376ff50465692cb37071b3bbb1cb561e5` 只留本任务。
33 原件/2,735,107 字节全部 R2 回读通过，1许可/4执行停止审计 invalid=[]。
201 以缓存修正范围交 Review；正向真实新目录未通过的限制仍明确保留。
