import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { createR2Objects, sha256 } from "@crawl-automation/v3-artifacts";
import { ExecutionIdSchema, ObjectKeySchema, Sha256Schema } from "@crawl-automation/v3-contracts";
import { readGncPrivateJson } from "./gnc-config.js";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), path = z.string().refine(isAbsolute);
const safeUrl = z.url().refine(s => { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash; });
export const DependencyProbeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ id, kind: z.literal("ocr-health"), url: safeUrl, minHealthyBackends: z.number().int().min(1).max(64) }),
  // An existing immutable canary, not a periodic write or an unverified HTTP 200.
  z.strictObject({ id, kind: z.literal("r2-read"), configPath: path, objectKey: ObjectKeySchema,
    sha256: Sha256Schema, byteSize: z.number().int().min(1).max(1048576) }),
  z.strictObject({ id, kind: z.literal("handoff-backlog"), roots: z.array(z.strictObject({ root: path,
    layout: z.enum(["ocr", "text", "vision"]) })).min(1).max(8),
    maxPending: z.number().int().min(1).max(10000), maxOldestSeconds: z.number().int().min(30).max(604800),
    maxFiles: z.number().int().min(1).max(100000).default(10000) }),
]);
export type DependencyProbe = z.infer<typeof DependencyProbeSchema>;
export type ProbeState = { id: string; healthy: boolean; checkedAt: string; expiresAt: string; reason: string;
  pending?: number; reviewed?: number; oldestSeconds?: number; healthyBackends?: number };
type Db = { query(sql: string, args?: unknown[]): Promise<{ rows: Record<string, any>[] }> };
type Pending = { operationId: string; modifiedAt: number };
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** Bounded, read-only enumeration of this node's immutable handoff markers.
 * No source images, model response contents, cookies or credentials are read.
 * A marker is a backlog hint, NEVER a completion proof or permission to re-execute.
 */
export async function handoffMarkers(probe: Extract<DependencyProbe, { kind: "handoff-backlog" }>, signal: AbortSignal): Promise<Pending[]> {
  const found = new Map<string, number>(); let visited = 0;
  async function entries(dir: string, optional = false) {
    signal.throwIfAborted();
    try {
      const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink()) throw Error("PROBE.DIRECTORY_INVALID");
      const out = [];
      for await (const e of await opendir(dir)) { signal.throwIfAborted(); if (++visited > probe.maxFiles) throw Error("PROBE.SCAN_LIMIT"); out.push(e); }
      return out;
    } catch (e) { if (optional && missing(e)) return []; throw e; }
  }
  async function marker(file: string, operationId: string) {
    ExecutionIdSchema.parse(operationId);
    const f = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await f.stat(); if (!s.isFile() || s.size > 2097152 || s.mtimeMs > Date.now() + 1000) throw Error("PROBE.MARKER_INVALID");
      found.set(operationId, Math.min(found.get(operationId) ?? Infinity, s.mtimeMs));
    } finally { await f.close(); }
  }
  for (const r of probe.roots) {
    // The configured private store itself must exist; only optional module subdirectories may be absent.
    const top = await entries(r.root);
    if (r.layout === "ocr") {
      for (const e of top) if (!e.name.startsWith(".") && e.name.endsWith(".json")) await marker(join(r.root, e.name), e.name.slice(0, -5));
    } else if (r.layout === "text") {
      for (const sub of ["text-responses", "text-completions"]) for (const e of await entries(join(r.root, sub), true))
        if (!e.name.startsWith(".") && e.name.endsWith(".json")) await marker(join(r.root, sub, e.name), e.name.slice(0, -5));
    } else {
      // Check every parent: a symlinked v3 directory must not escape the configured store.
      await entries(join(r.root, "v3"), true);
      for (const e of await entries(join(r.root, "v3/vision"), true)) {
        ExecutionIdSchema.parse(e.name);
        const dir = join(r.root, "v3/vision", e.name);
        for (const f of await entries(dir)) if (["response.json", "registration.json", "completion.json"].includes(f.name)) await marker(join(dir, f.name), e.name);
      }
    }
  }
  return [...found].map(([operationId, modifiedAt]) => ({ operationId, modifiedAt }));
}

