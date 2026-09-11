import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip } from "@heroui/react";
import { RefreshCw, ArrowUpRight } from "lucide-react";
import { DashboardSummarySchema, DashboardProductsSchema, DashboardReviewsSchema, PublicReviewSchema, type DashboardSummary } from "@crawl-automation/v3-contracts";
import { request } from "./api";
import { PageHead, Panel, Note } from "../ui";
type Products = ReturnType<typeof DashboardProductsSchema.parse>;
type Reviews = ReturnType<typeof DashboardReviewsSchema.parse>;
type Review = ReturnType<typeof PublicReviewSchema.parse>;
export function Dashboard({ reviewsOnly = false }: { reviewsOnly?: boolean }) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null), [products, setProducts] = useState<Products | null>(null);
  const [reviews, setReviews] = useState<Reviews | null>(null), [detail, setDetail] = useState<Review | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [before, setBefore] = useState<string | null>(null);
  const [code, setCode] = useState(""); const sequence = useRef(0);
  const reviewId = new URL(window.location.href).searchParams.get("review");
  const reload = useCallback(async () => {
    const seq = ++sequence.current; setBusy(true); setError("");
    try {
      const suffix = new URLSearchParams({ limit: "25", ...(before ? { before } : {}), ...(code ? { code } : {}) });
      const [s, p, r, d] = await Promise.all([
        request("/dashboard", DashboardSummarySchema),
        request(`/dashboard/products${!reviewsOnly && before ? `?before=${encodeURIComponent(before)}` : ""}`, DashboardProductsSchema),
        request(`/reviews?${reviewsOnly ? suffix : "limit=5"}`, DashboardReviewsSchema),
        reviewId ? request(`/reviews/${encodeURIComponent(reviewId)}`, PublicReviewSchema) : Promise.resolve(null),
      ]);
      if (seq === sequence.current) { setSummary(s); setProducts(p); setReviews(r); setDetail(d); }
    } catch (e) { if (seq === sequence.current) setError(e instanceof Error ? e.message : "读取失败"); }
    finally { if (seq === sequence.current) setBusy(false); }
  }, [before, code, reviewId, reviewsOnly]);
  useEffect(() => { void reload(); const timer = setInterval(() => void reload(), 30000); return () => { clearInterval(timer); sequence.current++; }; }, [reload]);
  return <div className="min-h-screen bg-background p-4 sm:p-8"><main className="mx-auto max-w-[1400px] space-y-6">
    <nav className="flex flex-wrap gap-5 text-sm" aria-label="主要导航">
      <a href="/v3-live.html?view=dashboard" aria-current={!reviewsOnly ? "page" : undefined}>业务概览</a>
      <a href="/v3-live.html">Brand 管理</a>
      <a href="/v3-live.html?view=reviews" aria-current={reviewsOnly ? "page" : undefined}>只读 Review</a>
      <Chip size="sm" variant="soft">独立 V3 数据库</Chip>
    </nav>
    <PageHead eyebrow="BUSINESS EVIDENCE" title={reviewsOnly ? "只读 Review" : "采集业务概览"}
      description="业务库事实 · Workflow Completed 不等于产品入库 · 每 30 秒刷新"
      actions={<Button variant="outline" onPress={() => void reload()} isDisabled={busy}><RefreshCw size={14}/>刷新</Button>}/>
    {document.querySelector<HTMLMetaElement>('meta[name="v3-dataset"]')?.content && <Note>{document.querySelector<HTMLMetaElement>('meta[name="v3-dataset"]')!.content}</Note>}
    {error && <div role="alert" className="rounded-xl border border-danger p-4 text-sm">{error}。以下如有数据，仅为上次成功快照，不代表当前状态。</div>}
    {!summary && !error && <p role="status">正在读取真实业务数据…</p>}
    {summary && <>
      <p className="text-xs text-muted">数据时间：{new Date(summary.asOf).toLocaleString()} · 统计来源：业务数据库</p>
      {!reviewsOnly && <>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{[
          ["已发现", summary.discoveries, "目录去重挂牌/变体"],
          ["已有处理结果", summary.processedObservations, `${summary.processingResults} 条模块结果，非完成产品`],
          ["采集已保存", summary.collectedObservations, `${summary.collectedProducts} 条保存记录`],
          ["正式产品库", "未接入", "不把采集保存冒充正式写入"],
          ["业务 Review", summary.reviews, `${summary.reviewObservations} 个关联观察`],
          ["待发布产品", summary.pendingDispatches, "已发现、尚无子流程启动回执"],
        ].map(([label, value, caption]) => <div key={label} className="rounded-2xl border border-border bg-surface p-4"><p className="text-xs text-muted">{label}</p><p className="my-3 text-3xl font-semibold">{value}</p><p className="text-[11px] text-muted">{caption}</p></div>)}</div>
        <div className="grid gap-4 md:grid-cols-2">
          <Panel title="目录与交接"><div className="space-y-2 p-4 text-sm"><p>目录：开放 {summary.catalogs.open} · 完整 {summary.catalogs.complete} · 不完整 {summary.catalogs.incomplete}</p><p>已发布产品：{summary.dispatchedProducts}</p><p>入口交接等待：{summary.handoff.waiting} · 交接未知：{summary.handoff.unknown}</p><Note>未完整封闭的目录，不用于确认产品消失。处理失败不影响已发现事实。</Note></div></Panel>
          <Panel title="来源汇总"><div className="p-4 text-sm">{summary.sources.length ? summary.sources.map(s => <p key={s.sourceId} className="flex justify-between py-2"><span>{s.sourceId}</span><span>保存 {s.collected} · Review {s.reviews}</span></p>) : <p>暂无业务记录</p>}</div></Panel>
        </div>
        <Panel title="已保存采集记录"><div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["挂牌 / 来源", "核心数据", "包装警告", "执行证据"].map(t => <th key={t} className="p-4">{t}</th>)}</tr></thead><tbody>
          {products?.items.map(p => <tr key={p.operationId} className="border-t border-border"><td className="p-4">{p.observation.listingId}<p className="text-xs text-muted">{p.observation.sourceId}</p></td><td className="p-4">Formula {p.formulaRows} 行 · Other Ingredients {p.otherIngredients} 项</td><td className="max-w-[300px] break-words p-4 text-xs">{p.warningCodes.join(" / ") || "无"}</td><td className="p-4">{p.temporalUrl ? <a href={p.temporalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">Temporal 历史 <ArrowUpRight size={14}/></a> : <span className="text-muted">尚未登记执行链接</span>}</td></tr>)}
        </tbody></table>{!products?.items.length && <p className="p-4 text-sm text-muted">尚无采集保存记录；流程完成不代表入库。</p>}</div></Panel>
      </>}
      <Panel title="错误分类（最多 200 类）"><div className="flex flex-wrap gap-2 p-4">{summary.errors.length ? summary.errors.map(e => <Chip key={`${e.category}/${e.code}`} size="sm" variant="soft" color="warning">{e.code} · {e.count}</Chip>) : <p className="text-sm text-muted">没有业务 Review</p>}</div></Panel>
    </>}
    <Panel title="Review 记录 · 不自动重跑"><div className="space-y-3 p-4">
      {reviewsOnly && <label className="block text-sm">错误码过滤 <input value={code} onChange={e => { setCode(e.target.value); setBefore(null); }} className="ml-2 rounded-lg border border-border p-2" placeholder="例如 SOURCE.NETWORK_UNAVAILABLE"/></label>}
      {reviews?.items.map(r => <a key={r.reviewId} className="block rounded-lg border border-border p-3 text-sm" href={`/v3-live.html?view=reviews&review=${encodeURIComponent(r.reviewId)}`}><span className="font-semibold">{r.failure.code}</span><p className="mt-1 text-xs text-muted">{r.observation?.listingId ?? "未关联产品"} · {r.failure.stage} · {r.failure.category}</p></a>)}
      {!reviews?.items.length && <p className="text-sm text-muted">当前筛选没有 Review 记录。</p>}
      <Note>此页面只读，不提供重跑、确认执行或修改候选。原错误和候选保留在证据库，不在页面泄露原始日志。</Note>
    </div></Panel>
    {detail && <Panel title="Review 详情"><dl className="space-y-2 break-words p-4 text-sm"><dt>错误</dt><dd>{detail.failure.code} / {detail.failure.stage}</dd><dt>记录编号</dt><dd>{detail.reviewId}</dd><dt>执行事实</dt><dd>{detail.failure.executionFact}</dd><dt>证据位置</dt><dd>{detail.failure.evidenceKey ?? "未登记"}</dd><dt>原始错误 / 候选</dt><dd>错误已保留 · {detail.candidate ? "候选已保留" : "无候选"}</dd><dt>自动重试</dt><dd>关闭</dd></dl></Panel>}
    <div className="flex gap-3"><Button variant="outline" onPress={() => setBefore(null)} isDisabled={!before}>返回首批</Button><Button variant="outline" isDisabled={busy || !(reviewsOnly ? reviews?.nextCursor : products?.nextCursor)} onPress={() => setBefore((reviewsOnly ? reviews?.nextCursor : products?.nextCursor) ?? null)}>下一批记录</Button></div>
  </main></div>;
}
