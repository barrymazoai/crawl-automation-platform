# DTC 图片优先

用户明确要求“以图片里面为主，不以网页里面内容为主”。关联CRAWLV3-207/184/151。
后续新DTC source plan 默认使用已有 `label-sources/1` 的 `images-first`：先处理图片，
清晰完整的标签满足原校验后停止继续尝试网页标签文字；图片不足时才进入原文字后备路径。
原始页面与图库继续完整保存，网页商品身份/规格/价格仍来自网站；本次只调整标签资料
的优先级。多图片之间的真实差异、完整性及归属校验不放宽，其它channel默认顺序不变。

两Mini现有私有配置均无sourceOrder覆盖。改现有默认值，不增加新采集/提取流程。
Natrol B12原正文30份/图60份保留；以图片作为本次标签来源，不让旧文本失败挡住新的
图片优先任务。旧run `b3ba1835-dd38-4ab6-8060-6ae3e26f92a3`及Review不重试或覆盖。

使用手动、限定一项的 `tools/verify-dtc-retained-order.mts`：先核验原run已结束、所有
原件本地/R2哈希及旧scope原结果，然后复用原单规格下游执行工具，用新ID和明确的
新政策验证目的开始处理。不再打开网页，不重新做scope模型判断；旧材料不修改。
按用户要求，不加/运行单元测试，使用静态构建检查和Mini真实留存材料执行。

## 部署与验证记录

- `9d08569c3c45dd2fcc6e3a1b1cd7ca74f9c57eca` 修改 DTC 默认顺序；两轮完整
  `pnpm check` 与独立工具严格类型检查通过，没有新增或运行单元测试。
- Server 二经 origin/main fresh clone、锁定安装与 worker build，07:14:13Z
  确认仅 browser-worker 切换就绪。Server 一已有图片优先执行能力，无需切换。
- 首轮新派生 `dtc-retained-single-c337a3c1-af4c-472d-a572-c11ef4a0344e`
  在规划阶段返回 `CHANNEL.VARIANT_CONFLICT`。历史单规格验证工具将 base owner
  改成 variant owner，图库仍归 base；未启动 Label 子流程，0许可/0执行，无遗留。
  这是验证交接错误，不是图片优先执行结果；该 Review 保留。
- `dacacaa976df186d0d900942875a6ac24df91921` 修正验证工具，使本轮保留原捕获
  URL/owner 与网站 variants，启动前核对每张图归属。07:18:21Z Server 二通过相同
  Git 部署步骤就绪。新派生独立保存至 `manual-releases/dtc207-b12-images-first-base`，
  原首轮 `dtc207-b12-images-first` 和原浏览器任务不修改。
- 第二派生 `dtc-retained-single-ecaafd34-b387-48fa-8d97-e2f8996444ba`
  的 base owner 与规划通过，但 `prepareLabelTask` 在 OCR 前失败：207前一轮新增的
  `failurePolicy` 漏同步至工作流镜像 `LabelTaskSchema`，运行时严格校验拒绝。
  07:19:27Z结束，无Label子流程，0许可/0执行。`fe426578f7fe0b788edf312b702c1f008e94717e`
  补齐同一optional字段，原输入兼容；全静态检查通过。这项遗漏及两次真实结果均记207。
- 07:22:35Z，Server 一经 main Git fresh clone/build，仅 pipeline-worker 与
  label-worker 切换到 `fe42657` 并通过就绪检查，另外5个服务未重启。切换前各渠道
  无在途/ready任务、held=[]；DTC仍paused，其它渠道原模式不变。
- 第三次新派生 `dtc-retained-single-23e98bd1-1741-4da1-9221-b86ae9b6f053`
  （run `2b2b3d9a-8aaf-4045-a475-4e1470fc952c`）完成59原件/4,997,388字节核验，
  保持原 base owner 与 `images-first`，07:24Z已真实进入Label子流程。
  输出目录 `manual-releases/dtc207-b12-images-first-verified`。

## 实际结果：图片优先通过

第三派生于07:26:35Z完成，Label=`collected`，enrichment=`registered`且
`reused=false`，不是复用旧成功配方冒充新的图片处理。`image-1/2`检查后无标签，
真正选中 `image-3`（原图SHA `c49856ce007052be7475be78bfa5efbc401279ff161f84526f9ecd422e8f3baa`，
82,502字节）。选中完整标签后，page=`not_started`，原因为
`complete_label_already_selected`，`interpretText`调用数为0。网页文档只保留用于
现有背景资料检查，不作为配方来源。

最终Facts来源全部为该图片：`1 Tablet`、`60`份、Vitamin B12 (as Methylcobalamin)
`1,000 mg`、`41,667%`；辅料按印刷原文保留4条，其中最后一条包含括号内5种辅料。
网页的30份没有覆盖图片60份。完整enrichment新结果已R2回读，count=60；form/strength
因原始资料冲突保留unknown/null与备注，没有猜测覆盖。

**原图自身的资料矛盾保留，不当成抓取bug修改：** 目视核对原图顶部写`1,000mcg`，
Facts行实际印`1,000 mg`；Facts里写60份，图片底部又写30份。页面标题写Capsules，
Facts写1 Tablet。本轮按用户决定以图片Facts表为主、原样保留；不能声称厂家资料
内部一致，也不能用网页值擅自改写图片表格。`PACKAGING.SERVING_SIZE_CONFLICT`
作为warning保留，不阻断本轮收录。这是图优先顺序验收，不是标签科学正确性保证。

全部3个Workflow结束，5个许可、5个执行均有先停后释放证明，invalid=[]。
本轮没开启浏览器、没新抓网站、没重排旧Review；DTC批量仍paused。
证据在Server一 `manual-releases/dtc-native-20261002/`：

- `images207-b12-verified-workflows.json`、`images207-b12-verified-stop-proof.json`
- `images207-b12-result-proof.json`、`images207-b12-acceptance.json`
- `images207-b12-facts.jpg`（从已校验R2原件回读）
- `images207-schema-deploy.json`、两轮前置失败的workflow/stop-proof记录

Label operation：`label-59cb9d5001427635f5aa7f5034deff8cab69e0d36d04783b7a5e4c24e06d364d`。
新enrichment：`7894205e494ad729f2e7cedf83685331d0cb6aa33eab7676c5b3c7468a985a50`。
207按用户最新方向交Review；184/151仍是整体DTC覆盖进行中。纯网页后备继续现有校验，
本轮没有改变HTML-only判定标准，也不宣称全部DTC网站、规格路线已验收。
