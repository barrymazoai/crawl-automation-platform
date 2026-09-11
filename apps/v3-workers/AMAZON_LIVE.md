# Amazon Brand 主流程

当前有限部署与实测见[2026-09-11报告](../../docs/quality/2026-09-11-amazon-mainflow.md)。Mini原LaunchAgent共90角色，单一4188入口支持GNC/Swanson/Amazon。UNIQUE E仅选中ASIN B000REPUY0，来源revision2、地区JP。真实请求经过7图OCR/1文字/3视觉后以产品Review结束，0新增保存；流程闭环不等于标签质量或全目录验收。

构建入口：`pnpm --filter @crawl-automation/v3-workers exec node --import tsx scripts/build-amazon-mainflow.ts`。每角色独立启动，使用`V3_WORKER_ENABLED/CONFIG`及`V3_AMAZON_LIVE_ENABLED/CONFIG`私有0600配置。运行配置、队列和构建指纹由runtime验证；不手工复用旧产品任务。

| 角色 | 职责 |
| --- | --- |
| amazon-control | 校验持久Brand/source快照，准备目录、检查收尾 |
| amazon-catalog-source | 有界公开店铺投影，R2保存及精确关页 |
| amazon-catalog-ledger | 登记页面、稳定发现、派发及目录封闭 |
| amazon-product-input | 从已登记发现生成不可变ASIN任务与下游计划 |
| amazon-capture | 读取选中ASIN、店铺归属与公开图库；独立Activity关页 |
| amazon-file | 同一会话逐张取得实际原图，保存R2 |
| amazon-review | 记录浏览器阶段故障，不自动重投 |

计划、17种label原子角色及四种Workflow各自使用独立队列，复用公共组件。部署job ID为避免与旧角色冲突可增加`amazon-`前缀，runtime role保持能力注册原值。内部队列scope字符串是不可变标识，不决定业务channel。单一资源控制器继续browser1/model1/CPU2/OCR2，并监测三个渠道的交接积压。

Brand入口只接受真实`collection_submission`及精确source revision；目录发现须在账本，产品ASIN/页面身份/同店GUID须一致。Amazon ASIN是选中产品listingId，variantId=null；未观察全部规格时明确selected-only。公开页面的`clp/<ASIN>`仅用于规范链接身份校验，不作为导航入口。

目录逐页发布，不等待产品；已派发产品独立收尾。目录页先留证据后关闭，关闭确认后才能发ready。只接受公开ProductGrid卡，排除广告和根外推荐；配置后页须出现在前页同店导航。末页、缺控件或达maxPages均不证明全店完整，因此当前来源保持unknown，不推断缺席。

产品持有全局浏览器许可，capture→plan→逐文件获取是不同Activity。图库实际点击每个可见图位并等待对应大图加载，不读取私有站点脚本对象或拼接高清URL。每个原图持久化后通知公共`ChannelStreamingLabelWorkflow`，OCR与后续下载重叠；精确关页并释放浏览器许可后发送sealed，最终汇合只使用留存证据。

成功、Review、失败及取消均走关闭路径；用户控制是硬边界。未知交接或关闭仍隔离许可，冷恢复不重新导航。人工恢复必须匹配原Run、许可和精确目标，保留关闭及退出证明后释放；不能仅凭Review或关闭回执宣称已安全释放。

准备和切换工具分别为`prepare-amazon-resident.ts`、`replay-amazon-resident.mjs`、`activate-amazon-resident.mjs`，均限定Mini隔离测试目录。准备不提交采集；切换前必须排空、校验测试/回放/指纹/业务基线，保留旧manifest/plist，切换失败回滚。`audit-amazon-resident.ts`只读核对健康、旧记录和全部所属目标不存在。不要直接重跑一次性准备或恢复脚本。

原R2/Review不修改；暂不启用ScraperAPI，不改模型策略，不把JP页面当US配送验收。多店通用布局、全店穷尽、多轴变体及其它节点仍需独立明确范围的真实证据。
