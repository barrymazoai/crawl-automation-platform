# 旧成果转换、历史观测与完整复采验收

2026-09-13，CRAWLV3-59。旧数据已迁入 Mini `crawler_v3_test` 的追加式历史表，新采集已自动保存动态信息与配方历史。代表批次两款旧商品均走完原完整流程。没有向最终产品库写入。

原 V3 的 `collected_product` 本来就按观测保存结果，同一商品的新一次采集可以独立保留。本次补齐旧库迁移、统一价格等历史字段和离线转换出口。没有新增“已有配方便跳过解析”的行为，也没有修改 Workflow 顺序、模型、OCR 或标签质量规则。

## 1. 旧成果转换

| Mini 来源 | 原始记录 | 处理 |
| --- | ---: | --- |
| product_staging | 38,128 | 商品、挂牌、快照、配方、图片和原始字段完整保留 |
| railway_local_new | 7,668 | 真实渠道参考成果保留，缺少的配方等待完整复采 |
| no-company-products SQLite | 1,625 | 未挂公司成果保留，包含 1,616 份旧标签 facts |
| 合计 | 47,421 | 全量逐项回读通过 |

来源数据库只读。NIH 原始参考资料和 faker 测试数据不作为真实采集成果。MacBook 的 `product_restore` 容器未运行，本轮没有核验或导入，不能把这份副本计入已完成来源。

导入后为 44,561 个保守的挂牌身份、60,065 条指标历史、33,672 条配方历史；挂牌身份不是全局去重后的商品数。485 个身份缺少可信锚点，原始内容继续保留。14,328 份来源记录没有配方行，这也是需要复采的原因，未伪造为空配方“成功”。

新增迁移 `018_product_history.sql` / `019_history_provenance_index.sql`，实际数据库共 19 个迁移。5 张历史表禁止 UPDATE/DELETE；每份来源、观察、来源关联均在同一事务内追加。全量回读核对原始 JSON、哈希、关联、观测数值和时间。没有把导入时间当作旧采集时间。

相同站点及可信 ASIN/SKU/规格关联同一挂牌。URL 只用于可信来源的保守匹配；不同市场、不同规格或互相冲突的 ID 不自动合并。不使用配方相似性替代商品身份。

## 2. 新采集怎样保留历史

- 捕获页面证据后，Mini 从同一证据中保存价格、原价、评分、评论数、库存等观测，独立于后续标签是否通过。
- 原配方流程仍完整执行。商品保存成功后，将这次完整配方和本次页面观测关联，不冒充旧配方为本次识别结果。
- 每个新观测有独立身份；同一次保存重放不会增加点；同身份不同正文拒绝覆盖。
- 原始数字、购买条件、全部配方列、剂量原文、脚注出处、图片及模型证据仍可追溯。没有足够证据的值为 null。
- 历史派生写入暂时失败时记录 `HISTORY_PROJECTION_PENDING`，原采集/Review 结果不改写。已保存的 R2 capture receipt 可离线重放；本期没有新增定时重试服务。

Swanson/Amazon 在原有 DOM 读取内增加可选 commerce 字段，旧证据继续可读。Swanson 优先采用页面明确展示的 SKU；拿不到时按 Shopify variant 单独保存，不猜测与旧 SKU 的关联。DTC 多规格没有确定选中项时保留全部原始报价，数值价格留空；采集时间取有边界的单商品 harvest 时间。GNC 从留存 HTML 中按准确 SKU 读取可验证的 JSON-LD。

## 3. Mini 部署和测试

仅部署 Mini Activity 支持包，19 个 JS，build ID：

`516632973c32512230d1eb2b09f2406ec7e7a0f9b78be4d696749d6a0a5354be`

主部署替换 19 个角色的入口，DTC Mini 配套替换 2 个保存角色；更改角色的 runtime 仅调整 `expectedBuildId`，队列与其他配置一致。主 Supervisor 和 DTC Mini Supervisor 各正常重启一次。最终主部署 PID 23059，90/90 ready；DTC Mini PID 23433，26/26 ready。Windows 节点继续保持健康，无 Windows 部署变更。

