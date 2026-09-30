# V3 PDF 原子模块

2026-09-07：新增 `PdfTextPreparation` 和独立 `pdf-text-input`，核验单页提取产物后生成保留父PDF/页码的全文 TextDocument/V2 输入；通过专属 [PdfTextWorkflow](../../../apps/v3-workers/PDF_TEXT_WORKFLOW.md) 接 Codex 与只读回执。registered 仍不代表产品保存，整份 PDF 混合清单待接。原 PDFium 引擎与图片路径不变。[本轮验收](../../../docs/quality/2026-09-07-pdf-direct-text.md)。

2026-09-07：已增加不具备引擎能力的 `PdfEvidence`/`PdfPreparation`，独立页清单与 OCR 输入准备角色只核验和发布证据。产品 Workflow 已接检查后逐页渲染/OCR/关键词/原图视觉/汇合保存；PDF 模块自身仍不调用 OCR。[部署入口](../../../apps/v3-workers/PDF_WORKERS.md)、[验收报告](../../../docs/quality/2026-09-07-pdf-product-chain.md)。

CRAWLV3-19：三个独立操作，**不使用 Swift/PDFKit，不提供 HTTP 服务，不串接 OCR**。

| 操作 | 输入 | 输出 |
| --- | --- | --- |
| `pdf.inspect` | 一个 source-pdf 引用及其已验证字节 | 页数、逐页尺寸 JSON |
| `pdf.text` | 同上 + 零起始 pageIndex | 单页 Unicode 文字 JSON；空文字是合法结果 |
| `pdf.render` | 同上 + pageIndex + scale | 单页 PNG；ArtifactRef 带 parentArtifactId/pageIndex |

共享契约在 `packages/v3-contracts/src/pdf.ts`。一次调用不是一个 Brand，也不是整批文件。
检查后是否逐页抽文字、渲染及 OCR，由后续 Workflow 决定。多个操作使用不同 Python 进程；
这里没有全局锁或内部 PDFium 多线程。同一操作的防重复授权、实际并发额度由 Worker 外壳负责；当前已补 PdfModule 和三个独立运行角色，见下文。

## 边界与部署

调用关系是 **Temporal → 领取任务的 TS Worker → 本机 Python 子进程**。
这个包实现本机引擎与交接外壳；业务注册入口位于 apps/v3-workers，已增加 pdf-inspect/pdf-text/pdf-render 三角色，尚未部署到 Railway、Mac mini 或 Windows。
将来把 PDF Worker 部署到服务器，要把 TS 入口、此包的构建文件、Python 脚本/策略和该平台的 Python 环境一起部署。
不能只拷贝 Mac 的 `.venv` 到别的平台，也不需要让另一台机器远程执行本机 Python。

包默认使用 `python/worker.py` 和 `policy.json` 作为运行资产；**直接部署本包时必须保留它们与 dist 的同级布局**。Worker 应用构建则复制到 dist/pdf-assets，通过私有 PdfOptions.assetRoot 注入固定资产根目录并纳入 buildId，任务不能选择脚本。
Node 构建验证已实际启动 dist 入口并解析 W3C PDF，不是只用 tsx 验证源码。

```sh
# 在项目根目录；Python 3.13，本次实测 3.13.7。
uv venv packages/v3-pdf/.venv --python 3.13
uv pip install --python packages/v3-pdf/.venv/bin/python -r packages/v3-pdf/requirements.txt
pnpm --filter @crawl-automation/v3-pdf build
```

Windows 将 Python 路径换为 `.venv/Scripts/python.exe`；Windows/Linux **尚未实机验收，不算准入通过**。
`PdfSubprocess.open({pythonExecutable, workRoot})` 必须显式注入绝对路径；不读取 `.env`，不猜系统 Python。
POSIX workRoot 必须是专用私有目录（0700）；Windows 需由部署设置等效 ACL，文件系统需支持独占创建与硬链接。
配置是部署方拥有的，不接受任务携带命令、脚本路径、下载 URL 或本机路径。

输入用 `PdfInputSchema` 验证；先填 `implementationVersion: "1"`、`policyVersion: "1"`、
`configFingerprint: pdfConfigFingerprint`，再通过 `fingerprintPdfInput(input)` 计算 inputFingerprint。
完整 observation/source/listing/variant、父文件 hash、生产者版本、操作和参数均绑定；跨产品引用拒绝。
调用前由 ArtifactResolver 按本机缓存/R2 取得字节；本模块不负责联网获取。

## 完成证据，不等于可靠交接

每次 `run` 在专用随机 attempt 目录中独占保存 `input.json`、`source.pdf`、`output.json` 或 `output.png`。
Python fsync 输出，再以独占硬链接发布 `complete.json`；回执只表示进程完成，TS 必须再读回校验。
原件/结果/清单都保留，不按成功或失败自动删除。POSIX 同步目录；Windows 目录断电持久性未验证。

成功返回 `PdfPrepared`，状态明确为：

```text
computedLocal = true
artifactDurable = false
resultRegistered = false
```

`bytes` 是 Worker 内部值，**不能整包塞入 Temporal 历史**。外壳须持久发布原件、产物与完成清单，
外壳发布并回读核验完成证据后，Activity 返回小型 durable 引用；后续 Worker 通过 ArtifactRef 交接，不靠 attempt 路径。durable 不冒充数据库 resultRegistered，本项没有把 PDF 假装成 OCR 登记或新增 PDF 结果表。

