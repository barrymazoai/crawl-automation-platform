import { mkdtemp, mkdir, writeFile, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { DependencyMonitor, DependencyProbeSchema, handoffMarkers, readHandoffBacklog, runDependencyProbe, type DependencyProbe } from "./dependency-probes.js";
import { DeploymentSchema } from "./deployment-supervisor.js";

const db = { query: vi.fn(async (_sql: string, _args?: unknown[]) => ({ rows: [] as any[] })) };
const probe: DependencyProbe = { id: "ocr", kind: "ocr-health", url: "http://127.0.0.1/health", minHealthyBackends: 2 };
const signal = () => AbortSignal.timeout(5000);
const backlog = async () => ({ id: "spool", kind: "handoff-backlog" as const, roots: [{ root: await mkdtemp(join(tmpdir(), "v3-backlog-")), layout: "ocr" as const }], maxPending: 2, maxOldestSeconds: 60, maxFiles: 100 });
afterEach(() => { vi.useRealTimers(); db.query.mockReset(); db.query.mockResolvedValue({ rows: [] }); });

it("rejects credential URLs, unknown config keys and unsafe limits", () => {
  for (const url of ["http://u:p@localhost/health", "http://localhost/health?token=secret", "file:///tmp/data"])
    expect(DependencyProbeSchema.safeParse({ ...probe, url }).success).toBe(false);
  expect(DependencyProbeSchema.safeParse({ ...probe, minHealthyBackends: 0 }).success).toBe(false);
  expect(DependencyProbeSchema.safeParse({ ...probe, secret: "no" }).success).toBe(false);
});
it("rejects missing dependency references and duplicate probe ids", () => {
  const c = { platform: "darwin", host: "fixture", root: "/tmp/proof", node: "/node", database: { connectionString: "test", tls: false },
    jobs: [{ id: "test", entry: "/tmp/proof/worker.js", env: {} }], resources: [{ resourceId: "test", capacity: 1, jobs: ["test"], minFreeBytes: 0, dependencies: ["ocr"] }], dependencyProbes: [probe] };
  expect(DeploymentSchema.safeParse(c).success).toBe(true);
  expect(DeploymentSchema.safeParse({ ...c, dependencyProbes: [] }).success).toBe(false);
  expect(DeploymentSchema.safeParse({ ...c, dependencyProbes: [probe, probe] }).success).toBe(false);
});
it("counts only unregistered/unreviewed local handoffs", async () => {
  const p = await backlog();
  for (const id of ["pending-one", "saved-one", "review-one"]) await writeFile(join(p.roots[0]!.root, `${id}.json`), "{}");
  db.query.mockImplementation(async sql => ({ rows: [{ operation_id: sql.includes("processing_result") ? "saved-one" : "review-one" }] }));
  expect(await readHandoffBacklog(p, db, signal())).toMatchObject({ pending: 1, reviewed: 1, healthy: true });
  expect(db.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});
it("settled and reviewed operations are remembered; later ticks query only new handoffs", async () => {
  const p = await backlog();
  for (const id of ["pending-one", "saved-one", "review-one"]) await writeFile(join(p.roots[0]!.root, `${id}.json`), "{}");
  db.query.mockImplementation(async sql => ({ rows: [{ operation_id: sql.includes("processing_result") ? "saved-one" : "review-one" }] }));
  await readHandoffBacklog(p, db, signal());
  db.query.mockClear(); db.query.mockImplementation(async () => ({ rows: [] }));
  await writeFile(join(p.roots[0]!.root, "new-one.json"), "{}");
  expect(await readHandoffBacklog({ ...p, maxPending: 3 }, db, signal())).toMatchObject({ pending: 2, reviewed: 1, healthy: true });
  const asked = db.query.mock.calls.flatMap(([, params]) => (params as string[][])[0]!);
  expect(new Set(asked)).toEqual(new Set(["pending-one", "new-one"]));
});
it("threshold blocks at equality; old unsettled evidence also blocks", async () => {
  const p = await backlog(); await writeFile(join(p.roots[0]!.root, "pending.json"), "{}");
  expect((await readHandoffBacklog({ ...p, maxPending: 1 }, db, signal())).healthy).toBe(false);
  await utimes(join(p.roots[0]!.root, "pending.json"), new Date(0), new Date(0));
  expect((await readHandoffBacklog(p, db, signal())).healthy).toBe(false);
});
it("deduplicates text response/completion; retained pending staging links are not work", async () => {
  const p = await backlog(), root = p.roots[0]!.root;
  for (const sub of ["text-responses", "text-completions"]) { await mkdir(join(root, sub)); await writeFile(join(root, sub, "op-one.json"), "{}"); await writeFile(join(root, sub, ".pending-staging"), "{}"); }
  expect(await handoffMarkers({ ...p, roots: [{ root, layout: "text" }] }, signal())).toHaveLength(1);
});
it("vision uses operation directory, not response payload, to associate markers", async () => {
  const p = await backlog(), root = p.roots[0]!.root;
  await mkdir(join(root, "v3/vision/vision-one"), { recursive: true });
  await writeFile(join(root, "v3/vision/vision-one/response.json"), "private response that must not be parsed");
  await writeFile(join(root, "v3/vision/vision-one/registration.json"), "{}");
  expect((await handoffMarkers({ ...p, roots: [{ root, layout: "vision" }] }, signal())).map(x => x.operationId)).toEqual(["vision-one"]);
});
it("missing configured store and symlinked marker/parent fail closed", async () => {
  const p = await backlog(), root = p.roots[0]!.root;
  await expect(handoffMarkers({ ...p, roots: [{ root: join(root, "missing"), layout: "ocr" }] }, signal())).rejects.toThrow();
  await symlink("/etc/hosts", join(root, "fake.json"));
  await expect(handoffMarkers(p, signal())).rejects.toThrow();
  await symlink("/tmp", join(root, "v3"));
  await expect(handoffMarkers({ ...p, roots: [{ root, layout: "vision" }] }, signal())).rejects.toThrow();
});
it("scan ceiling rejects partial results instead of reporting healthy", async () => {
  const p = await backlog(); for (const n of [1, 2]) await writeFile(join(p.roots[0]!.root, `op-${n}.json`), "{}");
  await expect(handoffMarkers({ ...p, maxFiles: 1 }, signal())).rejects.toThrow("SCAN_LIMIT");
});
it("OCR health verifies usable backends, not merely HTTP 200; rejects redirects and oversized bodies", async () => {
  let mode = "ok";
  const server = createServer((_q, r) => { if (mode === "redirect") { r.writeHead(302, { Location: "/health" }); r.end(); } else r.end(mode === "big" ? "x".repeat(10000) : JSON.stringify({ status: "ok", healthy_backends: mode === "ok" ? 4 : 0, total_backends: 4 })); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const p = { ...probe, url: `http://127.0.0.1:${(server.address() as any).port}/health` };
  try {
    expect((await runDependencyProbe(p, db, signal())).healthy).toBe(true);
    mode = "down"; expect((await runDependencyProbe(p, db, signal())).healthy).toBe(false);
    mode = "big"; await expect(runDependencyProbe(p, db, signal())).rejects.toThrow();
    mode = "redirect"; await expect(runDependencyProbe(p, db, signal())).rejects.toThrow();
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
it("monitor starts unavailable, refreshes on cadence, and expires success once the grace window closes", async () => {
  vi.useFakeTimers(); const run = vi.fn(async () => ({ healthy: true, reason: "ready" }));
  const m = new DependencyMonitor([probe], run, db, 30000, 5000, 600000);
  expect(m.snapshot()[0]!.healthy).toBe(false); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(m.snapshot()[0]!.healthy).toBe(true); m.tick(); expect(run).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(30001); m.tick(); await vi.advanceTimersByTimeAsync(0); expect(run).toHaveBeenCalledTimes(2);
  // The observation is no longer fresh, but the probe did answer recently: the verdict it gave still stands.
  await vi.advanceTimersByTimeAsync(40001); expect(m.snapshot()[0]).toMatchObject({ healthy: true, reason: "ready:held" });
  // Nothing has confirmed the dependency for the whole grace window: now the gate closes.
  await vi.advanceTimersByTimeAsync(600001); expect(m.snapshot()[0]).toMatchObject({ healthy: false, reason: "dependency_stale" });
  await m.close();
});
it("a probe that cannot answer never closes a gate its last real verdict had open", async () => {
  vi.useFakeTimers(); let answer = true;
  const run = vi.fn(async () => { if (!answer) throw Error("PROBE.TIMEOUT"); return { healthy: true, reason: "ready" }; });
  const m = new DependencyMonitor([probe], run, db, 30000, 5000, 120000);
  m.tick(); await vi.advanceTimersByTimeAsync(0); expect(m.snapshot()[0]!.healthy).toBe(true);
  answer = false;
  await vi.advanceTimersByTimeAsync(30001); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(m.snapshot()[0]).toMatchObject({ healthy: true, reason: "ready:held" });
  // A dependency that stays unconfirmed past the window is a real outage, not a slow probe.
  await vi.advanceTimersByTimeAsync(120001); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(m.snapshot()[0]!.healthy).toBe(false); await m.close();
});
it("an unhealthy verdict is never held: a dependency that answered no stays closed", async () => {
  vi.useFakeTimers(); let answer = true;
  const run = vi.fn(async () => { if (!answer) throw Error("PROBE.TIMEOUT"); return { healthy: false, reason: "backlog" }; });
  const m = new DependencyMonitor([probe], run, db, 30000, 5000, 600000);
  m.tick(); await vi.advanceTimersByTimeAsync(0); expect(m.snapshot()[0]!.healthy).toBe(false);
  answer = false;
  await vi.advanceTimersByTimeAsync(30001); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(m.snapshot()[0]!.healthy).toBe(false); await m.close();
});
it("hung dependency cannot stall healthy independent probes, overlap itself or publish late success", async () => {
  vi.useFakeTimers(); let resolve!: (v: { healthy: boolean; reason: string }) => void;
  const run = vi.fn(async (p: DependencyProbe) => p.id === "ocr" ? new Promise<{ healthy: boolean; reason: string }>(r => { resolve = r; }) : { healthy: true, reason: "ready" });
  const m = new DependencyMonitor([probe, { ...probe, id: "other" }], run, db, 30000, 5000);
  m.tick(); await vi.advanceTimersByTimeAsync(5001); expect(m.snapshot().map(s => s.healthy)).toEqual([false, true]);
  await vi.advanceTimersByTimeAsync(30001); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(run.mock.calls.filter(([p]) => p.id === "ocr")).toHaveLength(1);
  resolve({ healthy: true, reason: "late" }); await vi.advanceTimersByTimeAsync(0); expect(m.snapshot()[0]!.healthy).toBe(false); await m.close();
});
it("shutdown aborts probes and suppresses publication; error text is never disclosed", async () => {
  vi.useFakeTimers(); const run = vi.fn(async () => { throw Error("password=do-not-publish"); });
  const m = new DependencyMonitor([probe], run, db); m.tick(); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(m.snapshot())).not.toContain("password"); await m.close(); m.tick(); expect(run).toHaveBeenCalledTimes(1);
});

it("settled ids survive a restart: a cold monitor asks the ledger only about new handoffs", async () => {
  const p = { ...(await backlog()), settledCachePath: join(await mkdtemp(join(tmpdir(), "v3-settled-")), "settled.json") };
  for (const id of ["pending-one", "saved-one", "review-one"]) await writeFile(join(p.roots[0]!.root, `${id}.json`), "{}");
  db.query.mockImplementation(async sql => ({ rows: [{ operation_id: sql.includes("processing_result") ? "saved-one" : "review-one" }] }));
  expect(await readHandoffBacklog(p, db, signal())).toMatchObject({ pending: 1, reviewed: 1 });
  // A new process: nothing is remembered in memory, only the file on disk is.
  const restarted = { ...p, id: "spool-restarted" };
  db.query.mockClear(); db.query.mockImplementation(async () => ({ rows: [] }));
  expect(await readHandoffBacklog(restarted, db, signal())).toMatchObject({ pending: 1, reviewed: 1 });
  // One batch, two permanent-fact tables, and the only id it had to ask about is the one still pending.
  expect(db.query).toHaveBeenCalledTimes(2);
  expect([...new Set(db.query.mock.calls.flatMap(([, args]) => (args as string[][])[0]!))]).toEqual(["pending-one"]);
});
it("an unusable settled cache costs a slower tick, never a wrong verdict", async () => {
  const dir = await mkdtemp(join(tmpdir(), "v3-settled-bad-"));
  const p = { ...(await backlog()), settledCachePath: join(dir, "settled.json") };
  await writeFile(p.settledCachePath, "{ truncated");
  for (const id of ["pending-one", "saved-one"]) await writeFile(join(p.roots[0]!.root, `${id}.json`), "{}");
  db.query.mockImplementation(async sql => ({ rows: sql.includes("processing_result") ? [{ operation_id: "saved-one" }] : [] }));
  expect(await readHandoffBacklog(p, db, signal())).toMatchObject({ pending: 1 });
});