所有 Workflow 入口与运行配置逐项确认未改。旧发布目录和切换前 manifest 留存。最初 `launchctl kill` 返回未管理该进程，未修改配置；确认旧进程实际为手动启动后，向其精确 PID 发 SIGTERM，正常退出并移除自身锁后才切换。

验证包括：

- Mini：112 项历史存储及旧渠道回归全部通过，其中 6 项覆盖历史追加、SKU 隔离、证据损坏、数据库回执丢失重放、配方关联、DTC/GNC 投影。
- 本机纯数据检查：9 项历史转换 + 3 项产品服务导出测试通过；API/Worker TypeScript 检查通过。
- Mini 空队列/暂停接口预检：19 个入口正常启动并停止；2 个不接受独立会话队列的旧角色核对注册信息，随后在正式 Mini 启动验证 ready，没有把预检接到业务队列。
- 2 份之前已成功的真实 Swanson 捕获及其配方已从留存证据补入历史表，原业务三表内容保持不变。
- 4 个本任务隔离测试 PostgreSQL 容器已停止，数据与日志留存；没有停止业务数据库。

## 4. 正常 Brand 完整复采

来源 `https://www.swansonvitamins.com/collections/brand-ac-grace-company`，revision 4。

- Brand：`5a2d5d6e-8a22-4575-9999-601ee8308704`
- Source：`68ff3cbf-3afe-4703-bed7-06104da433d8`
- requestId：`da5e599e-d69f-4709-9df0-e24379c2e4ae`
- Workflow：`v3-collection-da5e599e-d69f-4709-9df0-e24379c2e4ae`
- 正常入口受理 10:05:13 UTC，父流程完成 10:11:33 UTC，8 个父子 Workflow 全部 COMPLETED。

| 页面 SKU | 新采集时间 UTC | 新价格 | 评分 / 评论数 | 新配方行 |
| --- | --- | ---: | --- | ---: |
| ACG009 | 10:07:10.937 | $43.59 | 5 / 6 | 3 |
| ACG002 | 10:08:33.915 | $47.29 | 5 / 38 | 3 |

页面展示美元符号，但没有读取到明确 ISO 币种，因此 `currency=null`，原符号和一次性购买/订阅上下文保留。不能把这次结果称为所有渠道货币、库存字段都已齐全。

两个 SKU 都与旧库中 2026-09-01 的相同 SKU 关联；每个现在有 2 条指标历史和 2 条配方历史，旧点与新点并存。历史表总量变为：47,429 份来源、60,069 条指标、33,676 条配方，其中包括前述 4 份留存证据补录和本轮 4 份新来源。

| 原 V3 表 | 本轮前 | 本轮后 | 所有旧 record / record_hash |
| --- | ---: | ---: | --- |
| collected_product | 30 | 32 | 逐条一致 |
| processing_result | 176 | 184 | 逐条一致 |
| review_record | 74 | 76 | 逐条一致 |

两款最终均已保存。新增 2 条文字模块 Review：`TEXT.LABEL_COVERAGE_UNCERTAIN`、`TEXT.LABEL_EXTRACTION_INCOMPLETE`，通过既有其他证据路径完成商品保存；原模块错误继续保留。本次没有修改质量策略或重新评估所有标签行准确率。

5 个准确任务页（目录 1、商品族 2、SKU 2）均有一致 opened/closed 账本，之后三次只读核验 targetsAbsent=true。没有再次执行 close、没有关闭用户页面。直接引用的 37 份 R2 证据全部冷读，大小与 SHA-256 一致。最终 guard=0、held=0，Mini 和 Windows 资源 healthy/fresh。

使用已有证据再次执行两次 capture 保存和两次 collection 保存，总来源仍为 47,429，总观测仍为 93,745；没有浏览器或模型调用。

## 5. 产品库离线转换出口

