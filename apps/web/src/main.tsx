import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useParams } from "@tanstack/react-router";
import { App as AntApp, Button, ConfigProvider, Input, Modal, Radio, Select, Space, message } from "antd";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz } from "ag-grid-community";
import { Activity, AlertTriangle, Bot, Boxes, CircleGauge, Database, GitPullRequest, ListChecks, Network, Play, Plus, Search, ServerCog } from "lucide-react";
import { api } from "./api";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchInterval: 15_000, staleTime: 5_000, retry: 1 } } });
const stages = ["capture", "process", "ingest", "cleanup"];
const gridTheme = themeQuartz.withParams({ accentColor: "#2f705a", backgroundColor: "#ffffff", borderColor: "#e6e9e7", headerBackgroundColor: "#f7f9f7", headerTextColor: "#5d6962", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, rowBorder: true, wrapperBorder: false });
const labels: Record<string, string> = { queued: "排队中", active: "运行中", retry_wait: "等待重试", needs_review: "需要复核", failed: "失败", completed: "已完成", leased: "已领取", running: "运行中", online: "在线", stale: "心跳延迟", offline: "离线" };
const Status = ({ value }: { value: string }) => <span className={`status-tag status-${value}`}>{labels[value] ?? value}</span>;

function Layout() {
  const control = useQuery({ queryKey: ["control-plane-health"], queryFn: () => api.dashboard.summary({}), retry: 0 });
  const nav = [
    ["/", "控制台", CircleGauge], ["/create", "创建任务", Plus], ["/runs", "运行记录", ListChecks],
    ["/nodes", "服务节点", Network], ["/channels", "渠道适配器", GitPullRequest], ["/reviews", "人工复核", AlertTriangle],
  ] as const;
  return <div className="app-shell">
    <aside className="app-sider">
      <div className="brand"><div className="brand-mark"><Boxes size={18}/></div><div><div className="brand-title">Crawl Operations</div><div className="brand-subtitle">Supply Smart pipeline</div></div></div>
      <div className="nav-label">Workspace</div><nav className="nav">{nav.map(([to, text, Icon]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }} className="nav-item" activeProps={{ className: "nav-item active" }}><Icon/>{text}</Link>)}</nav>
      <div className="sider-footer">Mac mini 控制台<br/>Railway control plane</div>
    </aside>
    <main className="app-stage"><section className="app-panel"><header className="topbar"><div className="crumb">Product data / Crawl automation</div><div className="top-status"><span className="pulse" style={control.isError ? { background: "#c65349", boxShadow: "0 0 0 4px rgba(198,83,73,.1)" } : undefined}/>{control.isError ? "Control plane unavailable" : "Control plane connected"}</div></header><div className="content"><Outlet/></div></section></main>
  </div>;
}
const PageHead = ({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) => <div className="page-head"><div><h1 className="page-title">{title}</h1><p className="page-description">{description}</p></div>{action}</div>;

function Dashboard() {
  const { data } = useQuery({ queryKey: ["summary"], queryFn: () => api.dashboard.summary({}) });
  const runs = useQuery({ queryKey: ["runs", "recent"], queryFn: () => api.runs.list({ limit: 8 }) });
  const stats = [["全部任务", data?.runs.total ?? 0], ["运行中", data?.runs.active ?? 0], ["需要复核", data?.runs.needsReview ?? 0], ["在线节点", `${data?.nodes.online ?? 0} / ${data?.nodes.total ?? 0}`]];
  return <><PageHead title="自动化控制台" description="查看从页面证据到产品入库的完整运行状态。" action={<Link to="/create"><Button type="primary" icon={<Plus size={15}/>}>创建任务</Button></Link>}/>
    <div className="stats">{stats.map(([label, value]) => <div className="stat-card" key={label}><div className="stat-label">{label}</div><div className="stat-value">{value}</div></div>)}</div>
    <RunsGrid rows={runs.data ?? []} height={430}/></>;
}

function RunsGrid({ rows, height = 560 }: { rows: any[]; height?: number }) {
  const columns = useMemo(() => [
    { field: "url", headerName: "网站", flex: 1.8, minWidth: 260, cellRenderer: (p: any) => <Link to="/runs/$runId" params={{ runId: p.data.id }} style={{ color: "#24664f", fontWeight: 650 }}>{p.value}</Link> },
    { field: "sourceType", headerName: "来源", width: 130, valueFormatter: (p: any) => p.value === "dtc_browser" ? "DTC Browser" : p.data.adapter?.toUpperCase() },
    { field: "status", headerName: "状态", width: 125, cellRenderer: (p: any) => <Status value={p.value}/> },
    { field: "itemCount", headerName: "产品", width: 90 }, { field: "openReviews", headerName: "复核", width: 90 },
    { field: "updatedAt", headerName: "更新时间", width: 170, valueFormatter: (p: any) => new Date(p.value).toLocaleString("zh-CN") },
  ], []);
  return <div className="card"><div className="card-head"><div className="card-title">运行记录</div><span style={{ color: "#8a948e", fontSize: 11 }}>{rows.length} 条</span></div><div style={{ height }}><AgGridReact theme={gridTheme} rowData={rows} columnDefs={columns as any} rowHeight={46} headerHeight={39}/></div></div>;
}

function CreateRun() {
  const [raw, setRaw] = useState(""); const [mode, setMode] = useState<"one_off" | "recurring">("one_off"); const [cron, setCron] = useState("0 3 * * *");
  const urls = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const preview = useQuery({ queryKey: ["classify", urls], queryFn: () => api.classify.urls({ urls }), enabled: urls.length > 0, refetchInterval: false });
  const navigateRows = useQueryClient();
  const create = useMutation({ mutationFn: () => api.runs.create({ urls, mode, scheduleCron: mode === "recurring" ? cron : null, scheduleTimezone: "Asia/Shanghai" }), onSuccess: async (result) => { message.success(`已创建 ${result.created.length} 个任务`); await navigateRows.invalidateQueries(); setRaw(""); } });
  return <><PageHead title="创建抓取任务" description="每行输入一个网址，系统会自动选择 Browser Node 或固定渠道适配器。"/>
    <div className="form-grid"><div className="card form-card"><label className="field-label">网站列表</label><textarea className="url-input" value={raw} onChange={(event) => setRaw(event.target.value)} placeholder={"https://brand-a.com\nhttps://www.amazon.com/dp/..."}/>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "end", marginTop: 16 }}><div><label className="field-label">运行方式</label><Radio.Group value={mode} onChange={(event) => setMode(event.target.value)}><Radio.Button value="one_off">单次运行</Radio.Button><Radio.Button value="recurring">定时运行</Radio.Button></Radio.Group></div>{mode === "recurring" && <div style={{ width: 220 }}><label className="field-label">Cron（Asia/Shanghai）</label><Input value={cron} onChange={(event) => setCron(event.target.value)}/></div>}<Button type="primary" icon={<Play size={15}/>} disabled={!urls.length} loading={create.isPending} onClick={() => create.mutate()}>加入队列</Button></div>
    </div><div className="card form-card"><div className="card-title" style={{ marginBottom: 13 }}>路由预览</div>{!urls.length ? <div className="empty">输入网址后显示执行节点</div> : <div className="classification-list">{preview.data?.map((item, index) => <div className="classification" key={`${item.url}-${index}`}><div className="classification-host">{item.host || item.url}</div><div className="classification-meta"><span>{item.type === "dtc_browser" ? "Windows · Browser Node" : `Mac mini · ${item.adapter?.toUpperCase()} Adapter`}</span><Status value={item.supported ? "queued" : "failed"}/></div></div>)}</div>}</div></div></>;
}

