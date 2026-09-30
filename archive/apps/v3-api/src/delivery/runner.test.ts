import { describe, expect, it, vi } from "vitest";
import { DeliveryRunner, type DeliveryScan, type ScanCursor, type RunnerEvent } from "./runner.js";

function fixture(count = 5) {
  const rows = Array.from({ length: count }, (_, i) => ({ createdAt: String(i + 1), requestId: String(i + 1) }));
  const page = vi.fn(async (after: ScanCursor | null, through: ScanCursor, limit: number) =>
    rows.filter((r) => Number(r.requestId) > Number(after?.requestId ?? 0) && Number(r.requestId) <= Number(through.requestId)).slice(0, limit));
  const scan: DeliveryScan = { upperBound: vi.fn(async () => rows.at(-1) ?? null), page };
  return { rows, scan, page };
}
const options = { batchSize: 2, concurrency: 1, intervalMs: 100 };
const signal = () => new AbortController().signal;

describe("bounded handoff runner", () => {
  it("advances past poison requests and uses a fixed upper boundary under new arrivals", async () => {
    const f = fixture(); const seen: string[] = []; const events: RunnerEvent[] = [];
    const runner = new DeliveryRunner(f.scan, { reconcile: async (id) => { seen.push(id); if (id === "1") throw new Error("poison"); } }, options, async () => false, e => events.push(e));
    await runner.tick(signal());
    f.rows.push({ createdAt: "6", requestId: "6" });
    await runner.tick(signal()); await runner.tick(signal());
    expect(seen).toEqual(["1", "2", "3", "4", "5"]);
    expect(events[0]).toEqual({ event: "RECONCILE_FAILED", requestId: "1" });
    expect(f.page.mock.calls.every((args) => args[1].requestId === "5" && args[2] === 2)).toBe(true);
    await runner.tick(signal()); // Exhausted sweep, reset.
    await runner.tick(signal());
    expect(seen.slice(-2)).toEqual(["1", "2"]); // Revisit old requests before the next new tail.
    expect(f.page.mock.calls.at(-1)?.[1].requestId).toBe("6");
  });
  it("bounds in-flight work, stops new assignments on abort and drains the existing calls", async () => {
    const f = fixture(); const started: string[] = []; const release: Array<() => void> = [];
    const controller = new AbortController();
    const runner = new DeliveryRunner(f.scan, { reconcile: async (id) => {
      started.push(id); await new Promise<void>(resolve => release.push(resolve));
    } }, { ...options, batchSize: 5, concurrency: 2 }, async () => false, () => {});
    const pending = runner.tick(controller.signal);
    await vi.waitFor(() => expect(started).toEqual(["1", "2"]));
    await expect(runner.tick(controller.signal)).rejects.toThrow("Overlapping");
    controller.abort();
    release.forEach(resolve => resolve());
    await pending;
    expect(started).toEqual(["1", "2"]);
  });
  it("pauses before scanning and between assignments, then resumes without dropping the page tail", async () => {
    const f = fixture(); let paused = true; const seen: string[] = [];
    const runner = new DeliveryRunner(f.scan, { reconcile: async (id) => { seen.push(id); paused = true; } }, options, async () => paused, () => {});
    await runner.tick(signal()); expect(f.page).not.toHaveBeenCalled();
    paused = false; await runner.tick(signal()); expect(seen).toEqual(["1"]);
    paused = false; await runner.tick(signal()); expect(seen).toEqual(["1", "2"]);
  });
  it("a fresh runner reconstructs the scan; only the persistent coordinator may authorize a Start", async () => {
    const f = fixture(); const seen: string[] = [];
    const coordinator = { reconcile: async (id: string) => { seen.push(id); } };
    await new DeliveryRunner(f.scan, coordinator, options, async () => false, () => {}).tick(signal());
    await new DeliveryRunner(f.scan, coordinator, options, async () => false, () => {}).tick(signal());
    expect(seen).toEqual(["1", "2", "1", "2"]);
  });
  it("reports scan failures, waits between attempts and exits promptly from an aborted wait", async () => {
    const controller = new AbortController(); const events: RunnerEvent[] = [];
    const scan = { upperBound: async () => { throw new Error("no DB"); }, page: async () => [] };
    const runner = new DeliveryRunner(scan, { reconcile: async () => {} }, options, async () => false, e => { events.push(e); controller.abort(); });
    await runner.run(controller.signal);
    expect(events).toEqual([{ event: "SCAN_FAILED" }]);
    const waiting = new DeliveryRunner(fixture(0).scan, { reconcile: async () => {} }, { ...options, intervalMs: 60_000 }, async () => false, () => {});
    const stop = new AbortController(); const running = waiting.run(stop.signal);
    await new Promise(resolve => setTimeout(resolve, 10)); stop.abort(); await running;
  });
  it("fails closed on pause-check errors, oversized pages and invalid capacities", async () => {
    const reconcile = vi.fn(); const f = fixture();
    const paused = new DeliveryRunner(f.scan, { reconcile }, options, async () => { throw new Error("permission denied"); }, () => {});
    await expect(paused.tick(signal())).rejects.toThrow(); expect(reconcile).not.toHaveBeenCalled();
    const oversized = new DeliveryRunner({ ...f.scan, page: async () => f.rows }, { reconcile }, options, async () => false, () => {});
    await expect(oversized.tick(signal())).rejects.toThrow("Unbounded");
    expect(() => new DeliveryRunner(f.scan, { reconcile }, { ...options, concurrency: 3 }, async () => false, () => {})).toThrow();
  });
});
