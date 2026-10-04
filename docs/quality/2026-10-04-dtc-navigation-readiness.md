# 已提交导航的就绪状态与目录复用验证

CRAWLV3-202，关联200/151。复用验证 `7c613ca7-e6e7-48d1-b38e-5c21da088421`
已从公共缓存取得verified脚本f19defade…，但03:29:21Z在视觉采前结束Review。原调用
`await page.goto(sourceUrl)` 默认等待load；Ego明确报：15000ms后仍未load，导航已提交到
正确 `https://www.natrol.com/collections/all-products`、document.readyState=interactive，
建议继续当前页。模型没有再读当前状态/截图，故尚未进入固定目录入口。

已有 browser.tab.goto 使用DOMContentLoaded。本轮只给已有宿主browser-preparation模块
增加同等的任务页navigate入口并要求采前使用：默认等待domcontentloaded；明确的
PageNavigationTimeoutError且包含已提交说明时，只读检查当前准确URL及interactive/complete，
保留warning回执并交回模型继续核对实际内容。不是重新导航，不重试失败业务，也不放宽
URL冲突、无法访问、用户控制、权限或挑战边界。DOM就绪不等于内容完整，后续仍检查真实
商品状态与截图。单品方法里的既有tab.goto保持。

12原件/157,724字节于03:32:24Z全量R2回读通过；03:32:34Z 1许可/4执行停止审计
invalid=[]。已验收脚本缓存不变，原Review不改。HMW小目录回归已于03:29:26Z串行接续，
等其自然结束再部署；新修复验证另建明确任务，不重排旧失败。静态检查和Mini实测结果待补充。
