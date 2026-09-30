# Crawler V3 · HeroUI demo

独立的 React 实现，不是旧 HTML 的 iframe 包装。保留旧 Web 入口与 Ant Design 页面。

真实 Brand / 来源配置另见 [V3_LIVE.md](./V3_LIVE.md)，运行在 4181。本 Demo 继续使用模拟数据，不能用它判断真实入库状态。

## 运行

```sh
pnpm --filter @crawl-automation/web dev:v3
```

打开 http://127.0.0.1:4179/v3.html 。构建：`pnpm --filter @crawl-automation/web build:v3`，输出到 `apps/web/dist-v3`。

## 结构

- Vite + React 19 + TypeScript，HeroUI 3.2.4，Tailwind CSS 4。
- `src/v3/pages`：工作总览、Brand 管理、发起采集、定时计划、数据与 Review。
- `src/v3/dialogs`：品牌/来源编辑、JSON 导入、计划编辑、触发确认与详情。
- `src/v3/ui.tsx`：HeroUI Table、Select、Checkbox、Switch、Input、Card 等公共组合；Modal、Tabs 等在对应页面使用。
- `src/v3/data/model.ts`：纯数据规则与 Zod 校验。
- `src/v3/store.tsx`：React 状态、浏览器存储、路由和弹窗状态。
- `src/v3/theme.css`：HeroUI 主题变量与 Tailwind 布局。

## 安全与演示边界

没有连接 Temporal、R2、生产 API、爬虫或模型服务。专用 Vite 配置没有旧项目 API 代理，且拒绝 `/api` 请求。模拟数据只保存在 `crawler-v3-heroui-demo:v1` 本地存储键中，可通过“重置演示”恢复。

计划时间基于固定演示时钟，保存计划不会后台执行。任务须在详情中手动推进；完成模拟任务只生成示例产品，不表示真实抓取或同步成功。来源使用 `.example` 域名。公司关联字段仅模拟映射，正式版需替换为可信公司 ID 选择。

保留业务约束：来源级防重叠、任务输入快照、Formula 与 Ingredients 完整即保存、公司未关联不阻塞、Review 被动留存、暂停计划不取消在途任务。

## 验证

```sh
pnpm --filter @crawl-automation/web check-types
pnpm --filter @crawl-automation/web test src/v3/data/model.test.ts
pnpm --filter @crawl-automation/web build:v3
```

目前以验证组件和交互为目的，未做生产级路由分包；构建可能提示主包超过 500 kB。真实认证、接口、导入后台事务与 Temporal 调度不在此 Demo 范围。

已验证：11 项模型测试；新建未关联公司的 Brand、添加 DTC 来源、选择来源与确认发起、计划开关、Review Tab 筛选。5 个页面在 360 / 390 / 768 / 1440 px 下通过页面溢出、单一主标题和重复 DOM ID 检查。宽表格在自身容器内横向滚动。原 Web 入口和 V3 入口均构建成功。
