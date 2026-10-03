# DTC 材料规格身份与收割前对账

CRAWLV3-192，关联183/184/155。继续新版仅采材料出口的真实验收，不修改其他channel。

## Solaray 首项

1c3e142部署后，现有队列Magnesium Glycinate项
`c4d816c48cc616a083622b6172ea63fba4524e0f13e27fe64099d5fa7400e7cb`
于12:45:18.874Z首次开始，run`a1c175bc-b157-4762-bc17-a89cda96ca62`。
ready/running保持1/1，开始后即drain(graceSeconds=0)。其余644项及6个旧Review未动。

网站JSON及record实际保留两个variant，临时方法只存了一个材料状态，ID误用选项文字240ct。
即时排查曾误称没有读到平台规格，现已纠正：平台读取正常，错误在控件→真实variant身份
映射以及缺少120ct状态。脚本还将5个实际图库项的响应/缩略尺寸列成26个URL，删除height
参数，且复用方法无条件返回mixed，这些都不构成合格的可复用方法。

旧runHarvest12:48:04Z结束，模型随后自行needs_review/variant_material_incomplete。
12:49:01Z操作员取消精确parent；取消时模型和浏览器已经结束，仍在宿主收尾阶段，不能
描述为取消停止了正在运行的模型。12:50:16Z确认parent CANCELLED、无下游子流程、held=[]，
队列paused/644queued/7Review。没有启动Facts或写入新的产品结果。

101份R2原件/13,106,362字节全部大小/SHA-256回读通过。Codex12:48:25.194Z、
任务页12:48:25.554Z、round12:48:25.684Z及host CLI停止证明均早于12:49:54.973Z许可释放。
Server二任务目录末级`051155e72bfaf0ebb0a91b42602056b6c06de2acddad1119dd364666a1348dbc`。
Server一`materials183-solaray-first-*`保留请求与终态，`product-<runId>-stop-proof.json`和
`catalog-<runId>-r2-proof.json`保留清理与原件证明（后者内部为真实product归档路径）。

## 共用修复

固定启动器在runHarvest之前核对record的网站variant ID、selectedVariantId、材料scope，
拒绝未知/重复ID以及多规格缺项；单规格仍可使用基础材料，无法观察的规格显式unresolved，
不从其他规格填默认值。若方法显式请求平台JSON，用已有normalizePlatformVariants核对
返回规格集合，不新增隐式请求。宿主读归档后使用同一检查，不解析产品业务内容。

采集说明明确radio.value可能只是选项文字，应实际观察控件类型、选中身份和对应网站规格。
继续复用旧normalizePlatformVariants；图库按已观察媒体项选择实际原图，不拼接/删参数造
URL，不把响应缩略尺寸各算一项；共享方法不得硬编码所有商品mixed或本商品的观察结论。

不新增或运行单元测试。后续在Mini用本次真实错误材料与既有单规格材料直接验证，再做新的
有界采集验收；不覆盖旧原件或自动重跑原队列项。当前未宣称192或新版混合全链路通过。

## 部署与真实原件校验

`269d195fa356ae8903996d7d27e9a8562dab6b7f`完整pnpm check通过（22类型任务），main
推送后在Server二fresh Git clone/locked install/build，12:58:59.849Z就绪。没有单元测试。
12:59:48Z在Mini直接读两组原件：上述Solaray两真实ID为39660429836348/39660429803580，
材料选中240ct被material_selected_variant_unknown拒绝；HMW6旧原件
`ce451185-d317-48d1-99c7-f34510842f45`的合法单规格54759816167790通过。
原件未改，文件SHA和结果保存在Server二`manual-releases/materials192-retained-proof.json`。

13:00:20Z通过runs.submit启动新的独立Solaray验收观察
`2e2abe46-38ae-47d0-8180-4f212d8a2d32`。原取消队列项仍Review，批量队列paused，
644项未开始。新采集及下游真实结果待记录，不能用上述原件校验替代浏览器/混合流程验收。

## 后续实测：规范化对象字段用错

`2e2abe46-38ae-47d0-8180-4f212d8a2d32`于13:03:58Z结束采集，业务Review原因
variant_state_timeout，无下游子流程。方法调用了旧normalizePlatformVariants，但后续仍读
原始对象的variant.id（undefined），没有使用返回的variant.variantId，导致10秒等待永不满足。
只保存初始两份HTML，尚未到达材料对账/runHarvest；不能称新检查已在这次浏览器运行通过。
16份原件/2,096,215字节全量R2回读通过；4种停止证明早于13:04:16.908Z许可释放。

对照旧成功e3415944任务的实际脚本：它直接导航到真实variant URL并核对选中状态。
因此补齐工具返回字段的明确示例，以及允许沿旧方式直接打开variant.url，不强制改成radio
点击；新方法第一次保存前预览同一规则取得的实际ID，避免到完整脚本执行时才发现undefined。
另明确独立保存HTML/ID正确不证明资料已隔离，不能据此标independent。材料索引允许保留
额外元数据（如initialPage），固定转换只使用既定字段；不因无害的附加路径拒绝整份采集。
没有增加站点专用分支或业务解析。后续补丁和新验收结果另记，192仍In Progress。
