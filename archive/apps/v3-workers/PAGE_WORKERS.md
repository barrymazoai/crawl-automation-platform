# HTML 页面整理与文本输入准备

两个角色分别启动一个进程，只经 Temporal 交接，不互调 HTTP：

| role | capability | Activity | compatibility |
| --- | --- | --- | --- |
| page-prepare | page.prepare | prepareHtmlPage | page-v1 |
| page-text-input | page.text-input | preparePageText | page-v1 |

命令 `pnpm --filter @crawl-automation/v3-workers worker:page`，与 acquisition-worker 共用启动入口，不表示一个进程同时启动四种角色。通过 runtime.role 选择一个角色；每个进程只注册一个 Activity。页面角色不创建来源下载适配器，不调用 OCR/Codex/Python/浏览器。

## 配置

先 `pnpm --filter @crawl-automation/v3-workers build`，部署完整 dist。使用 `V3_ACQUISITION_LIVE_ENABLED=true`、绝对路径 `V3_ACQUISITION_CONFIG` 和现有 `V3_WORKER_ENABLED=true`、`V3_WORKER_CONFIG`。页面业务配置字段：

- cacheRoot、journalRoot：本进程私有目录，不依赖上游节点路径。
- r2、r2Credentials：受限共享存储；原 HTML 只读，页面产物/意向前缀 GET 与条件 PUT。
- reviewDatabase：Review 表 SELECT/INSERT；不需要 processing_result 或采集结果表权限。

页面角色不需要 sources 或 Codex 配置。沿用 acquisition 私有文件要求：普通文件、非符号链接、最大 4 MiB，POSIX 0600。用入口 `--list` 获取准确 buildId；队列分别为 `v3.page.prepare.v1.page-v1` 与 `v3.page.text-input.v1.page-v1`。修改构建后重新获取 ID，不手填旧值。远端 Temporal 使用已有 mTLS。

## 一页一操作与保存

prepareHtmlPage 接受签名 PagePrepareInput：已保存在共享存储的 source-html 引用，完整 observation、独立 operation、策略指纹。检查原文件 hash、大小、UTF-8、归属。复用已有 htmlparser2 离线解析器；不执行脚本，不加载 img/iframe/CSS 等外部资源。

分别保存：

- `v3/pages/<operation>/document.json`：TextDocument，原 HTML 引用和完整整理文本。
- `v3/pages/<operation>/tables.json`：表格、单元格文字、header/rowspan/colspan。
- `v3/pages/<operation>/completion.json`：版本化完成清单，完整输入、产物引用/hash、文本长度。

开始解析前确认共享 page-intents 执行意向。计算后先在本地保留上述候选，逐个发布并远端回读。每次对象发布前留本地及共享 page-publications 意向；状态未知后空缓存换节点也不能重传产物。完成清单核验通过才返回 durable。无自动删除、重解析、补传、补登记；明确 Review 留存原证据。

独立 preparePageText 仅核验完成清单、原 HTML、TextDocument、表格与归属，再生成 V2 TextInput。使用全文 UTF-16 范围 `[0,textLength)`，输入清单保存在 `v3/page-text-inputs/<textOperation>.json`。这两个 operation 与原捕获 operation 必须独立。没有页面解析器调用能力或模型执行端口。

上游回执未知只查证据；明确 Review 校验原 ID、inputFingerprint、stage/code 与 observation 后沿用。核验不足、空文、超限留 Review；Review 自身无法确认入库则 Activity 失败，不伪报成功。Activity 最大尝试 1、心跳 2 秒。

## Workflow 接线

新增 `PageTextWorkflow`，共享输入 PageTextWorkflowInputSchema：`{plan:{page,textOperationId,text},queues:{page,prepare,text,receipts}}`。text 是 Codex 文本完整 compatibility，必须 V2，不从个人默认设置推测。

```text
已保存 HTML → 页面整理 → 文本输入准备 → Codex 文本 → 文本回执核验
```

调用同一 run 内的 PreparedTextWorkflow，不创建页面子 Workflow。新增类型由现有 product-workflow 入口注册，原图片/PDF流程不变，compatibility 保持 product-images-v5；buildId 随完整 bundle 更新。

两页/两个产品可分别启动流程，某个下游消费者未在线不占页面整理槽。此处不支持向一个已封闭产品清单动态追加文本片段，也尚未接产品文本/图片最终汇合和保存。返回 registered 是文本结果登记，不是产品 collected。

## 内容边界

- 原 HTML 最大 2 MiB，既有节点/深度/表格/单元格/输出限制不变；送文本模块最多 200000 个 UTF-16 code units，超过上限 Review、不截断、不自动分片。
- 仅接受已保存的 UTF-8 HTML；原始编码转换、网站下载、浏览器渲染、登录态与来源筛选属于上游，未在这里实现。
- script/style/template/noscript 内容按既有策略省略；隐藏文本、导航/营销文字仍可能保留。这是源 HTML 文字整理，不是浏览器可见正文或营养字段提取。
- 表格结构作为独立证据保留，但当前 Codex 文本收到的是整理后的线性文本，不会自动解释跨行跨列表格。文本引用偏移针对 TextDocument，而不是原 HTML 字节。
- 不改变 Formula + Ingredients 入库条件，不将图片 OCR 全文送文本模型；图片仍走关键词后原图视觉。

本机隔离验收见 [HTML 文本链路报告](../../docs/quality/2026-09-07-html-text-chain.md)。未部署或真实外部联调。
