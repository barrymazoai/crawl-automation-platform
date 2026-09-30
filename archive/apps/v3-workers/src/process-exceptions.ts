import { createHash } from "node:crypto";
import { Context } from "@temporalio/activity";

type Query = { query(sql: string, params?: unknown[]): Promise<unknown> };
export type ProcessException = {
  kind: "activity" | "product"; service: string; workflowType?: string | null | undefined; workflowId?: string | null | undefined; runId?: string | null | undefined;
  activity?: string | null | undefined; attempt?: number | null | undefined; requestId?: string | null | undefined; listingId?: string | null | undefined;
  code: string; errorName?: string | null | undefined; message: string; outcome: string; detail?: Record<string, unknown> | undefined;
};

/** Walks an error and its causes for the most specific machine code and a readable message. */
export function describeError(error: unknown) {
  let code: string | null = null, name: string | null = null, message = "";
  let current: unknown = error;
  for (let n = 0; n < 8 && current && typeof current === "object"; n++) {
    const e = current as { type?: unknown; code?: unknown; name?: unknown; message?: unknown; cause?: unknown; applicationFailureInfo?: { type?: unknown } };
    for (const c of [e.type, e.applicationFailureInfo?.type, e.code, e.message]) if (!code && typeof c === "string" && /^[A-Z][A-Z0-9]*\.[A-Z0-9_]+$/.test(c)) code = c;
    if (!name && typeof e.name === "string") name = e.name;
    if (typeof e.message === "string" && e.message && !message.includes(e.message)) message = message ? `${message} <- ${e.message}` : e.message;
    current = e.cause;
  }
  if (!message) message = String(error);
  return { code: code ?? "PROCESS.UNEXPECTED_ERROR", name, message: message.slice(0, 2000) };
}

/** Finds the product a step was working on from the common input shapes. */
export function listingOf(raw: unknown): { listingId: string | null; requestId: string | null } {
  const r = raw as any;
  for (const d of [r?.discovery, r?.job?.discovery, r?.captured?.job?.discovery, r?.staged?.capture?.job?.discovery, r]) {
    if (typeof d?.entry?.listingId === "string") return { listingId: d.entry.listingId, requestId: typeof d.catalogId === "string" ? d.catalogId : null };
  }
  for (const o of [r?.owner, r?.sourcePlan?.owner, r?.input?.sourcePlan?.owner, r?.input?.input?.sourcePlan?.owner, r?.manifest?.observation, r?.observation])
    if (typeof o?.listingId === "string") return { listingId: o.listingId, requestId: typeof o.requestId === "string" ? o.requestId : null };
  return { listingId: null, requestId: null };
}

/** Never throws and never waits on the product: logs every exception, stores it when a database is available. */
export function recordException(db: Query | undefined, e: ProcessException): void {
  console.error(JSON.stringify({ event: "PROCESS_EXCEPTION", ...e }));
  if (!db) return;
  const key = [e.kind, e.service, e.workflowId ?? "", e.runId ?? "", e.activity ?? "", e.attempt ?? "", e.outcome, e.code].join("|");
  const id = createHash("sha256").update(key).digest("hex");
  void Promise.resolve().then(() => db.query(
    `INSERT INTO process_exception(exception_id,kind,service,workflow_type,workflow_id,run_id,activity,attempt,request_id,listing_id,code,error_name,message,outcome,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb) ON CONFLICT (exception_id) DO NOTHING`,
    [id, e.kind, e.service, e.workflowType ?? null, e.workflowId ?? null, e.runId ?? null, e.activity ?? null, e.attempt ?? null, e.requestId ?? null,
      e.listingId ?? null, e.code, e.errorName ?? null, e.message, e.outcome, JSON.stringify(e.detail ?? {})]))
    .catch(err => console.error(JSON.stringify({ event: "PROCESS_EXCEPTION_NOT_STORED", message: String((err as Error)?.message).slice(0, 200) })));
}

/** Wraps every activity so any exception it throws is recorded with its workflow, step, attempt and product. The
 * activity's behaviour is unchanged: the original error is rethrown. Cancellations are not exceptions. */
export function withExceptionRecord<T extends Record<string, (...args: any[]) => Promise<unknown>>>(db: Query | undefined, service: string, activities: T): T {
  return Object.fromEntries(Object.entries(activities).map(([name, fn]) => [name, async (...args: unknown[]) => {
    try { return await fn(...args); }
    catch (error) {
      let info: ReturnType<typeof Context.current>["info"] | undefined;
      try { info = Context.current().info; } catch { info = undefined; }
      let cancelled = false;
      try { cancelled = Context.current().cancellationSignal.aborted; } catch { /* outside an activity */ }
      if (!cancelled) {
        const d = describeError(error), p = listingOf(args[0]);
        recordException(db, { kind: "activity", service, workflowType: info?.workflowType ?? null, workflowId: info?.workflowExecution?.workflowId ?? null,
          runId: info?.workflowExecution?.runId ?? null, activity: name, attempt: info?.attempt ?? null, requestId: p.requestId, listingId: p.listingId,
          code: d.code, errorName: d.name, message: d.message, outcome: "step-failed", detail: { taskQueue: info?.taskQueue ?? null } });
      }
      throw error;
    }
  }])) as T;
}