增加 `service-export`，输出 `product-service-material/1`。一份材料同时含完整原始来源和保守身份/历史点，以及能够表达的指标请求、完整标签草稿。每个历史点独立 run/clientRef，scope 永远 partial，避免旧点覆盖产品库的批次台账或触发下架。

以 Jakarta `9ec4a665ea860c2db71ceb4511685c09aa01b03c` 当前源码 schema 校验全部导出：

- 47,429 份来源材料全部保留原始记录；60,069 份指标请求通过 `IngestObservationBatchInputSchema`。
- 4 份 V3 完整标签草稿通过 `IngestLabelObservationInputSchema.omit({company:true})`；标签内容逐字段一致，未压成单列数值配方。
- 公司按用户决定留待入库阶段匹配。完整标签入口当前仍要求 `company.domain`；校验草稿不等于公司已匹配，更不等于目标服务实际接收成功。
- 33,093 份带旧格式配方的来源材料标明 `legacy-formula:retained-with-original-schema`，原始配方及关联完整保留。它们没有被伪装成新 V3 标签；后续完整复采可产生新标签观察。
- 来源未提供置信度时不填 100。超出安全整数范围的数字留在原始 extras，不做精度丢失转换。

离线压缩导出位于 Mini 私有工作目录 `product-service-material.jsonl.gz`（179,987,985 bytes）。没有把原始导出、凭据或迁移恢复文件放入 Git，也没有向最终产品库发送请求。正式接收端实际部署、公司关联及入库回读仍属于后续阶段。

## 6. 继续使用

从 `apps/v3-workers` 执行 `node --import tsx scripts/build-history-support.ts` 可构建 Mini Activity 支持包。`V3_HISTORY_ENABLED=true` 仅在需要派生历史的 Mini 角色启用；Windows 不需要数据库连接。

API 构建包含 `history-cli.js`，私有配置只需已有 V3 数据库配置。以下参数路径均由操作者提供真实路径：

```text
node history-cli.js preview INPUT.jsonl.gz
node history-cli.js import INPUT.jsonl.gz PRIVATE_CONFIG
node history-cli.js verify INPUT.jsonl.gz PRIVATE_CONFIG
node history-cli.js inventory PRIVATE_CONFIG
node history-cli.js reparse PRIVATE_CONFIG
node history-cli.js export PRIVATE_CONFIG
node history-cli.js service-export PRIVATE_CONFIG
```

`export` 与 `service-export` 可再加正整数限制条数。输出包含业务数据，写入私有文件；不要写进 Worker release 目录或 Git。

历史保存报 pending 时，先查准确 operationId 和证据原因。使用 Mini 的 `history-reconcile.js`，可按 `channel` / `gnc` + 原任务输入文件重建，或 `replay` + 准确 capture receipt key 重新保存；配方使用 `collected` + 原 operationId。它不重开网页、不重发采集、不改 Review。确认缺失的 capture 已保存后，再重放对应 collection。

已有 43,642 条完整复采候选：Amazon 32,181、DTC 1,224、GNC 2,401、Swanson 7,836。包含已有配方商品；按既有 Brand/来源分批执行。本次只提交上面的代表批次，未整批发出候选清单。该清单不证明网站目录完整，不能用于自动下架。

定时任务、独立备份功能、趋势图表、公司匹配改造及最终产品库写入继续暂缓。迁移前保存的恢复点仅保护本次迁移。

## 证据

[脱敏验收摘要](evidence/2026-09-13-history-observations/public-summary.json)包含逐来源导入/回读、测试、部署、真实批次、新旧记录对比、页面和 R2 核验、幂等及目标契约检查。

Mini 私有根目录：`/Users/barry/apps/crawlv3-history-20260913`。其中 `normal-recapture/` 留存实际意图、受理回执、8 份 Workflow 历史和完整记录；`final/` 留存测试与离线导出工具。原始数据库、旧成果、既有 Review 和 R2 证据均保留。