// Registration and review rows are permanent (the ledger never deletes them), so an operation once settled stays
// settled. Remembering settled ids keeps each tick proportional to NEW handoffs. Without it the tick grows with every
// product ever processed and eventually overruns the monitor's per-probe deadline, which closes every dependent
// resource (2026-09-17: 22k OCR markers took 4.7s of a 5s deadline). Progress is kept per batch, so an aborted tick
// still shortens the next one.
const settledCache = new Map<string, { settled: Set<string>; reviewed: Set<string> }>();
export async function readHandoffBacklog(probe: Extract<DependencyProbe, { kind: "handoff-backlog" }>, db: Db, signal: AbortSignal) {
  const key = JSON.stringify([probe.id, probe.roots]);
  const cache = settledCache.get(key) ?? { settled: new Set<string>(), reviewed: new Set<string>() }; settledCache.set(key, cache);
  const { settled, reviewed } = cache;
  const markers = await handoffMarkers(probe, signal);
  const unknown = markers.filter(m => !settled.has(m.operationId) && !reviewed.has(m.operationId)).map(m => m.operationId);
  for (let i = 0; i < unknown.length; i += 500) {
    signal.throwIfAborted(); const ids = unknown.slice(i, i + 500);
    for (const r of (await db.query("SELECT operation_id FROM processing_result WHERE operation_id=ANY($1::text[])", [ids])).rows) settled.add(r.operation_id);
    for (const r of (await db.query("SELECT record->'failure'->>'operationId' AS operation_id FROM review_record WHERE record->'failure'->>'operationId'=ANY($1::text[])", [ids])).rows) reviewed.add(r.operation_id);
  }
  const pending = markers.filter(m => !settled.has(m.operationId) && !reviewed.has(m.operationId));
  const oldestSeconds = pending.length ? Math.max(0, Math.floor((Date.now() - Math.min(...pending.map(x => x.modifiedAt))) / 1000)) : 0;
  return { healthy: pending.length < probe.maxPending && oldestSeconds < probe.maxOldestSeconds,
    pending: pending.length, reviewed: markers.filter(m => reviewed.has(m.operationId)).length, oldestSeconds };
}

async function boundedJson(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw Error("PROBE.HTTP_UNHEALTHY"); }
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try { for (;;) { signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > 8192) throw Error("PROBE.RESPONSE_LIMIT"); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => {}); }
}
export async function runDependencyProbe(probe: DependencyProbe, db: Db, signal: AbortSignal): Promise<Omit<ProbeState, "id" | "checkedAt" | "expiresAt">> {
  if (probe.kind === "handoff-backlog") {
    const result = await readHandoffBacklog(probe, db, signal); return { ...result, reason: result.healthy ? "ready" : "handoff_backlog" };
  }
  if (probe.kind === "ocr-health") {
    const body = await boundedJson(await fetch(probe.url, { redirect: "error", signal }), signal);
    const schema = z.object({ status: z.literal("ok"), healthy_backends: z.number().int().nonnegative(), total_backends: z.number().int().positive() });
    const h = schema.parse(body); const healthy = h.healthy_backends >= probe.minHealthyBackends && h.healthy_backends <= h.total_backends;
    return { healthy, healthyBackends: h.healthy_backends, reason: healthy ? "ready" : "ocr_backends_unhealthy" };
  }
  const c = await readGncPrivateJson(probe.configPath) as any, r2 = createR2Objects(c.r2, c.r2Credentials);
  try {
    const bytes = await r2.store.read(probe.objectKey, probe.byteSize, signal);
    const healthy = !!bytes && bytes.length === probe.byteSize && sha256(bytes) === probe.sha256;
    return { healthy, reason: healthy ? "ready" : "r2_canary_mismatch" };
  } finally { r2.close(); }
}

/** Independent per-probe deadlines. A hung dependency cannot hold unrelated resources healthy forever. */
export class DependencyMonitor {
  private readonly states = new Map<string, ProbeState>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly executing = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly next = new Map<string, number>();
  private stopped = false;
  constructor(private readonly probes: DependencyProbe[], private readonly run: typeof runDependencyProbe, private readonly db: Db,
    private readonly intervalMs = 30000, private readonly timeoutMs = 5000) {}
  tick(now = Date.now()) {
    if (this.stopped) return;
    for (const p of this.probes) if (!this.running.has(p.id) && !this.executing.has(p.id) && (this.next.get(p.id) ?? 0) <= now) {
      const controller = new AbortController(); this.controllers.set(p.id, controller);
      this.executing.add(p.id);
      // Expire the previous success when a new observation is due, even if an adapter ignores cancellation.
      const task = (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error("PROBE.TIMEOUT")); }, this.timeoutMs); });
          const execution = Promise.resolve().then(() => this.run(p, this.db, controller.signal)).finally(() => { this.executing.delete(p.id); });
          const result = await Promise.race([execution, timeout]);
          if (!this.stopped) this.states.set(p.id, { ...result, id: p.id, checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.intervalMs + this.timeoutMs + 5000).toISOString() });
        } catch {
          if (!this.stopped) this.states.set(p.id, { id: p.id, healthy: false, reason: "dependency_unavailable", checkedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.intervalMs).toISOString() });
        } finally { clearTimeout(timer); this.next.set(p.id, Date.now() + this.intervalMs); this.controllers.delete(p.id); }
      })().finally(() => { this.running.delete(p.id); });
      this.running.set(p.id, task);
    }
  }
  snapshot(now = Date.now()): ProbeState[] { return this.probes.map(p => {
    const s = this.states.get(p.id);
    return s && Date.parse(s.checkedAt) <= now && Date.parse(s.expiresAt) > now ? s : { id: p.id, healthy: false, reason: "dependency_stale", checkedAt: s?.checkedAt ?? new Date(0).toISOString(), expiresAt: s?.expiresAt ?? new Date(0).toISOString() };
  }); }
  async close() { this.stopped = true; for (const c of this.controllers.values()) c.abort(); await Promise.all(this.running.values()); }
}
