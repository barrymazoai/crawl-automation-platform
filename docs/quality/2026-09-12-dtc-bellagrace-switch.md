# Bella Grace wellness 对照测试准备

用户指定入口：https://shopbellagrace.com/collections/wellness。范围仅此分类，不将 Bella Grace 其他分类纳入本轮。此次完成站点预检、分类目录代码支持、Brand 来源配置及 Mini 配套切换；尚未提交真实 Bella Grace 采集。

## Windows 健康修复验收

用户报告 Windows 已部署 5675aac，23 JS、32 Skill 文件、doctor 和 routing 通过，120 秒 5 次采样健康。Mini 在 12:29 和切换前 12:52 UTC 独立确认三个 poller 使用 7f0f01ebd46f7b4469ef0f6459701c4723d77d2b1aea9eae1855420cb67da464，节点 RUNNING，五项资源健康，无遗留许可、提交锁或在途提交。

用户报告 Supervisor 13820、capture 1624、catalog-source 16656、file 11432；session 9f5e0b44-14ca-4f86-aa48-b88af031a73b。Mini Workflow runId 为 01a09592-01c1-7f00-bcd7-bb6f4edd16ca。Windows 的这次健康修复部署成功不等于已经切换 Bella Grace。

## 真实站点预检

Mini 首屏截图确认 Bella Grace 品牌目录可打开。页面根节点 main/#MainContent 均唯一；目录 DOM 去重后 7 个商品 URL，与 /collections/wellness/products.json?limit=100&page=1 的 7 项一致，page=2 返回 HTTP 200 / 空 products。

| 目录商品 | URL 路径 |
| --- | --- |
| RESTorative Sleep Gummies | /products/restorative-sleep-gummies |
| Elixir | /products/elixir |
| Bella Melts | /products/bellamelt |
| BellaTrim | /products/bellatrim |
| Bella Melts 3-Bags | /products/bellamelt-bundle |
| Healthy Weight Stack | /products/bellamelt-launch-pack |
| The Confidence Reset | /products/the-confidence-reset |

正式任务需要据原始商品证据判断组合装，不提前把 7 个链接算成 7 个完整商品或声称三项已经跳过。

Sleep 与 Elixir 两款详情的 #MainContent 根节点均唯一，商品标题匹配。实际页面图片来自 shopbellagrace.com 与 cdn.shopify.com；页面存在推荐其他商品的图片，正式 Worker 应继续使用原 Skill 定位当前商品图库，不能把整个 main 下的所有 img 混成当前商品图片。

Mini 的后续截图封装出现 Page.captureScreenshot 超时，视口截图备用路径也失败；URL、标题和 DOM 读取仍可用。预检明确标记 fullGalleryVisuallyVerified=false，没有创建或晋级正式方法 profile，也没有宣称 Supplement Facts 已提取。完整图库、原图、标签及变体由 Windows 真实任务验收。

## 分类目录修复

此前目录结束证明只接受 /collections/all。分类页即使真实采完也只能给出 unknown，无法据此区分网站问题与适配限制。

源码提交 b1b7f865df14b50b7cd059f430ddb8aea5210ccd 增加 shopify-collection-products/1：只接受当前分类自己的 products.json、实际 DOM 链接、相同商品集合和空末页。错误分类、全店接口、版本串用、目录外商品、缺末页、过滤 query/hash 均不能通过；旧 shopify-all-products/1 继续兼容。每页 100 项、最多两次接口读取等边界保持不变，不能把大目录或受限读取冒充完成。

本地 build:dtc 和类型检查通过。Mini 最终覆盖 77 项测试：dtc-live 31、dtc-legacy-evidence 34、dtc-node-session 9、dtc-node-control 3。首轮遗漏 V3_CHANNEL_FIXTURE_ROOT，造成依赖该变量的测试未能运行；补上既有 Mini fixture 目录后，受影响的两组 65 项全部通过，日志保留。

新校验器还在 Mini 对真实预检响应执行验证，DOM/分类接口匹配、7 项及空末页全部通过。这是目录预检证据，不是 Windows 已完成业务采集。

