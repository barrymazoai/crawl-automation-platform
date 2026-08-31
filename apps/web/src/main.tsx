import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate, useParams } from "@tanstack/react-router";
import { App as AntApp, Button, ConfigProvider, Input, Modal, Radio, Space, message } from "antd";
import { AgGridReact } from "ag-grid-react";
import { themeQuartz } from "ag-grid-community";
import { AlertTriangle, ArrowLeft, Boxes, CircleGauge, GitPullRequest, ListChecks, Network, Play, Plus, Search } from "lucide-react";
import { api } from "./api";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { refetchInterval: 15_000, staleTime: 5_000, retry: 1 } } });
const gridTheme = themeQuartz.withParams({ accentColor: "#2f705a", backgroundColor: "#ffffff", borderColor: "#e6e9e7", headerBackgroundColor: "#f7f9f7", headerTextColor: "#5d6962", fontFamily: "Inter, system-ui, sans-serif", fontSize: 12, rowBorder: true, wrapperBorder: false });
const labels: Record<string, string> = { queued: "排队中", active: "运行中", retry_wait: "等待重试", needs_review: "需要复核", failed: "失败", completed: "已完成", leased: "已领取", running: "运行中", online: "在线", stale: "心跳延迟", offline: "离线", abandoned: "已终止" };
const Status = ({ value }: { value: string }) => <span className={`status-tag status-${value}`}>{labels[value] ?? value}</span>;

/* ── v2 流水线：泳道定义与通用小组件 ─────────────────────────── */
const LANES = [
  { key: "capture", name: "抓取", stages: ["capture_catalog", "capture", "process"] },
  { key: "text", name: "文字 · 语义", stages: ["process_text"] },
  { key: "images", name: "图片 · OCR", stages: ["process_images"] },
  { key: "unify", name: "整合 · Unify", stages: ["product_join", "product_unify"] },
  { key: "ingest", name: "入库收尾", stages: ["catalog_finalize", "ingest_staging", "ingest", "cleanup_run", "cleanup"] },
] as const;

type Progress = { total: number; completed: number; active: number; queued: number; review: number; failed: number };
const emptyProgress = (): Progress => ({ total: 0, completed: 0, active: 0, queued: 0, review: 0, failed: 0 });
function laneProgress(stageProgress: Record<string, Progress> | undefined, stages: readonly string[]) {
  const sum = emptyProgress();
  for (const stage of stages) {
    const p = stageProgress?.[stage];
    if (!p) continue;
    sum.total += p.total; sum.completed += p.completed; sum.active += p.active;
    sum.queued += p.queued; sum.review += p.review; sum.failed += p.failed;
  }
  return sum;
}

