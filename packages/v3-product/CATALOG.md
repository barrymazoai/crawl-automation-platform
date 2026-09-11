# Catalog / Presence 边界

本切片共享契约在 `packages/v3-contracts/src/catalog.ts`，编排在 `catalog-workflow.ts`，不可变业务证据账本在 `catalog-ledger.ts`。账本通过结构化数据库接口和 `verifyPage` 注入，不依赖 API 应用或浏览器实现。任务仍只由 Temporal 管理。

## 原子职责

| Worker 角色 | 工作 | 私有依赖 |
| --- | --- | --- |
| catalog-workflow | 每页登记后立即启动产品子流程；只等启动回执 | Temporal |
| catalog-source | 校验已持久化的 GNC 页面，输出通用目录页 | R2、捕获证据配置、数据库 |
| catalog-ledger | 验证页面、登记发现/派发、封闭目录 | 同上；仅追加业务证据 |
| catalog-product-workflow / catalog-product-input | 回读发现、生成/校验独立产品参数并不可变登记，启动现有 GNC 流程 | Temporal；参数模块只需数据库及策略配置 |
| presence-workflow / presence-check | 独立查询发现证据并登记存在性结果 | Temporal；核查模块只需数据库，无 R2/浏览器/模型 |

活动入口 `apps/v3-workers/src/catalog-worker.ts`，编排入口 `product-workflow-worker.ts`。沿用 runtime 的角色/队列协议，各角色独立进程、各自长轮询。显式 `V3_CATALOG_ENABLED=true` 和 `V3_CATALOG_CONFIG` 指向 0600 私有 JSON；按 `catalog-config.ts` 的角色 schema 分文件配置，不让 Presence 携带 R2 密钥。

数据库最小权限：目录 ledger 对 catalog_run/page/discovery/dispatch/closure 为 SELECT/INSERT（行锁还需要对应表 UPDATE 权限，但 immutable trigger 禁止实际改写）；Presence 只读目录表，并 SELECT/INSERT presence_result；产品参数模块 SELECT catalog_discovery、SELECT/INSERT catalog_product_input 与 observation_execution；Dashboard 所用表只有 SELECT。不要使用管理员凭据常驻部署。

## 新 SKU 参数

`catalog-product.ts` 的工厂只接收发现 + `GncCatalogProductPolicySchema`，不复制旧单品模板。Worker 配置 `factories` 为明确 catalogId/scope 的策略数组；`products` 明确映射可保留，但同一发现命中多个配置即拒绝。工厂生成的是逻辑 session ID，后续浏览器资源层必须绑定真正的独立会话，不能当作已打开窗口。

先核对调用 Workflow 与账本发现，再生成输入，在一个事务中不可变登记输入及 observation 执行映射；同发现并发回读相同参数。已登记后队列、模型策略、网络等改变会报 `CATALOG.PRODUCT_INPUT_CONFLICT`，不得覆盖或自动新建操作。需要新计划时使用新的目录代次。新迁移014须按现有备份/显式迁移规则部署，不在Worker启动时自动迁库。

## 调度与恢复

- 单页最多 100 条；每 Run 默认 5 页、上限 10 页；Continue-As-New 携带页码和游标，不携带整站大数组。
- discovery ID / 产品 Workflow ID 由 catalogId + listingId + variantId 稳定生成。跨页重复卡片不产生新产品；同页并发/回读返回同一发现回执。
- `startChild` 只等待 Temporal 确认启动，不等待产品结果。ABANDON 保证目录封闭/失败/换 Run 不取消产品。产品包装 Workflow 自己等待其下游结果。
- 页面和派发之间不是假装原子事务。未知启动回执不自动重投；保留发现和 pendingDispatches，分类为 SOURCE/COMMIT/DISPATCH_UNRESOLVED。当前没有自动补发器。
- 仅连续页面、经来源证明的 complete 末页、无派发未决、无目录故障才封闭为 complete。取消未封闭的目录只保持 open，不能用于确认缺席。
- 页面 hash / scope 不一致、断页、游标回环、重复产品身份冲突均拒绝。immutable triggers 禁止覆盖证据。

## 存在性

以同一个 brand/source/channel/region/rootUrl/scopeVersion 的发现集合为准，不读 collected_product 来推断缺席。发现过就是 exists，和是否缺货、处理是否成功无关；只有完整同范围、同身份粒度集合缺席才能 confirmed_absent；其余 unknown。不写 inactive，不自动重抓。一次 operation 的结果不可变；后续重新核查需要新的 operationId，不覆盖旧 unknown。

Swanson 新投影可声明 `familyCount`。封闭时要求每页都有相同总数、发现全部为family/null variant、唯一listing数匹配，并继续满足连续页和派发条件。closure保存 `coverage.unit=families`；此集合不能证明SKU缺席，未命中返回 `PRESENCE.VARIANT_COVERAGE_UNVERIFIED`。旧产品级closure保留原行为；不把旧页面补写成新证明。

## 当前接线与未验范围（CRAWLV3-36 保持进行中）

2026-09-11：Amazon独立来源已接同一CatalogWorkflow与不可变发现账本，真实UNIQUE E请求发现1个选中ASIN并持续派发公共逐文件下游；目录有限配置无全店证明，仍incomplete且不能推断缺席。产品独立以Review收口，不影响Brand完成，未新增保存。GNC/Swanson/Amazon合计90角色已常驻，旧60个非Web角色不变，见[当前报告](../../docs/quality/2026-09-11-amazon-mainflow.md)。下述Amazon未接线为历史状态；DTC、其它节点、隐藏/多轴规格和全店覆盖仍未验。

SavedGncCatalogSource仍只消费显式保存页面；真实浏览器入口已经另接Brand来源路由、逐页捕获/发布、独立产品会话、文件生命周期和共享资源。GNC/Swanson已完成有限新Brand网页实链并运行于Mini61角色部署，见[常驻报告](../../docs/quality/2026-09-10-channel-resident.md)。历史的“浏览器/授权未接线”不再代表当前状态。

新Swanson分页、商品族枚举→独立SKU及族级目录封闭见[覆盖报告](../../docs/quality/2026-09-10-swanson-coverage.md)。真实两页目录和双规格证据、独立PostgreSQL账本及Temporal合成提供商测试各有明确边界；发布是否激活以该报告为准。缺少下一页或规格控件本身不是完整证明。Amazon/DTC、其它节点和全SKU穷尽仍未由Mini有限品牌结果替代。
