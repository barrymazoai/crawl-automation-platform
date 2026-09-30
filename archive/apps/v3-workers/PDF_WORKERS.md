# PDF 独立 Worker

六个角色分别启动进程，经 Temporal 主动领任务。三个处理角色调用本机 Python/PDFium，三个准备角色只核验证据和生成输入，不创建 Python 引擎、不调用 OCR；角色间不互调 HTTP。当前为本机隔离交付，未部署常驻。

| role | capability | Activity |
| --- | --- | --- |
| pdf-inspect | pdf.inspect | inspectPdf |
| pdf-text | pdf.text | extractPdfPageText |
| pdf-render | pdf.render | renderPdfPage |
| pdf-pages-prepare | pdf.pages.prepare | preparePdfPages |
| pdf-ocr-prepare | pdf.ocr.prepare | preparePdfOcr |
| pdf-text-input | pdf.text-input | preparePdfText |

启动命令 `pnpm --filter @crawl-automation/v3-workers worker:pdf`。运行配置选一个角色，每进程只注册对应 Activity，其他操作不能投进该角色冒充成功。检查一次一个文件，文字/渲染一次一页；不接文件数组。

## 构建及配置

先 `pnpm --filter @crawl-automation/v3-workers build`。构建会复制 `dist/pdf-assets/python/worker.py`、`dist/pdf-assets/policy.json`；**必须连同完整 dist 一起部署**。这两份资产进入 PDF 角色 buildId，不能只复制 pdf-worker.js。每个平台独立安装 `packages/v3-pdf/requirements.txt` 的固定 Python 依赖，不复制 Mac 虚拟环境到 Windows/Linux。

公共开关：`V3_WORKER_ENABLED=true`、绝对路径 `V3_WORKER_CONFIG`。runtime 字段与现有角色一致；contractVersion=1、compatibility 为 `pdf-v1-<pdfConfigFingerprint 前32位>`，队列 `v3.<capability>.v1.<compatibility>`。任务仍校验完整64位指纹，不以短路由代替完整校验。在私有配置就绪后用入口 `--list` 获取准确 buildId/compatibility，不手填猜测。远端 Temporal 使用已有 mTLS。

业务开关：`V3_PDF_LIVE_ENABLED=true`、绝对路径 `V3_PDF_CONFIG`。私有普通 JSON 文件最大 64 KiB，禁止符号链接；POSIX 权限 0600。字段：

- `pythonExecutable`：三个处理角色必需，本机 Python 可执行文件绝对路径并安装固定依赖；三个准备角色可省略。配置不由任务传入。
- `workRoot`：三个处理角色必需，本进程私有 attempt 根目录（POSIX 0700），原件、输出和 Python 完成清单全部留存；三个准备角色可省略。
- `cacheRoot`、`journalRoot`：本机缓存与外壳证据绝对路径，不是其他 Worker 的路径。
- `r2`：endpoint/bucket/prefix/timeoutMs；`r2Credentials`：accessKeyId/secretAccessKey。受限前缀 GET/条件 PUT，凭证不得进入任务/UI/日志/版本库。
- `reviewDatabase`：`{ connectionString, tls }`，已有 review_record 的 SELECT/INSERT 专用账号。没有 processing_result/collection 写权限，不自动迁移数据库。

私有配置不接受脚本路径/参数或任意命令；Python 资产只能使用当前构建固定目录。`--list` 不启动 Python 或连接数据库。Worker RUNNING 仅表示任务消费者上线，不等于 Python/OS 安全隔离已验收；精确引擎版本在每次真正处理时校验。无 Python 的节点可验证已发布完成证据，不能执行新 PDF 操作。

## 完成与恢复

任务仅携带 PdfInput（原 PDF ArtifactRef、完整 observation/operation、单页参数及配置指纹）。源 PDF 必须已耐久保存，不能将仅本地文件描述伪装为共享证据。

1. 查询已发布完成证据；原件/产物/hash/页码/父文件/参数/引擎一致则直接返回 durable。
2. 条件创建不可覆盖的远端 pdf-intents 标记并读回；仅明确本次创建才允许执行。
3. Python 启动前，本机 journal 独占保存 operation → attemptId 索引；索引保存失败不启动 Python。
4. Python 输出经过本地回读校验，外壳保存本地候选，再发布产物与 `v3/pdf/<operation>/completion.json`，远端回读验证后返回小型引用。