`PdfError` 携带分类和本地 attemptId（若已分配）。`inspectAttempt(input, attemptId, signal)` **只读**：
核对输入、原件、完成清单、版本、页码/参数、输出长度/hash、JSON 内容或 PNG 尺寸。
即使 Python 已不可用仍可核验；真实测试覆盖 Python 写完清单后被 SIGKILL 的恢复。
丢失/不完整清单、篡改产物、错操作或错归属不能认定完成，也不会自动重新解析。

这不是全局 exactly-once：每次主动 `run` 都创建新 attempt；不要直接套自动重试 Activity。
新增外壳使用共享存储执行意向防重，并通过 run 的 onAttempt 回调在 Python 启动前保存本机 operation → attemptId 索引；失败不自动重解析。当前没有节点崩溃后的自动扫描、孤儿进程回收或跨机本地证据发现。
没有证明进程/系统断电、磁盘损坏或磁盘写满时的完整恢复。

## 限额和错误

`policy.json` 是 TS/Python 共用策略，并进入配置指纹。固定 pypdfium2 5.13.0、PDFium 153.0.7999.0、Pillow 12.3.0；
拒绝版本不符及带额外构建 flags（含 V8/XFA）的引擎，不自动升级。

| 限制 | 第一版值 |
| --- | --- |
| 输入/单输出文件 | 各 32 MiB |
| 页数 | 500 |
| 单页尺寸 | 每边 ≤ 14400 PDF canvas units |
| 渲染 | scale 0.25–4；每边 ≤ 10000 px；总计 ≤ 1600 万 px |
| 文本 | 50 万 Unicode 字符、2 MiB UTF-8 |
| 子进程 | 60 秒超时；SIGTERM 后 1 秒仍未关闭则 SIGKILL；关闭后才结束调用 |
| 协议/日志 | stdout/stderr 各 ≤ 64 KiB；stderr 只排空，不保存原文 |
| POSIX | CPU 45 秒软/46 秒硬限额、禁止 core dump、文件大小限额 |
| Linux | 额外 RLIMIT_AS 1 GiB 虚拟地址空间；不是 RSS 配额 |

**进程隔离不是安全沙箱。** macOS 无硬内存限额，Windows 无此处的 POSIX CPU/文件限额；
限页/像素不能覆盖 PDF 解码前的所有内存放大。生产接不可信 PDF 前，部署层必须补容器/cgroup 或等效 OS 资源与权限隔离、
磁盘总配额/磁盘余量准入、进程树监督；Windows 需 Job Object 等机制或迁至受限 Linux Worker。
本轮只验当前 Mac 的运行行为，不宣称完整资源耗尽防护或原生 PDF 安全性。

不执行 PDF JavaScript，不初始化表单，不绘制注释；这也意味着填充表单/注释不是本版完整视觉还原范围。
scale 是 PDF canvas unit 倍率，不保证所有 `/UserUnit` 文档的物理 DPI。空文本仅供编排判断，不代表图片不存在。

错误包括 `PDF.BAD_FILE`、`ENCRYPTED`、`PAGE_LIMIT`、`PAGE_RANGE`、`DIMENSIONS`、`TEXT_LIMIT`、`OUTPUT_LIMIT`、
`INPUT_INTEGRITY`、`ENGINE_MISMATCH`、`RESOURCE_LIMIT`、`PROCESS_FAILED`、`TIMEOUT`、`CANCELLED`、`PROTOCOL`、
`RESULT_INTEGRITY`、`ATTEMPT_MISSING`。外壳负责把错误映射进被动 Review；本包不写业务库、不消费 Review、不做业务重试。
操作系统 OOM/SIGKILL 不可据此断言原因，一般归 PROCESS_FAILED，不能冒称已识别 OOM。

## 独立运行交接（2026-09-06）

`PdfModule.run` 依赖注入共享 ObjectStore、本机 journal/copies、Review 读写端口和 PdfSubprocess。先核验已有完成证据；没有证据时条件创建永久意向，确认唯一执行权才启动引擎。计算完本地保留，再发布单产物和 pdf-completion/1；源文件与产物必须远端可回读。`inspect` 是纯只读核验，不启动 Python/上传/登记。

完成回执丢失可从共享存储复验；上传失败保留候选与 attempt，未知执行只进被动 Review，不自动清 guard 或补跑。每个角色独立启动，回执仅传 ArtifactRef；OCR/产品 PDF 分页编排尚未接入。详见 [启动手册](../../apps/v3-workers/PDF_WORKERS.md)、[本轮验收](../../docs/quality/2026-09-06-pdf-workers.md)。

## 复现验证

```sh
uv pip install --python packages/v3-pdf/.venv/bin/python -r packages/v3-pdf/requirements-test.txt
curl --fail --location --max-time 30 --output /private/tmp/crawlv3-19-w3c-dummy.pdf https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf
pnpm --filter @crawl-automation/v3-pdf test
V3_PDF_PUBLIC_SAMPLE=/private/tmp/crawlv3-19-w3c-dummy.pdf pnpm --filter @crawl-automation/v3-pdf test:integration
```

公开样本不随包复制；SHA-256 必须为 `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`。
没有配置样本时集成测试明确失败，不静默跳过。其余文件在私有临时目录生成并保留，均是合成资料；pypdf 只用来造测试文件。
覆盖实际 PDF 解析/渲染、加密（含空用户密码）、损坏、空白页、超限、旋转、并发独立进程、取消/强杀、协议/凭据隔离、
完成后真实进程中断、只读恢复和证据篡改。[本轮证据](../../docs/plane/evidence/CRAWLV3-19/README.md)。

参考：[PDFium Python API / 线程限制](https://pypdfium2.readthedocs.io/en/stable/python_api.html#incompatibility-with-threading)、
[Node 子进程 API](https://nodejs.org/api/child_process.html)、[W3C 公开 PDF 样本](https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf)。