product-workflows.cjs 与前版逐字节相同，SHA-256 为 907d3dcd4dea521e15d53b74516ffe213016a5d7a9910865fb48b27d7e80d7be；沿用该完全相同 bundle 已通过的 14 条真实历史回放证据，没有声称本次重新回放了 14 条历史。

## 部署身份与状态

- Brand：901e4604-30e5-48b0-a55f-3c2d0e70ab1a，Bella Grace。
- Source：180b41c1-1f92-4fa1-9672-b8025ca2a47b，dtc / US，enabled=true，revision=2。
- Brand 和 Source 通过正常 Brand API 幂等建立并启用，没有直接 SQL 修改或提交采集。
- queueScope/nodeId 沿用 dtc-innerbody-v2-20260911；这是既有节点编号，实际品牌由新的 scope/site 决定。
- 新 evidencePrefix：crawlv3-acceptance/dtc-bellagrace-wellness-20260912。
- Activity：3b705195988155f01befac765ec9708ba236d30c3dce88827cd0477aca017371。
- Workflow：22f5c2817fa37833cbd7cb7fe60687d8eef9fe35240a95b0acc1e7cabbcd4644。
- Release：23 JS；源码包含 b1b7f865df14b50b7cd059f430ddb8aea5210ccd。
- Mini DTC Supervisor 从 26737 更新为 33540，26/26 ready；基础 Supervisor 56831 的 90 个进程保持运行。

Mini 已备份旧 release/private/settings 后切换；节点控制编号和队列不变，旧 Windows 节点仍可上报健康，但其商品站点配置尚为 Innerbody。两端完成 Bella Grace 同步前不提交任务。Windows 必须按 [切换 Prompt](../../apps/v3-workers/deploy/bellagrace/WINDOWS_SWITCH_PROMPT.md) 更新并确认就绪；无需新凭据附件，不额外部署第二个 Windows 节点。

## 页面与证据

检查页面均只操作本次新建的独立空间，未操作其他用户页面或关闭浏览器。精确关闭目标后，清单短暂滞后；只读复核确认对应空间随最后一个目标关闭而消失。保留目标回执与空间清单依据，不把第一次 close 返回直接当成消失证明。

| Mini 空间 | 本次目标 | 最终复查 |
| --- | --- | --- |
| 4 | 895D2894933431363A92F0E109FA24B7 | 空间已移除，后续只读复查确认 |
| 5 | 4F8E59947F5149E9A471678B5A946AA7 | 精确关闭后空间移除 |
| 6 | 075F76DCDF03D1BCE8FA7F783935D01B | 精确关闭后空间移除 |
| 7 | ED73D183F460B2E22F9F34CBE37ED906 | 精确关闭后空间移除 |
| 8 | DB21A523E60AC06C0F8C680F9C337CBA | 精确关闭后空间移除 |

首次脚本因缺少清理步骤被自动审批拒绝，未执行；补齐 finally 精确关闭和只读复核后才执行。另一次因 Mini 安装的旧 API 不支持 taskSpace 而在创建页面前失败。没有绕过这两项限制或升级 Mini 浏览器。

Mini 根目录 /Users/barry/apps/crawlv3-batch-a.UiA4dx 下保留：

- bellagrace-site-check-20260912/site-preflight.json、coverage-verification.json：真实目录/两款详情配置预检及分类证明。
- 同目录 source-intent.json、source.json：幂等来源建立记录。
- 同目录 *cleanup.json、prior-page-recheck.json：精确目标清理和空间消失复核。
- dtc-bellagrace-tests/test.log、test-fixtures.log：首轮与补齐 fixture 后的测试记录。
- dtc-innerbody-v2-20260911/bellagrace-roll.json、bellagrace-health.json：Mini 切换与健康证明。
- dtc-innerbody-v2-20260911/release-before-bellagrace-20260912、private-before-bellagrace-20260912、settings.private.json.before-bellagrace-20260912：旧部署备份，含私有材料，仅保留 Mini。

公开配置和 Prompt 可入 Git；真实凭据、原始页面内容和私有部署备份不入 Git。