durable 不是 processing_result 登记、产品 ready 或正式入库。本轮沿用文件路径的版本化共享存储完成证据，没有增加 PDF 数据库 codec。任务回执不含 PNG 字节、PDF 字节、全文、本机路径或 Python 命令。

完成后换空缓存进程可只读恢复，不需要原来的 Python。已有未完成意向、丢失结果、上传失败均不自动重解析/补传；保留 attempt/索引/候选与分类 Review，等待显式核验处置。失败重投可能条件 PUT 已有意向，但不重新解析或上传产物。Review 追加后同 ID 回读；不能确认落库就返回 Activity 失败，不伪报已进队列。

Activity 最大尝试 1、心跳 2 秒。取消通过现有 PdfSubprocess 终止本机子进程并等待退出。完成后的 Worker 不等下游。没有 TTL 抢占、自动扫描 orphan、跨节点本地 attempt 搜索、自动恢复上传入口。

## 页清单与 OCR 输入准备

`PdfEvidence` 只读核验完成证据，`PdfPreparation` 仅依赖存储和 Review。`preparePdfPages` 接收产品计划与检查回执，核验完整页数/连续页码，生成独立渲染和 OCR operation；超过产品清单 100 页上限进 Review。`preparePdfOcr` 接收单页计划与渲染回执，核验原 PNG 的 hash、父文件、页码、产品和配置后生成签名 OCR 输入，不重新编码图片。

准备清单分别保留在 `v3/pdf-preparation/<productOperation>/pages.json` 和 `v3/pdf-preparation/<ocrOperation>/input.json`。先本地保存、条件发布、远端回读；已存在则核验复用，不覆盖。已有本地候选但远端未确认时进 `PDF.HANDOFF_PENDING`，不自动第二次上传。原处理回执未知只查证据，明确 Review 核验后沿用，不能把失败当未命中关键词。

`ProductPdfWorkflow` 已接检查 → 页清单 → 逐页渲染/准备/OCR/关键词/视觉 → 产品汇合与保存，见 [产品 Worker](PRODUCT_WORKERS.md)。仍禁止将 source-pdf 直接当图片 OCR。准备角色虽不运行 Python，仍需完整 dist/pdf-assets 用于策略校验与 buildId；无需安装 Python 依赖。

## PDF 单页文字准备

`PdfTextPreparation` 只接受一个明确页码的 `pdf.text` 提取计划和回执；核验原 PDF、引擎输出、完成清单，再生成保留原 PDF / 页码 / 原始全文的 TextDocument 与签名 V2 TextInput。无引擎/模型执行端口；回执未知只查已有证据，明确上游 Review 核实后沿用。空文 `PDF.TEXT_EMPTY`、超过 200000 个 UTF-16 单元 `PDF.TEXT_LIMIT`，不截断或自动 OCR 兜底。

文档保存到 `v3/pdf-text-documents/<extractionOperation>/document.json`，输入和原提取凭证保存到 `v3/pdf-text-inputs/<textOperation>/input.json`。本地候选和共享单次发布意向保护未知上传，跨空缓存节点也不自动补传；存在的文档/清单必须完全一致。准备错误 stage=`pdf.text-input`，Review 保留完整 plan，不误称 PDF 引擎失败。

新增独立 [PdfTextWorkflow](PDF_TEXT_WORKFLOW.md) 串接 `extractPdfPageText → preparePdfText → interpretText → resolveTextReceipt`。这里只完成单页文本登记，不把 registered 当产品 collected。

## 尚未接入的部分

SavedProductWorkflow 已支持显式 pdf-text 单页/多页来源与 HTML/原图混合汇合保存；完整清单由调用方给出，不自动发现全部 PDF 页。整份 PDF 的自动文字/图片路由、下载后动态媒体路由及 Brand/网页入口尚未接入。当前路径的源 PDF 要先可靠发布。

现有 PDFium 限制继续适用：不执行 PDF JavaScript、不初始化表单/绘制注释；进程隔离不是安全沙箱。Windows/Linux 实机、容器/cgroup/Job Object、磁盘总配额/断电与生产权限隔离未验收。当前不能据此宣称任意不可信 PDF 的生产安全性。

验证记录见 [PDF Worker 验收](../../docs/quality/2026-09-06-pdf-workers.md)。
逐页产品编排新增验收见 [PDF 产品链路](../../docs/quality/2026-09-07-pdf-product-chain.md)。
