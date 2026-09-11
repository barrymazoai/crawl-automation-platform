import { useEffect, useRef, useState } from "react";
import { Button } from "@heroui/react";
import { CollectionCapabilities, CollectionSubmission, Id, temporalExecutionUrl, type Source } from "@crawl-automation/v3-contracts";
import { Note, Panel } from "../ui";
import { ApiFailure, request } from "./api";
import { archiveCollection, deliveryLabel, prepareCollection, readCollection, readCollectionState, sendCollection, type CollectionIntent, type CollectionState } from "./collection";

export function CollectionPanel({ source, configurationBlocked }: { source: Source | null; configurationBlocked: boolean }) {
  const [intent, setIntent] = useState<CollectionIntent | null>(null);
  const [viewIntent, setViewIntent] = useState<CollectionIntent | null>(null);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [capabilities, setCapabilities] = useState<CollectionCapabilities | null>(null);
  const [state, setState] = useState<CollectionState | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [rejected, setRejected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const saved = readCollection(sessionStorage);
        if (live) setIntent(saved);
        const id = new URL(window.location.href).searchParams.get("request");
        if (!saved && id) {
          const receipt = await request(`/submissions/${Id.parse(id)}`, CollectionSubmission);
          if (receipt.requestId !== id) throw Error("请求链接与回执不匹配");
          if (live) setViewIntent({ key: receipt.requestId, sourceId: receipt.snapshot.sourceId, brandId: receipt.snapshot.brandId,
            input: { sourceRevision: receipt.snapshot.sourceRevision }, label: `${receipt.snapshot.brandName} · ${receipt.snapshot.channel} · ${receipt.snapshot.url}` });
        }
        if (live) setReady(true);
      } catch { if (live) setStorageError("无法读取保留的凭证或链接中的请求，写操作已暂停。请保留浏览器存储并人工核验。"); }
    })();
    return () => { live = false; };
  }, []);
  // A retained request takes precedence over changing the Brand/source selection.
  const tracked = intent ?? viewIntent;
  const brandId = tracked?.brandId ?? source?.brandId;
  const sourceId = tracked?.sourceId ?? source?.id;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let running = false;
    const read = async () => {
      if (running || lock.current) return;
      running = true;
      setReading(true);
      try {
        const cap = await request("/collection-capabilities", CollectionCapabilities);
        const next = brandId && sourceId ? await readCollectionState({ brandId, id: sourceId }, tracked) : null;
        if (live) { setCapabilities(cap); setState(next); setError(""); }
      } catch (e) {
        if (live) { setState(null); setCapabilities(null); setError(e instanceof Error ? e.message : "状态读取失败"); }
      } finally { running = false; if (live) setReading(false); }
    };
    setState(null);
    void read();
    const timer = window.setInterval(() => { if (!document.hidden) void read(); }, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [ready, brandId, sourceId, tracked, refresh]);
  const execute = async (frozen: CollectionIntent) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setNotice(""); setRejected(false);
    try {
      await sendCollection(frozen);
      const url = new URL(window.location.href); url.searchParams.set("request", frozen.key);
      window.history.replaceState(null, "", url);
      setNotice("202 · 请求已入库，等待交接。不是运行成功，也不是产品入库成功。");
    } catch (e) {
      setNotice(`${e instanceof Error ? e.message : "请求异常"} 原 key 和原始版本均已保留。`);
      setRejected(e instanceof ApiFailure && !e.uncertain && ["REVISION_CONFLICT", "SOURCE_DISABLED", "SOURCE_BUSY", "SOURCE_NOT_FOUND", "INVALID_INPUT"].includes(e.code));
    } finally { lock.current = false; setBusy(false); setRefresh(n => n + 1); }
  };
  const create = () => {
    if (!source || intent || lock.current || !canCreate) return;
    try {
      const frozen = prepareCollection(sessionStorage, source);
      setIntent(frozen); setState(null); void execute(frozen);
    } catch { setStorageError("无法保存采集请求凭证，本次未发送。请检查浏览器存储。"); }
  };
  const archive = () => {
    if (!intent || busy || !canArchive) return;
    try {
      archiveCollection(sessionStorage, intent); setIntent(null); setState(null); setRejected(false);
      const url = new URL(window.location.href); url.searchParams.delete("request"); window.history.replaceState(null, "", url);
      setNotice("原编号已归档到本标签页会话存储。没有取消流程，也没有清除服务端占用。");
    } catch { setStorageError("归档失败，保留原请求，不开放新提交。"); }
  };
  const canCreate = ready && !!source?.enabled && !tracked && !configurationBlocked && !busy && !reading && !storageError && !error && !!capabilities?.submissionIntakeEnabled && !!state && !state.active;
  const canArchive = !busy && !reading && !storageError && !!state && (state.delivery?.state === "CLOSED" || (rejected && !state.submission));
  const url = capabilities && state?.submission ? temporalExecutionUrl(capabilities, state.submission, state.delivery) : null;
  return <section id="collection" className="scroll-mt-6">
    <Panel title="手动提交与交接" subtitle="选择来源 → 持久化请求 → Temporal 交接；每 5 秒只读刷新，不自动重发">
      <div className="space-y-4 p-5 text-xs leading-6">
        <Note warning={capabilities?.environment !== "local-v3"}>
          {capabilities?.environment === "isolated-live" ? "真实采集验收：使用独立 V3 测试库与隔离 Temporal namespace。提交会访问已授权网站，并调用 OCR/Codex；不是 Probe。" : capabilities?.environment === "isolated-acceptance" ? "隔离验收环境：合成 Brand / 来源 + 真实本地 PostgreSQL / Temporal。只运行 Probe，不抓网站，不调用 OCR/Codex。" : "本地 V3 环境。只有部署端明确开放提交入口后才能发任务；启用来源不会自动运行。"}
        </Note>
        {!capabilities?.submissionIntakeEnabled && <p>提交入口未开放或尚未确认，不能发送新任务。</p>}
        <p className="break-all">当前目标：{tracked?.label ?? (source ? `${source.channel} · ${source.url}` : "请在来源列表点击「选择采集」")}</p>
        {tracked && <div className="rounded-xl border border-border p-3 break-all">
          <p>{intent ? "保留" : "只读查看"}请求编号（Idempotency-Key）：<code>{tracked.key}</code></p>
          <p>来源：{tracked.sourceId} · 冻结版本 v{tracked.input.sourceRevision}</p>
          <p>{intent ? "切换品牌不会改变这次请求；刷新也不会自动 POST。凭证只保留在本标签页会话中，请勿清空存储。" : "通过请求链接回读数据库；此模式不会重发该请求。"}</p>
        </div>}
        {storageError && <div role="alert"><Note warning>{storageError}</Note></div>}
        {error && <div role="alert"><Note warning>状态未能核验：{error} 旧状态不作为新提交依据。</Note></div>}
        {notice && <p role="status" className="break-words">{notice}</p>}
        {state && <div className="space-y-2 rounded-xl bg-[#f0f4ea] p-4 break-all" aria-label="真实交接状态">
          <p className="font-semibold">{deliveryLabel(state.submission, state.delivery)}</p>
          <p>来源占用：{state.active ? `已占用 · ${state.active.requestId}` : "当前未占用（以服务端提交时检查为准）"}</p>
          {state.active && state.active.requestId !== state.submission?.requestId && <p>来源由另一条请求占用；不会用它的回执冒充本次结果。</p>}
          {state.submission && <><p>Workflow ID：{state.submission.workflowId}</p><p>入口回执：PENDING_DELIVERY（不可变的受理记录，不是实时执行状态）</p></>}
          {state.delivery && <><p>Run ID：{state.delivery.runId ?? "尚未确认"}</p><p>交接核验时间：{state.delivery.checkedAt ?? "尚未核验"}</p><p>集群 / 队列：{state.delivery.target.clusterId} / {state.delivery.target.taskQueue}</p></>}
          <p>页面回读：{state.readAt}{reading ? " · 正在更新" : ""}</p>
          {url ? <a className="font-semibold text-accent underline" href={url} target="_blank" rel="noopener noreferrer">打开此 Run 的 Temporal UI ↗</a> : state.submission && <p>暂无可验证的 Temporal 跳转；不会猜测集群或 Run。</p>}
          {state.submission && <p><a className="text-accent underline" href={`?brand=${state.submission.snapshot.brandId}&request=${state.submission.requestId}#collection`} target="_blank" rel="noopener noreferrer">打开此请求的只读链接 ↗</a></p>}
        </div>}
        <div className="flex flex-wrap gap-2">
          <Button isDisabled={!canCreate} onPress={create}>提交一次采集</Button>
          <Button variant="outline" isDisabled={busy || reading || !ready} onPress={() => setRefresh(n => n + 1)}>刷新交接状态</Button>
          {intent && !state?.submission && <Button variant="outline" isDisabled={busy || reading || !!storageError || !capabilities?.submissionIntakeEnabled} onPress={() => void execute(intent)}>用原 key 确认提交</Button>}
          {intent && <Button variant="ghost" isDisabled={!canArchive} onPress={archive}>归档此请求，重新选择</Button>}
          {viewIntent && !intent && <Button variant="ghost" onPress={() => {
            setViewIntent(null); setState(null);
            const next = new URL(window.location.href); next.searchParams.delete("request"); window.history.replaceState(null, "", next);
          }}>退出只读查看</Button>}
        </div>
        <p className="text-muted">待核验不会自动重跑，也不会自动释放占用。只有确认拒绝或终态收口后才能归档；流程结束不等于业务数据验收通过。</p>
      </div>
    </Panel>
  </section>;
}