function Runs() { const { data } = useQuery({ queryKey: ["runs"], queryFn: () => api.runs.list({ limit: 200 }) }); return <><PageHead title="运行记录" description="每个任务的阶段状态由通用 Job DAG 自动汇总。"/><RunsGrid rows={data ?? []}/></>; }

function RunDetail() {
  const { runId } = useParams({ from: "/runs/$runId" }); const { data } = useQuery({ queryKey: ["run", runId], queryFn: () => api.runs.get({ id: runId }) });
  const detail = data as any; if (!detail) return <div className="empty">正在加载任务…</div>;
  return <><PageHead title={detail.run.url} description={`Run ${runId}`} action={<Status value={detail.run.status}/>}/><div className="stage-strip">{stages.map((stage) => <div className="stage-box" key={stage}><div className="stage-name">{stage}</div><div className="stage-state"><Status value={detail.run.stages[stage] ?? "queued"}/></div></div>)}</div><div className="detail-grid"><div className="card"><div className="card-head"><div className="card-title">Job 事件与错误</div></div><pre className="json-view">{JSON.stringify(detail.jobs, null, 2)}</pre></div><div className="card"><div className="card-head"><div className="card-title">产物与复核</div></div><pre className="json-view">{JSON.stringify({ artifacts: detail.artifacts, reviews: detail.reviews }, null, 2)}</pre></div></div></>;
}

function Nodes() {
  const { data } = useQuery({ queryKey: ["nodes"], queryFn: () => api.nodes.list({}) });
  const columns = useMemo(() => [{ field: "name", headerName: "节点", flex: 1.3 }, { field: "platform", headerName: "系统", flex: 1 }, { field: "capabilities", headerName: "能力", flex: 1.6, valueFormatter: (p: any) => p.value.join(" · ") }, { field: "activeJobs", headerName: "活动 Job", width: 110, valueFormatter: (p: any) => `${p.value} / ${p.data.maxConcurrency}` }, { field: "status", headerName: "状态", width: 120, cellRenderer: (p: any) => <Status value={p.value}/> }, { field: "lastSeenAt", headerName: "最后心跳", width: 175, valueFormatter: (p: any) => new Date(p.value).toLocaleString("zh-CN") }], []);
  return <><PageHead title="服务节点" description="物理机器可以替换；任务按 capability、租约和断点继续运行。"/><div className="card grid-wrap"><AgGridReact theme={gridTheme} rowData={data ?? []} columnDefs={columns as any} rowHeight={46}/></div></>;
}