function runLabel(url: string) {
  try {
    const parsed = new URL(url);
    const asin = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
    if (asin) return `单品 ${asin}`;
    const segment = parsed.pathname.split("/").filter(Boolean)
      .filter((value) => !["brands", "stores", "page"].includes(value.toLowerCase()))
      .pop();
    if (!segment) return parsed.hostname;
    return decodeURIComponent(segment).replace(/\.html$/i, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  } catch { return url; }
}
const channelName = (adapter: string | null, sourceType?: string) => adapter ? adapter.toUpperCase() : sourceType === "dtc_browser" ? "DTC" : "—";
const batchShort = (batchId: string | null) => batchId ? `批 ${Number(batchId.replace(/\D/g, "")) || batchId}` : "";

function StateTag({ state, live }: { state: string; live?: boolean }) {
  const kind = state === "completed" ? "good" : state === "leased" || state === "running" ? "info" : state === "needs_review" ? "warn" : state === "failed" ? "bad" : "idle";
  return <span className={`tag ${kind}`}>{live && kind === "info" ? <span className="dot live"/> : null}{labels[state] ?? state}</span>;
}

function SegBar({ p, doneLabel }: { p: Progress; doneLabel?: string }) {
  if (!p.total) return <span className="cell-na">—</span>;
  const sequence = [
    ...Array(p.completed).fill("done"), ...Array(p.review).fill("warn"), ...Array(p.failed).fill("bad"),
    ...Array(p.active).fill("run"), ...Array(Math.max(0, p.total - p.completed - p.review - p.failed - p.active)).fill(""),
  ];
  const cap = Math.min(p.total, 8);
  const cells = Array.from({ length: cap }, (_, index) => sequence[Math.floor((index * sequence.length) / cap)]);
  const label = p.review > 0 ? "复核中" : p.failed > 0 ? "有失败" : `${p.completed}/${p.total}`;
  return <><span className="seg">{cells.map((cls, index) => <i key={index} className={cls}/>)}</span><span className="seg-label num">{label}</span></>;
}

function RunStatusTag({ status, openReviews }: { status: string; openReviews: number }) {
  if (openReviews > 0) return <span className="tag warn">待复核 · 不阻塞</span>;
  if (status === "completed") return <span className="tag good">已完成</span>;
  if (status === "failed") return <span className="tag bad">失败</span>;
  if (status === "abandoned") return <span className="tag idle">已终止</span>;
  if (status === "queued") return <span className="tag idle">排队中</span>;
  return <span className="tag info"><span className="dot live"/>运行中</span>;
}

/* ── 布局 ────────────────────────────────────────────────────── */
function Layout() {
  const control = useQuery({ queryKey: ["control-plane-health"], queryFn: () => api.dashboard.summary({}), retry: 0 });
  const reviews = useQuery({ queryKey: ["reviews"], queryFn: () => api.reviews.list({ status: "open" }) });
  const nav = [
    ["/", "控制台", CircleGauge], ["/create", "创建任务", Plus], ["/runs", "运行记录", ListChecks],
    ["/nodes", "服务节点", Network], ["/channels", "渠道适配器", GitPullRequest], ["/reviews", "人工复核", AlertTriangle],
  ] as const;
  return <div className="app-shell">
    <aside className="app-sider">
      <div className="brand"><div className="brand-mark"><Boxes size={18}/></div><div><div className="brand-title">Crawl Operations</div><div className="brand-subtitle">Supply Smart pipeline</div></div></div>
      <div className="nav-label">Workspace</div>
      <nav className="nav">{nav.map(([to, text, Icon]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }} className="nav-item" activeProps={{ className: "nav-item active" }}><Icon/>{text}{to === "/reviews" && (reviews.data?.length ?? 0) > 0 ? <span className="tag warn" style={{ marginLeft: "auto", fontSize: 10 }}>{reviews.data!.length}</span> : null}</Link>)}</nav>
      <div className="sider-footer">Mac mini 控制台 · v2 并行流水线<br/>抓取与处理互不等待</div>
    </aside>
    <main className="app-stage"><section className="app-panel"><header className="topbar"><div className="crumb">Product data / Crawl automation</div><div className="top-status"><span className="pulse" style={control.isError ? { background: "#c65349", boxShadow: "0 0 0 4px rgba(198,83,73,.1)" } : undefined}/>{control.isError ? "Control plane unavailable" : "Control plane connected"}</div></header><div className="content"><Outlet/></div></section></main>
  </div>;
}
const PageHead = ({ title, description, action }: { title: string; description: React.ReactNode; action?: React.ReactNode }) => <div className="page-head"><div><h1 className="page-title">{title}</h1><p className="page-description">{description}</p></div>{action}</div>;

