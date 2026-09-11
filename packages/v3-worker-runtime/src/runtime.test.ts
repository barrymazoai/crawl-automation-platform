import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parseWorkerConfig } from "./config.js";
import { RoleRegistry, type RoleDefinition, type PreparedRole } from "./registry.js";
import { runRegisteredWorker, UnsafeWorkerExit, type WorkerHandle } from "./lifecycle.js";
import { checkedActivity } from "./activity.js";

const config = { role: "ocr-file", capability: "ocr.file", contractVersion: 1, compatibility: "c1", expectedBuildId: "a".repeat(64),
  hostId: "test-host", namespace: "default", address: "127.0.0.1:7233", transport: { mode: "local" } };
function fixture() {
  const events: string[] = []; let state = "INITIALIZED"; let release = () => {};
  const pending = new Promise<void>(resolve => { release = () => { state = "STOPPED"; resolve(); }; });
  const prepared: PreparedRole = { kind: "activity", activities: { ocr: async () => "test" }, dispose: vi.fn(async () => { events.push("dispose"); }) };
  const definition: RoleDefinition = { role: "ocr-file", kind: "activity", capability: "ocr.file", contractVersion: 1,
    compatibility: "c1", buildId: config.expectedBuildId, testOnly: false, prepare: vi.fn(async () => prepared) };
  const worker: WorkerHandle = { run: vi.fn(() => { state = "RUNNING"; events.push("run"); return pending; }),
    shutdown: vi.fn(() => { state = "DRAINING"; events.push("shutdown"); release(); }), getState: () => state };
  const connection = { create: vi.fn(async () => worker), close: vi.fn(async () => { events.push("close"); }) };
  const ports = { connect: vi.fn(async () => connection), report: vi.fn() };
  return { events, prepared, definition, worker, connection, ports, release };
}
describe("capability registry and configuration", () => {
  it("routes opted-in source sessions to distinct queues without changing shared OCR queues",()=>{
    const f=fixture(), shared=new RoleRegistry("business",[f.definition]);
    expect(()=>shared.select(parseWorkerConfig({...config,queueScope:"session-a"}))).toThrow("does not accept");
    const scoped=new RoleRegistry("business",[{...f.definition,sessionScoped:true}]);
    const a=scoped.select(parseWorkerConfig({...config,queueScope:"session-a"})).taskQueue;
    const b=scoped.select(parseWorkerConfig({...config,queueScope:"session-b"})).taskQueue;
    expect(a).toBe("v3.ocr.file.v1.c1.session.session-a");expect(a).not.toBe(b);
    expect(shared.select(parseWorkerConfig(config)).taskQueue).toBe("v3.ocr.file.v1.c1");
    expect(()=>parseWorkerConfig({...config,queueScope:"../other"})).toThrow();
  });
  it("rejects unknown roles and mismatched capability/version/build before opening clients", async () => {
    const f = fixture(); const registry = new RoleRegistry("business", [f.definition]);
    for (const change of [{ role: "unknown" }, { capability: "other" }, { contractVersion: 2 }, { compatibility: "c2" }, { expectedBuildId: "b".repeat(64) }])
      await expect(runRegisteredWorker({ ...config, ...change }, registry, f.ports, new AbortController().signal)).rejects.toThrow();
    expect(f.ports.connect).not.toHaveBeenCalled(); expect(f.definition.prepare).not.toHaveBeenCalled();
  });
  it("rejects duplicates, mixed environments and test profiles on remote servers", () => {
    const f = fixture();
    expect(() => new RoleRegistry("business", [f.definition, f.definition])).toThrow();
    expect(() => new RoleRegistry("business", [f.definition, { ...f.definition, role: "other" }])).toThrow();
    expect(() => new RoleRegistry("business", [{ ...f.definition, testOnly: true }])).toThrow();
    expect(() => new RoleRegistry("test", [f.definition])).toThrow();
    const registry = new RoleRegistry("test", [{ ...f.definition, testOnly: true }]);
    expect(() => registry.select(parseWorkerConfig(config))).toThrow();
    const selected = registry.select(parseWorkerConfig({ ...config, testSession: "isolated-1" }));
    expect(selected.taskQueue).toBe("v3.test.isolated-1.ocr.file.v1.c1");
    expect(() => registry.select(parseWorkerConfig({ ...config, testSession: "x", namespace: "production" }))).toThrow();
  });
  it("does not allow arbitrary queue/path injection, remote plaintext or invalid shutdown bounds", () => {
    for (const change of [{ taskQueue: "other" }, { workflowsPath: "/tmp/code.js" }, { concurrency: 0 }, { role: "../x" },
      { shutdownGraceMs: 5000, shutdownForceMs: 4000 }, { address: "cloud.example:7233" }])
      expect(() => parseWorkerConfig({ ...config, ...change })).toThrow();
  });
  it("requires complete absolute mTLS paths and keeps validation errors free of secret values", () => {
    expect(parseWorkerConfig({ ...config, address: "cloud.example:7233", transport: { mode: "mtls", serverName: "test",
      caFile: "/tmp/ca", certFile: "/tmp/crt", keyFile: "/tmp/key" } }).transport.mode).toBe("mtls");
    expect(() => parseWorkerConfig({ ...config, transport: { mode: "mtls", keyFile: "secret-canary" } })).toThrow("Invalid V3 Worker configuration");
  });
  it("validates the SDK minimum for Workflow task slots instead of silently increasing concurrency", () => {
    const f = fixture(); const registry = new RoleRegistry("business", [{ ...f.definition, kind: "workflow" }]);
    expect(() => registry.select(parseWorkerConfig({ ...config, concurrency: 1 }))).toThrow("at least 2");
    expect(registry.select(parseWorkerConfig({ ...config, concurrency: 2 })).role.kind).toBe("workflow");
  });
});
describe("owned Worker lifecycle", () => {
  it("stops exactly once and disposes module resources only after the Worker stops", async () => {
    const f = fixture(); const controller = new AbortController();
    const running = runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, controller.signal);
    await vi.waitFor(() => expect(f.worker.run).toHaveBeenCalled());
    controller.abort(); controller.abort(); await running;
    expect(f.events).toEqual(["run", "shutdown", "dispose", "close"]);
    expect(f.worker.shutdown).toHaveBeenCalledTimes(1);
    expect(f.ports.report.mock.calls.some(([e]) => e.event === "WORKER_RUNNING" && e.taskQueue === "v3.ocr.file.v1.c1")).toBe(true);
  });
  it("does no I/O if stopped before startup", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, controller.signal);
    expect(f.ports.connect).not.toHaveBeenCalled();
  });
  it("closes the connection if stopped during connect, without preparing a module", async () => {
    const f = fixture(); const controller = new AbortController();
    f.ports.connect.mockImplementation(async () => { controller.abort(); return f.connection; });
    await runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, controller.signal);
    expect(f.definition.prepare).not.toHaveBeenCalled(); expect(f.events).toEqual(["close"]);
  });
  it("handles an abort arriving while Worker.create is pending by starting and immediately draining", async () => {
    const f = fixture(); const controller = new AbortController();
    f.connection.create.mockImplementation(async () => { controller.abort(); return f.worker; });
    await runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, controller.signal);
    expect(f.events).toEqual(["run", "shutdown", "dispose", "close"]);
  });
  it("closes its connection even if module disposal fails", async () => {
    const f = fixture(); const controller = new AbortController();
    f.prepared.dispose = async () => { f.events.push("dispose-failed"); throw new Error("dispose failed"); };
    const running = runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, controller.signal);
    const checked = expect(running).rejects.toThrow("dispose failed");
    await vi.waitFor(() => expect(f.worker.run).toHaveBeenCalled()); controller.abort(); await checked;
    expect(f.events).toEqual(["run", "shutdown", "dispose-failed", "close"]);
  });
  it("cleans up preparation and Worker creation failures without leaking the connection", async () => {
    const f = fixture(); f.connection.create.mockRejectedValue(new Error("create failed"));
    await expect(runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, new AbortController().signal)).rejects.toThrow("create failed");
    expect(f.events).toEqual(["dispose", "close"]);
    const g = fixture(); g.definition.prepare = async () => { throw new Error("prepare failed"); };
    await expect(runRegisteredWorker(config, new RoleRegistry("business", [g.definition]), g.ports, new AbortController().signal)).rejects.toThrow("prepare failed");
    expect(g.events).toEqual(["close"]);
  });
  it("rejects an empty or mixed role factory before polling", async () => {
    const f = fixture(); f.definition.prepare = async () => ({ kind: "activity", activities: {}, dispose: f.prepared.dispose });
    await expect(runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, new AbortController().signal)).rejects.toThrow("isolated capability");
    expect(f.worker.run).not.toHaveBeenCalled(); expect(f.events).toEqual(["dispose", "close"]);
  });
  it("does not release resources under live callbacks after a forced/failed Worker exit", async () => {
    const f = fixture(); f.worker.run = async () => { throw new Error("forced SDK exit"); }; f.worker.getState = () => "FAILED";
    await expect(runRegisteredWorker(config, new RoleRegistry("business", [f.definition]), f.ports, new AbortController().signal)).rejects.toBeInstanceOf(UnsafeWorkerExit);
    expect(f.prepared.dispose).not.toHaveBeenCalled(); expect(f.connection.close).not.toHaveBeenCalled();
  });
});
describe("atomic Activity validation", () => {
  it("rejects bad input before side effects and rejects bad output without executing again", async () => {
    const run = vi.fn(async (n: number) => n + 1);
    const activity = checkedActivity(z.number(), z.number(), run);
    await expect(activity("invalid")).rejects.toMatchObject({ type: "CONTRACT.INPUT_INVALID", nonRetryable: true });
    expect(run).not.toHaveBeenCalled(); expect(await activity(1)).toBe(2);
    const invalidOutput = checkedActivity(z.number(), z.number().max(0), run);
    await expect(invalidOutput(1)).rejects.toMatchObject({ type: "CONTRACT.OUTPUT_INVALID", nonRetryable: true });
    expect(run).toHaveBeenCalledTimes(2);
  });
});
