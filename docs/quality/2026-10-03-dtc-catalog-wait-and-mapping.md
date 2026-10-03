# DTC 目录执行等待与采前映射

关联 CRAWLV3-187/188，品牌队列147、整体验收151。用户要求直接在Mini实测，不新增或运行单元测试。

## 保留的失败现场

- Solaray 扫描 `c9961ba9-7f19-48dd-95c8-749964f438e7` 于11:00:07Z进入Review。原采集命令仍为in_progress，模型另开Ego观察并在10:58:36Z输出“停滞”；实际页面2/3/4在10:57:46、10:58:19、10:58:52Z持续保存。宿主清理后原命令才结束。不是目录为空或通知问题。
- 该脚本传 `productLinkSelectors: []`，默认语义规则没有匹配实际卡片，前后各等待15秒，再使用整页URL回退，混入导航/推荐。修复必须是先观察、验证、保存站点方法，不增加Solaray专用规则。
- Nature’s Truth 扫描 `4f1d38ba-b53e-4200-ad65-2a75413e7fee` 保存34页（17页加零增长复核），产出389个唯一产品条目，但brand全部null，终态为DTC.BRAND_UNVERIFIED。动态来源实际使用multi-brand严格策略，任务只拿到来源，未拿到策略说明。机械结果的391条URL中有两条是同商品带搜索参数，不能称为两个新增产品。
- Server一11:20Z逐文件回读R2：Solaray35份/14,074,251字节，Nature97份/47,477,773字节，大小及SHA-256全部匹配。每项均有四类停止证明，时间早于许可释放；held为空。证明保存在既有任务证据目录的 `catalog-<scanId>-r2-proof.json` 与 `catalog-<scanId>-stop-proof.json`。

## 修改

- 原生catalog入口要求非空、实际观察得到的商品卡片链接选择器。旧ENUMERATE/分页/原件保存继续复用；不能缺映射后落入默认规则或整页URL扫描。提示要求先预览链接、标题及品牌身份规则，再遍历，保存profile复用。
- 追加不可覆盖的 `catalog-progress.jsonl`，记录开始、每页原件已保存、轮次和结束；最终 `catalog-discovery.json` 仍只在结束写出，不能以其尚不存在推断卡死。
- 给模型实际宿主预算（当前15分钟）及同一工具调用的续等规则：running/session/cell必须等待到终态，不重叠启动Ego调用，不提前写替代结果或final。没有改宿主预算。
- 传递实际 `siteKind`，明确严格策略需网站真实品牌证据，并在采前确认。没有放宽验证、猜品牌、改变既有来源策略或写入产品内容解析。

## 验证边界

本地 `pnpm check` 完整通过，22项类型任务成功，JS语法检查通过。此时尚未部署；Mini新任务验收结果另行追加。旧失败记录/原件不覆盖，不自动重试失败业务；后续使用新的受控验证任务。

## 7974065 部署与新任务

11:24Z已通过main push、Server二fresh clone/locked install/build部署。新Solaray扫描
`cf836159-f462-472b-9d2f-3ffd20b2ece8` 11:24:52Z开始、11:32:24Z complete，645产品，
56页含零增长复核；真正采集命令item_20明确退出0后才整理输出，没有重叠观察或提前final。
当前645单品仅queued，产品队列仍paused。134份原件66,211,264字节R2回读hash/大小通过。

复查不能略过的缺口：实际使用卡片选择器，但公共profile未更新，只写了任务副本；采后修标题，
品牌仍为常量。187等待问题通过，188方法持久化继续补；身份转换缺少逐条原件回放另记189。
同页Shopify analytics按20项、可见卡片按24项分页，不能按相同页号/顺序匹配，也不能拿一部分
vendor命中替全目录背书。旧任务与原件保留，不通过批量覆盖修正历史结果。

后续188补丁：旧discoverCatalog直接将实际执行的映射合并保存到既有profile，再生成
catalog-method-profile.json和SHA-256回执；宿主校验副本、回执和发现结果的一致性。
参数未提供profileDir即明确失败。规则继续来自模型观察；没有增加默认关键词、产品字段提取器
或Solaray专用分支。静态检查通过，部署/直接验收待回填。

## bd443dd 的直接验证与190

bd443dd已Git部署Server二。用Solaray真实任务保存的卡片规则执行新持久化函数，公共profile与
任务副本逐字节一致，SHA-256 `8b3ce9f37fc486fa64431f615f8dd26496dccf98c60e44357c7eb92b9a68ef9c`。
这是已有真实规则的本地重放，不是重新抓网页；旧profile备份及新回执位于
`manual-releases/catalog188-retained-solaray/`。旧采集目录未改写。

新HMW扫描 `5299292c-8850-45e5-ad86-65df4852216f` 11:43:00Z开始，11:49:19Z Review，
代码PIPELINE.ACTIVITY_UNRESOLVED。首次目录已保存1页，返回seed_pagination_mapping_missing；
模型改脚本到capture/catalog-run-2重跑并返回complete，但宿主仍读取原根目录。没有接纳该次
输出，也没有重试旧商品。11:50Z held为空、cleanupPending0。不能将第二次子目录成功称为验收通过。

此行为单独记190：开采前验证逐seed分页声明；固定宿主capture根目录；开始后在任务根写单次
执行标记，换子目录/新CLI不能重跑。采前参数缺失可以修正，已开始的失败保留并终止。补丁
静态检查通过，无单元测试；新实站结果待记录。

## 8745dba 实站通过（12:01Z）

Server二经main/fresh Git clone/locked install/build部署8745dba。新的HMW扫描
`8065832a-bbe3-422a-a1c3-cbe9a79eb1a7` 11:54:04Z开始、11:59:48Z complete：
1页、6产品、full=true、recent6、added0、queued0。采前显式声明none，目录在11:57:21Z
只开始一次，11:57:23Z完成页面/接口6项及空终页对账；有任务根catalog-attempt.json、
没有catalog-run-*重跑目录。本次正向验收通过；未故意触发第二次浏览器采集来测试拒绝。

公共HMW profile与任务副本逐字节一致，发现结果method与回执一致，SHA-256为
`fcd279b3108f14904c86019540a5c99509f7c88a38754314bb642b82d2fa034b`。宿主完整校验通过。
35份R2原件4,649,401字节回读大小/散列全部通过；Codex11:58:55.606Z停止、任务页
11:58:56.016Z消失、round11:58:56.175Z结束，早于11:59:48.452Z释放许可。
证据仍在Server一既有任务目录，文件名catalog-<scanId>-{r2,stop}-proof.json。

187、188、190可交Review；189仍未解决：目录身份转换需保存可复用、能在原件回放的映射，
严格品牌策略不能只接受常量。用留存HTML修正/转换身份元数据本身允许；问题是映射/证据
没有随方法固定，而非要求抓取阶段解析产品内容。整个DTC未宣称全部完成：真实同站多品牌、
新单品材料/混合变体端到端仍待验收。单品队列继续paused，645 queued及6历史Review保留。