/* ── 控制台（流水线视图） ────────────────────────────────────── */
function Dashboard() {
  const { data } = useQuery({ queryKey: ["summary"], queryFn: () => api.dashboard.summary({}) });
  const runs = useQuery({ queryKey: ["runs", "matrix"], queryFn: () => api.runs.list({ limit: 30 }) });
  const reviews = useQuery({ queryKey: ["reviews"], queryFn: () => api.reviews.list({ status: "open" }) });
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: () => api.nodes.list({}) });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const resolve = useMutation({ mutationFn: (input: any) => api.reviews.resolve(input), onSuccess: () => qc.invalidateQueries() });
  const act = (row: any, action: "retry" | "abandon") => Modal.confirm({
    title: action === "abandon" ? "终止这个任务？" : "重试这个 Job？", content: row.reasonMessage,
    okType: action === "abandon" ? "danger" : "primary",
    onOk: () => resolve.mutateAsync({ id: row.id, action, resolution: `由控制台执行 ${action}` }),
  });

  const stageRows = data?.stages ?? [];
  const byStage = new Map(stageRows.map((row) => [row.stage, row]));
  const laneStats = LANES.map((lane) => {
    const agg = { queued: 0, active: 0, review: 0, done1h: 0, avg: null as number | null };
    const avgs: number[] = [];
    for (const stage of lane.stages) {
      const row = byStage.get(stage);
      if (!row) continue;
      agg.queued += row.queued; agg.active += row.active; agg.review += row.needsReview; agg.done1h += row.completed1h;
      if (row.avgSeconds24h != null) avgs.push(row.avgSeconds24h);
    }
    if (avgs.length) agg.avg = Math.round(avgs.reduce((a, b) => a + b, 0) / avgs.length);
    return { ...lane, ...agg };
  });
  const laneChips = LANES.map((lane) => (data?.activeJobs ?? []).filter((job) => (lane.stages as readonly string[]).includes(job.stage)));
  const done1hTotal = stageRows.reduce((sum, row) => sum + row.completed1h, 0);
  const telemetry = data?.telemetry;
  const activeRuns = (runs.data ?? []).filter((run) => !["completed", "abandoned"].includes(run.status) || run.openReviews > 0).slice(0, 8);
  const recentDone = (runs.data ?? []).filter((run) => run.status === "completed" && !run.openReviews).slice(0, 4);
  const matrixRows = [...activeRuns, ...recentDone];
  const fmtAvg = (value: number | null) => value == null ? "—" : value >= 60 ? `${Math.round(value / 60)}m` : `${value}s`;

  return <>
    <PageHead title="流水线控制台" description="抓取、文字、图片、整合、入库五条线互不等待——品牌 B 抓取中，品牌 A 同时在处理和入库。"
      action={<Link to="/create"><Button type="primary" icon={<Plus size={15}/>}>创建任务</Button></Link>}/>

    <div className="statusband">
      <div className="stat"><div className="stat-label">进行中任务</div><div className="stat-row num">{data?.runs.active ?? 0} <span className="stat-sub">/ 共 {data?.runs.total ?? 0}</span></div><div className="stat-foot">已完成 {data?.runs.completed ?? 0} · 失败 {data?.runs.failed ?? 0}</div></div>
      <div className="stat"><div className="stat-label">近 1 小时完成</div><div className="stat-row num">{done1hTotal} <span className="stat-sub">个 Job</span></div><div className="stat-foot">全部流水线阶段合计</div></div>
      <div className="stat"><div className="stat-label">在线节点</div><div className="stat-row num">{data?.nodes.online ?? 0} <span className="stat-sub">/ {data?.nodes.total ?? 0}</span></div><div className="stat-foot">按 capability 领取任务</div></div>
      <div className="stat"><div className="stat-label">待人工复核</div><div className="stat-row num" style={(data?.runs.needsReview ?? 0) > 0 ? { color: "#916317" } : undefined}>{reviews.data?.length ?? 0}</div><div className="stat-foot">证据已保留，不阻塞其他品牌</div></div>

      <div className="stat wide">
        <div className="stat-label" style={{ display: "flex", justifyContent: "space-between" }}>磁盘背压 {telemetry?.disk
          ? <span className={`tag ${telemetry.disk.state === "normal" ? "good" : telemetry.disk.state === "soft" ? "warn" : "bad"}`} style={{ fontSize: 10 }}><span className="dot"/>{telemetry.disk.state === "normal" ? "正常" : telemetry.disk.state === "soft" ? "软阈值" : "硬阈值"}</span>
          : <span className="tag idle" style={{ fontSize: 10 }}>未上报</span>}</div>
        {telemetry?.disk ? <>
          <div className="stat-row num" style={{ fontSize: 19 }}>{telemetry.disk.freeGb} GB <span className="stat-sub">可用</span></div>
          <div className="meter"><i style={{ width: `${Math.min(100, Math.round((telemetry.disk.freeGb / Math.max(telemetry.disk.freeGb, telemetry.disk.softGb * 2.5)) * 100))}%` }}/></div>
          <div className="stat-foot num">软阈值 {telemetry.disk.softGb} GB · 硬阈值 {telemetry.disk.hardGb} GB · {telemetry.disk.nodeId}</div>
        </> : <div className="stat-foot" style={{ marginTop: 12 }}>等待 worker 心跳上报磁盘状态</div>}
      </div>
      <div className="stat wide">
        <div className="stat-label" style={{ display: "flex", justifyContent: "space-between" }}>GNC 出口轮动 {telemetry?.egress
          ? <span className="tag good" style={{ fontSize: 10 }}><span className="dot live"/>轮动中</span>
          : <span className="tag idle" style={{ fontSize: 10 }}>未启用</span>}</div>
        {telemetry?.egress ? <>
          <div className="ip-now"><span className="num">{telemetry.egress.ip ?? "IP 未回显"}</span><span className="tag good" style={{ fontSize: 10 }}>{telemetry.egress.exitId}</span><span style={{ color: "#96a09a", fontSize: 11 }}>当前出口 IP</span></div>
          <div className="exit-cycle">{telemetry.egress.exits.map((exit, index) => <React.Fragment key={exit}>{index > 0 && <span>→</span>}<span className={`exit${exit === telemetry.egress!.exitId ? " on" : ""}`}>{exit}</span></React.Fragment>)}</div>
        </> : <div className="stat-foot" style={{ marginTop: 12 }}>GNC 抓取 worker 未运行或未开启 IP 轮动</div>}
      </div>
      <div className="stat wide">
        <div className="stat-label" style={{ display: "flex", justifyContent: "space-between" }}>Codex 余量 <span className="tag idle" style={{ fontSize: 10 }}>每 5 分钟刷新</span></div>
        {telemetry?.codex ? <>
          <div className="quota-row"><span className="quota-name">5 小时窗口</span><div className="meter"><i style={{ width: `${telemetry.codex.fiveHourPercentLeft ?? 0}%` }}/></div><span className="quota-val">{telemetry.codex.fiveHourPercentLeft ?? "—"}%</span></div>
          <div className="quota-row"><span className="quota-name">周限额</span><div className="meter"><i style={{ width: `${telemetry.codex.weeklyPercentLeft ?? 0}%`, background: (telemetry.codex.weeklyPercentLeft ?? 100) < 50 ? "#d9a63f" : undefined }}/></div><span className="quota-val">{telemetry.codex.weeklyPercentLeft ?? "—"}%</span></div>
          <div className="stat-foot">{telemetry.codex.resetsAt ? `窗口 ${new Date(telemetry.codex.resetsAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 重置 · ` : ""}上报于 {new Date(telemetry.codex.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</div>
        </> : <div className="stat-foot" style={{ marginTop: 12 }}>等待 Codex 上报 · 首次模型调用后自动接入</div>}
      </div>
    </div>

    <div className="lanes">{laneStats.map((lane, index) => <div className="lane" key={lane.key}>
      <div className="lane-head">
        <div className="lane-name">{lane.name} {lane.review > 0
          ? <span className="tag warn" style={{ fontSize: 10 }}>{lane.review} 待复核</span>
          : lane.active > 0 ? <span className="tag info" style={{ fontSize: 10 }}><span className="dot live"/>{lane.active} 在跑</span> : <span className="tag idle" style={{ fontSize: 10 }}>空闲</span>}</div>
        <div className="lane-kpis">
          <div className="lane-kpi"><b className="num">{lane.queued}</b><span>排队</span></div>
          <div className="lane-kpi"><b className="num">{lane.done1h}</b><span>1h 完成</span></div>
          <div className="lane-kpi"><b className="num">{fmtAvg(lane.avg)}</b><span>均次</span></div>
        </div>
      </div>
      <div className="lane-body">
        {laneChips[index]!.length === 0 && <div className="lane-empty">没有进行中的 Job</div>}
        {laneChips[index]!.slice(0, 4).map((job, jobIndex) => <div className="jobchip hot" key={jobIndex} onClick={() => navigate({ to: "/runs/$runId", params: { runId: job.runId } })} style={{ cursor: "pointer" }}>
          <div className="jobchip-top"><span className="jobchip-brand">{channelName(job.adapter)} · {runLabel(job.url)}</span>{job.batchId && <span className="tag info" style={{ fontSize: 10 }}>{batchShort(job.batchId)}</span>}</div>
          {(job.exit || job.batchId) && <div className="jobchip-meta"><span>{job.exit ? `出口 ${job.exit}` : labels[job.state]}</span><span className="num">{job.batchId ?? ""}</span></div>}
        </div>)}
        {laneChips[index]!.length > 4 && <div className="lane-empty" style={{ margin: 0, padding: "2px 0" }}>还有 {laneChips[index]!.length - 4} 个在跑</div>}
      </div>
    </div>)}</div>

    <div className="card">
      <div className="card-head"><div className="card-title">品牌运行矩阵</div><span className="card-hint">每格显示该线 Job 进度 · 点击行进入详情</span></div>
      <div style={{ overflowX: "auto" }}>
        <table className="runs-table">
          <thead><tr><th style={{ width: "26%" }}>品牌 / 来源</th><th className="c">抓取</th><th className="c">文字</th><th className="c">图片</th><th className="c">整合</th><th className="c">入库</th><th style={{ width: 120 }}>状态</th></tr></thead>
          <tbody>
            {matrixRows.length === 0 && <tr><td colSpan={7}><div className="empty" style={{ minHeight: 100 }}>还没有任务，从「创建任务」开始</div></td></tr>}
            {matrixRows.map((run) => <tr key={run.id} onClick={() => navigate({ to: "/runs/$runId", params: { runId: run.id } })}>
              <td><div className="run-name">{channelName(run.adapter, run.sourceType)} · {runLabel(run.url)}</div><div className="run-sub">{run.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 46)} · {run.id.slice(0, 8)}</div></td>
              {LANES.map((lane) => <td className="c" key={lane.key}><SegBar p={laneProgress(run.stageProgress as any, lane.stages)}/></td>)}
              <td><RunStatusTag status={run.status} openReviews={run.openReviews}/></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </div>

    <div className="below">
      <div className="card">
        <div className="card-head"><div className="card-title">人工复核队列</div><span className="card-hint">只暂停对应产品，其余照常运行</span></div>
        {(reviews.data ?? []).slice(0, 4).map((row) => <div className="review-row" key={row.id}>
          <div className="review-main">
            <div className="review-title">{runLabel(row.url)} <code>{row.reasonCode}</code></div>
            <div className="review-desc" title={row.reasonMessage}>{row.reasonMessage}</div>
          </div>
          <div className="review-actions"><Button size="small" onClick={() => act(row, "retry")}>重试</Button><Button size="small" danger onClick={() => act(row, "abandon")}>终止</Button></div>
        </div>)}
        {(reviews.data?.length ?? 0) === 0 && <div className="review-row" style={{ justifyContent: "center", color: "#a9b1ac", fontSize: 11.5 }}>没有待复核项</div>}
      </div>
      <div className="card">
        <div className="card-head"><div className="card-title">Worker Pool</div><span className="card-hint">{nodes.data?.filter((n) => n.status === "online").length ?? 0} / {nodes.data?.length ?? 0} 在线</span></div>
        <div className="nodes-list">
          {(nodes.data ?? []).map((node) => <div className="node-row" key={node.id}>
            <div><div className="node-name">{node.name}</div><div className="node-caps">{node.capabilities.join(" · ")}</div></div>
            <div className="node-load num">{node.activeJobs} / {node.maxConcurrency}</div>
            <span className={`tag ${node.status === "online" ? "good" : node.status === "stale" ? "warn" : "bad"}`}><span className="dot"/>{labels[node.status]}</span>
          </div>)}
          {(nodes.data?.length ?? 0) === 0 && <div className="review-row" style={{ justifyContent: "center", color: "#a9b1ac", fontSize: 11.5 }}>没有注册的节点</div>}
        </div>
      </div>
    </div>
  </>;
}

/* ── Run 详情（Batch × Stage 矩阵） ──────────────────────────── */
function RunDetail() {
  const { runId } = useParams({ from: "/runs/$runId" });
  const { data } = useQuery({ queryKey: ["run", runId], queryFn: () => api.runs.get({ id: runId }) });
  const qc = useQueryClient();
  const resolve = useMutation({ mutationFn: (input: any) => api.reviews.resolve(input), onSuccess: () => qc.invalidateQueries() });
  const detail = data as any;
  if (!detail) return <div className="empty">正在加载任务…</div>;
  const jobs: any[] = detail.jobs ?? [];
  const find = (...stages: string[]) => jobs.find((job) => stages.includes(job.stage));
  const captureJob = find("capture_catalog", "capture", "process");
  const finalizeJob = find("catalog_finalize");
  const ingestJob = find("ingest_staging", "ingest");
  const cleanupJob = find("cleanup_run", "cleanup");
  const batches = new Map<string, { batchId: string; itemCount?: number; exit?: string; jobs: Record<string, any> }>();
  for (const job of jobs) {
    const batchId = job.payload?.batchId;
    if (!batchId) continue;
    const entry = batches.get(batchId) ?? { batchId, itemCount: job.payload?.itemCount, exit: job.payload?.exit, jobs: {} as Record<string, any> };
    entry.jobs[job.stage] = job;
    batches.set(batchId, entry);
  }
  const batchRows = [...batches.values()].sort((a, b) => a.batchId.localeCompare(b.batchId));
  const isV2 = batchRows.length > 0 || Boolean(find("capture_catalog"));
  const trail: Array<{ exit: string; count: number }> = [];
  for (const row of batchRows) {
    if (!row.exit) continue;
    const last = trail[trail.length - 1];
    if (last && last.exit === row.exit) last.count += 1; else trail.push({ exit: row.exit, count: 1 });
  }
  const openReviews = (detail.reviews ?? []).filter((row: any) => row.status === "open");
  const finalizeOut = finalizeJob?.output ?? null;
  const ingestOut = ingestJob?.output ?? null;
  const captureOut = captureJob?.output ?? null;
  const tailDot = (job: any) => !job ? "" : job.state === "completed" ? "done" : job.state === "needs_review" ? "warn" : "";
  const fmtTime = (value: string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

  return <>
    <Link to="/" className="backlink"><ArrowLeft size={14}/>返回控制台</Link>
    <PageHead title={`${channelName(detail.run.adapter, detail.run.sourceType)} · ${runLabel(detail.run.url)}`}
      description={<span className="num" style={{ fontFamily: "ui-monospace, Menlo, monospace" }}>{detail.run.url} · Run {runId}</span>}
      action={<Space><RunStatusTag status={detail.run.status} openReviews={detail.run.openReviews}/></Space>}/>

    {!isV2 && <>
      <div className="stage-strip">{["capture", "process", "ingest", "cleanup"].map((stage) => <div className="stage-box" key={stage}><div className="stage-name">{stage}</div><div className="stage-state"><Status value={detail.run.stages[stage] ?? "queued"}/></div></div>)}</div>
      <div className="detail-grid"><div className="card"><div className="card-head"><div className="card-title">Job 事件与错误</div></div><pre className="json-view">{JSON.stringify(detail.jobs, null, 2)}</pre></div><div className="card"><div className="card-head"><div className="card-title">产物与复核</div></div><pre className="json-view">{JSON.stringify({ artifacts: detail.artifacts, reviews: detail.reviews }, null, 2)}</pre></div></div>
    </>}

    {isV2 && <div className="detail-cols">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <div className="card-head"><div className="card-title">Batch 处理矩阵</div><span className="card-hint">
            {captureOut ? `${captureOut.itemCount ?? "?"} 商品 · ${batchRows.length} 批` : captureJob ? `抓取${labels[captureJob.state] ?? captureJob.state} · 已发布 ${batchRows.length} 批` : ""}
          </span></div>
          <div style={{ overflowX: "auto" }}>
            <table className="matrix">
              <thead><tr><th style={{ width: "24%" }}>批次</th><th>抓取</th><th>文字·语义</th><th>图片·OCR</th><th>整合</th><th>Unify</th></tr></thead>
              <tbody>
                {batchRows.length === 0 && <tr><td colSpan={6}><div className="empty" style={{ minHeight: 80 }}>抓取线还没有发布 Batch</div></td></tr>}
                {batchRows.map((row) => <tr key={row.batchId}>
                  <td><div className="bid">{row.batchId}</div><div className="bmeta num">{row.itemCount ?? "?"} 商品{row.exit ? ` · 出口 ${row.exit}` : ""}</div></td>
                  <td><span className="tag good">已发布</span></td>
                  {["process_text", "process_images", "product_join", "product_unify"].map((stage) => <td key={stage}>
                    {row.jobs[stage] ? <StateTag state={row.jobs[stage].state} live/> : stage === "process_images" ? <span className="tag idle">免</span> : <span className="cell-na">—</span>}
                  </td>)}
                </tr>)}
              </tbody>
            </table>
          </div>
          {trail.length > 0 && <div className="trail">
            <span className="trail-label">出口轮动</span>
            {trail.map((hop, index) => <React.Fragment key={index}>{index > 0 && <span className="hop-arrow">→</span>}<span className="hop"><span className={`hop-exit${index === trail.length - 1 ? " cur" : ""}`}>{hop.exit}</span><span className="hop-n">×{hop.count} 批</span></span></React.Fragment>)}
          </div>}
        </div>

        <div className="card">
          <div className="card-head"><div className="card-title">目录收尾（run 级，一次入库）</div><span className="card-hint">下架判定只在这里发生一次</span></div>
          <div>
            <div className="tail-step">
              <div className="tail-rail"><span className={`tail-dot ${tailDot(finalizeJob)}`}/><span className="tail-line"/></div>
              <div><div className="tail-name">Catalog Finalize {finalizeOut?.scope && <span className="tag idle" style={{ marginLeft: 6 }}>scope = {finalizeOut.scope}</span>}</div>
                <div className="tail-desc">{finalizeOut ? `${finalizeOut.includedCount ?? 0} 入库候选 · ${finalizeOut.excludedCount ?? 0} 语义排除 · ${finalizeOut.quarantinedCount ?? 0} 隔离 · Facts ${finalizeOut.factsCount ?? 0}` : finalizeJob ? `${labels[finalizeJob.state] ?? finalizeJob.state}（等待全部 Batch 的 Unify 完成）` : "等待目录遍历结束"}</div>
                {Array.isArray(finalizeOut?.reasons) && finalizeOut.reasons.length > 0 && <div className="reason-chips">{finalizeOut.reasons.map((reason: string) => <span key={reason}>{reason}</span>)}</div>}
              </div>
            </div>
            <div className="tail-step">
              <div className="tail-rail"><span className={`tail-dot ${tailDot(ingestJob)}`}/><span className="tail-line"/></div>
              <div><div className="tail-name">Product Staging 入库 {ingestJob?.state === "needs_review" && <span className="tag warn" style={{ marginLeft: 6 }}>待复核</span>}</div>
                <div className="tail-desc">{ingestOut?.summary ?? (ingestJob?.error_message ? `${ingestJob.error_message}` : ingestJob ? labels[ingestJob.state] ?? ingestJob.state : "等待 Catalog Finalize")}</div>
              </div>
            </div>
            <div className="tail-step">
              <div className="tail-rail"><span className={`tail-dot ${tailDot(cleanupJob)}`}/></div>
              <div><div className="tail-name" style={cleanupJob?.state !== "completed" ? { color: "#79847e" } : undefined}>按 run 清理</div>
                <div className="tail-desc">{cleanupJob?.state === "completed" ? `本地运行文件已清理${cleanupJob.output?.preserved ? ` · ${cleanupJob.output.preserved} 个隔离产品证据已转存` : ""}` : "等待入库完成。原始证据在复核解决前不会清理。"}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="card">
          <div className="card-head"><div className="card-title">运行概要</div></div>
          <dl className="kv">
            <dt>渠道</dt><dd>{channelName(detail.run.adapter, detail.run.sourceType)}</dd>
            {captureOut?.discoveredCount != null && <><dt>发现商品</dt><dd className="num">{captureOut.discoveredCount}</dd></>}
            <dt>已抓取</dt><dd className="num">{captureOut?.itemCount ?? detail.run.itemCount} · {batchRows.length} 批</dd>
            {finalizeOut?.factsCount != null && <><dt>Facts</dt><dd className="num">{finalizeOut.factsCount} 份</dd></>}
            {ingestOut?.ingestedCount != null && <><dt>已入库回读</dt><dd className="num">{ingestOut.ingestedCount} 商品</dd></>}
            {ingestOut?.readbackHash && <><dt>回读哈希</dt><dd><code>{String(ingestOut.readbackHash).slice(0, 8)}…{String(ingestOut.readbackHash).slice(-6)}</code></dd></>}
            <dt>创建时间</dt><dd className="num">{new Date(detail.run.createdAt).toLocaleString("zh-CN")}</dd>
          </dl>
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">待复核</div>{openReviews.length > 0 ? <span className="tag warn">{openReviews.length} 项</span> : <span className="tag good">无</span>}</div>
          {openReviews.map((row: any) => <div className="review-row" key={row.id}>
            <div className="review-main">
              <div className="review-title"><code>{row.reason_code}</code></div>
              <div className="review-desc" style={{ whiteSpace: "normal" }}>{row.reason_message}</div>
            </div>
          </div>)}
          {openReviews.length > 0 && <div style={{ display: "flex", gap: 8, padding: "0 16px 14px" }}>
            <Button size="small" onClick={() => Modal.confirm({ title: "重试这个 Job？", onOk: () => resolve.mutateAsync({ id: openReviews[0].id, action: "retry", resolution: "由运行详情页重试" }) })}>重试</Button>
            <Button size="small" danger onClick={() => Modal.confirm({ title: "终止这个任务？", okType: "danger", onOk: () => resolve.mutateAsync({ id: openReviews[0].id, action: "abandon", resolution: "由运行详情页终止" }) })}>终止 run</Button>
          </div>}
          {openReviews.length === 0 && <div className="review-row" style={{ justifyContent: "center", color: "#a9b1ac", fontSize: 11.5 }}>没有待复核项</div>}
        </div>
        <div className="card">
          <div className="card-head"><div className="card-title">事件流</div><span className="card-hint">最近 6 条</span></div>
          <dl className="kv" style={{ fontSize: 11.5 }}>
            {(detail.events ?? []).slice(0, 6).map((event: any) => <React.Fragment key={event.id}>
              <dt className="num">{fmtTime(event.created_at)}</dt><dd>{event.event_type}{event.payload?.batchId ? ` · ${event.payload.batchId}` : ""}</dd>
            </React.Fragment>)}
          </dl>
        </div>
      </div>
    </div>}
  </>;
}

/* ── 其余页面（保留原实现） ──────────────────────────────────── */
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