function Channels() {
  const { data } = useQuery({ queryKey: ["channels"], queryFn: () => api.channels.list({}) });
  const columns = useMemo(() => [{ field: "adapter", headerName: "适配器", flex: 1, valueFormatter: (p: any) => p.value.toUpperCase() }, { field: "implemented", headerName: "实现状态", width: 130, cellRenderer: (p: any) => <Status value={p.value ? "completed" : "queued"}/> }, { field: "runCount", headerName: "运行", width: 100 }, { field: "successCount", headerName: "成功", width: 100 }, { field: "failureCount", headerName: "失败", width: 100 }, { field: "successRate", headerName: "成功率", width: 110, valueFormatter: (p: any) => `${(p.value * 100).toFixed(1)}%` }, { field: "lastError", headerName: "最近错误", flex: 1.6 }], []);
  return <><PageHead title="渠道适配器" description="固定渠道失败只在原适配器内重试，不会回退到 Browser Node。"/><div className="card grid-wrap"><AgGridReact theme={gridTheme} rowData={data ?? []} columnDefs={columns as any} rowHeight={46}/></div></>;
}

function Reviews() {
  const qc = useQueryClient(); const { data } = useQuery({ queryKey: ["reviews"], queryFn: () => api.reviews.list({ status: "open" }) });
  const resolve = useMutation({ mutationFn: (input: any) => api.reviews.resolve(input), onSuccess: () => qc.invalidateQueries({ queryKey: ["reviews"] }) });
  const act = (row: any, action: "retry" | "resume" | "abandon") => Modal.confirm({ title: action === "abandon" ? "终止这个任务？" : "恢复这个任务？", content: row.reasonMessage, okType: action === "abandon" ? "danger" : "primary", onOk: () => resolve.mutateAsync({ id: row.id, action, resolution: `由状态网页执行 ${action}` }) });
  const columns = useMemo(() => [{ field: "url", headerName: "网站", flex: 1.3 }, { field: "reasonCode", headerName: "原因", width: 170 }, { field: "reasonMessage", headerName: "说明", flex: 1.8 }, { field: "createdAt", headerName: "创建时间", width: 170, valueFormatter: (p: any) => new Date(p.value).toLocaleString("zh-CN") }, { headerName: "操作", width: 190, cellRenderer: (p: any) => <Space><Button size="small" onClick={() => act(p.data, "retry")}>重试</Button><Button size="small" danger onClick={() => act(p.data, "abandon")}>终止</Button></Space> }], []);
  return <><PageHead title="人工复核" description="证据会保留到复核处理完成，之后才允许清理。"/><div className="card grid-wrap"><AgGridReact theme={gridTheme} rowData={data ?? []} columnDefs={columns as any} rowHeight={50}/></div></>;
}

function DebugPrompt() {
  const [url, setUrl] = useState(""); const [prompt, setPrompt] = useState("");
  return <><PageHead title="Prompt 调试" description="受限开发入口；生产 Browser Node 使用同一个共享 Prompt Builder。"/><div className="card form-card"><Space.Compact style={{ width: "100%" }}><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com"/><Button icon={<Search size={14}/>} onClick={async () => setPrompt((await api.debug.prompt({ url, runId: crypto.randomUUID(), jobDirectory: "/debug/job" })).prompt)}>生成</Button></Space.Compact>{prompt && <pre className="json-view" style={{ marginTop: 16, whiteSpace: "pre-wrap" }}>{prompt}</pre>}</div></>;
}

const rootRoute = createRootRoute({ component: Layout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Dashboard });
const createRunRoute = createRoute({ getParentRoute: () => rootRoute, path: "/create", component: CreateRun });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: Runs });
const runDetailRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetail });
const nodesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/nodes", component: Nodes });
const channelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/channels", component: Channels });
const reviewsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reviews", component: Reviews });
const debugRoute = createRoute({ getParentRoute: () => rootRoute, path: "/developer/prompt", component: DebugPrompt });
const routeTree = rootRoute.addChildren([indexRoute, createRunRoute, runsRoute, runDetailRoute, nodesRoute, channelsRoute, reviewsRoute, debugRoute]);
const router = createRouter({ routeTree });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

createRoot(document.getElementById("root")!).render(<React.StrictMode><ConfigProvider theme={{ token: { colorPrimary: "#276a53", borderRadius: 8, fontSize: 13 } }}><AntApp><QueryClientProvider client={queryClient}><RouterProvider router={router}/></QueryClientProvider></AntApp></ConfigProvider></React.StrictMode>);
