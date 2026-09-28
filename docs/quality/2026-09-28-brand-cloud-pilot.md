# 2026-09-28 云端公司 Brand 搜索试点（50 个，用户："go ahead with the 50 brand pilot"）

## 范围

- 来源：云端 Railway `company` 表（只读查询）。当前 4,824 家；已在 1,351 品牌集中 1,306 家；未覆盖 3,518 家，其中 `is_visible AND is_nutrition` **3,355** 家。
- 试点：从 3,355 家中按 `md5(id || 'pilot-20260928')` 取 50 家（等同随机）。搜索词为 canonical_name 或去掉 Inc./LLC 等后缀的公司名；原名作为可接受名称保留。
- Server 二只收到品牌名与随机 UUID；随机 ID↔公司 ID 映射只在 MacBook 本地，结果汇总见 [evidence/2026-09-28-brand-cloud-pilot-50.json](evidence/2026-09-28-brand-cloud-pilot-50.json)。

## 部署

- 分支 `feat/brand-direct-filter-20260924`（8 个提交，只涉及 brand-entry 工具和 `amazon-brand-search.mjs`，生产 Worker 不引用）合入 `main`，推送 `2be3bcf`。
- 两台机器都从 GitHub `git clone` 后 checkout `2be3bcf`：Server 一 `~/apps/crawler-v3/brand-entry/source-main-20260928`（broker），Server 二 `~/apps/crawler-brand-entry-main-20260928`（collector）；11 项测试两边通过。
- 运行目录：Server 二 `~/brand-entry-runs/20260928-cloud-pilot-50`，Server 一 `brand-entry/local-runs/20260928-cloud-pilot-50`。

## 结果

06:08:33–06:08:52Z，65 次请求、325 额度，65 份响应全部 200、SHA-256 与字节数复核一致。broker（PID 2242）已按精确 PID 停止，端口已释放。**未导入任何数据库。**

| 结果 | 数量 |
|---|---:|
| verified 品牌筛选搜索 URL | **15**（30%） |
| Review：搜索页没有匹配的品牌筛选 | 35 |

Verified：Bufferin、CHOQ、FGO、FREZZOR、Foster & Thrive、Kuli Kuli、Let Loose、Mamma Chia、Mushroom Wisdom、Natrium Health、NutraChamps、PureFormulas、Symbiotics、TheraBotanics、up4。

Review 的 35 个中，约 28 个搜索页根本没有 Brands 筛选项；其余有筛选但没有同名品牌（如 Legion Athletics 的亚马逊品牌名是 "Legion"，需人工确认改名后可再搜；"Bulk"、"panax ginseng extract"、"technology lifestyle" 等是通用词或不像品牌的记录）。

## 对全量的意义

命中率 30%，明显低于第一批（1,351 个来自有亚马逊商品的公司）的首轮结果：这批公司多数没有亚马逊商品历史。全量 3,355 家按本次比例约需 4,400 次请求、~22,000 额度，预计约 1,000 个 verified。这批没有示例 ASIN，identity 模式（读 byline 找店铺链接）不能直接用；只能对搜索发现模式（`discoverFromSearch`）另行评估。
