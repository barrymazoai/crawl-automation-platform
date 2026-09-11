import { expect, it, vi } from "vitest";
import type { GncAcquireInput, ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { GncAdapter } from "./gnc.js";
import { AcquireGncModule, GncCaptureEvidence, gncKeys } from "./gnc-handoff.js";
import { GncCatalogDiscoveries, gncDiscoveryKey } from "./gnc-discovery.js";
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (this.data.has(key)) return "exists" as const;
    this.data.set(key, Buffer.from(bytes)); return "created" as const;
  });
}
const signal = () => new AbortController().signal;
async function fixture() {
  const task: GncAcquireInput = { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: "req", observationId: "catalog-obs", brandId: "brand", sourceId: "gnc", listingId: "catalog-listing", variantId: null },
    capture: { kind: "catalog-page", requestId: "req", operationId: "catalog", brandId: "brand", sourceId: "gnc",
      binding: { sessionId: "session", egressId: "host/1" }, url: "https://www.gnc.com/brands/example/" },
    network: { routeId: "r", version: "1", egressId: "host/1", mode: "host", managed: false } };
  const local = new Memory(), remote = new Memory(), records = new Map<string, ReviewRecord>();
  const reviews = { append: async (r: ReviewRecord) => { records.set(r.reviewId, r); }, read: async (id: string) => records.get(id) ?? null };
  const evidence = new GncCaptureEvidence({ local, remote, reviews });
  const read = vi.fn(async () => ({ operationId: task.capture.operationId, requestedUrl: task.capture.url, finalUrl: task.capture.url,
    binding: task.capture.binding, status: 200, contentType: "text/html", network: task.network,
    bytes: Buffer.from('<div class="product-tile"><a href="/123456.html">One</a></div><div class="product-tile"><a href="/123457.html">Two</a></div>') }));
  expect(await new AcquireGncModule(evidence, new GncAdapter({ read })).run(task, signal())).toMatchObject({ status: "durable" });
  return { task, local, remote, reviews, records, read, module: new GncCatalogDiscoveries(evidence),
    cold: () => new GncCatalogDiscoveries(new GncCaptureEvidence({ local: new Memory(), remote, reviews })) };
}
it("publishes one item independently; a cold consumer verifies it without a browser or PUT", async () => {
  const f = await fixture(), input = { task: f.task, index: 0 };
  const first = await f.module.run(input, signal());
  expect(first).toMatchObject({ status: "published", total: 2, entry: { sku: "123456" }, completion: "unverified_end" });
  expect(f.remote.data.has(gncDiscoveryKey({ ...input, index: 1 }))).toBe(false);
  const writes = f.remote.create.mock.calls.length;
  expect(await f.cold().run(input, signal())).toEqual(first);
  expect((await f.cold().inspect(input, signal()))?.entry.sku).toBe("123456");
  expect(f.remote.create).toHaveBeenCalledTimes(writes); expect(f.read).toHaveBeenCalledTimes(1);
});
it("a later item failure retains the earlier publication; unknown upload never retries from empty cache", async () => {
  const f = await fixture(), first = { task: f.task, index: 0 }, second = { task: f.task, index: 1 };
  await f.module.run(first, signal()); const original = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementation(async (...args) => { if (args[0] === gncDiscoveryKey(second)) throw Error("secret transport failure"); return original(...args); });
  expect(await f.module.run(second, signal())).toMatchObject({ status: "review", code: "GNC.DISCOVERY_UNVERIFIED", automaticRetry: false });
  const puts = f.remote.create.mock.calls.length;
  expect(await f.cold().run(second, signal())).toMatchObject({ status: "review", code: "GNC.DISCOVERY_HANDOFF_PENDING" });
  expect(f.remote.create).toHaveBeenCalledTimes(puts);
  expect(await f.cold().inspect(first, signal())).not.toBeNull();
  expect(JSON.stringify([...f.records.values()])).not.toContain("secret transport");
});
it("lost successful publication acknowledgement is reconciled by readback", async () => {
  const f = await fixture(), input = { task: f.task, index: 0 }, original = f.remote.create.getMockImplementation()!;
  f.remote.create.mockImplementation(async (...args) => { const result = await original(...args); if (args[0] === gncDiscoveryKey(input)) throw Error("lost"); return result; });
  expect(await f.module.run(input, signal())).toMatchObject({ status: "published" });
  expect(f.remote.create.mock.calls.filter(c => c[0] === gncDiscoveryKey(input))).toHaveLength(1);
});
it("concurrent duplicate publishers publish at most once", async () => {
  const f = await fixture(), input = { task: f.task, index: 0 };
  const results = await Promise.all([f.module.run(input, signal()), f.cold().run(input, signal())]);
  expect(results.some(r => r.status === "published")).toBe(true);
  expect(f.remote.create.mock.calls.filter(c => c[0] === gncDiscoveryKey(input))).toHaveLength(1);
});
it.each(["owner", "bytes", "index"])("rejects %s mismatch without another capture", async mode => {
  const f = await fixture(), input = { task: f.task, index: 0 };
  if (mode === "owner") input.task = { ...f.task, owner: { ...f.task.owner, observationId: "foreign" } };
  if (mode === "bytes") f.remote.data.set(gncKeys(f.task).evidence, Buffer.from("corrupted"));
  if (mode === "index") input.index = 2;
  const puts = f.remote.create.mock.calls.length;
  expect(await f.module.run(input, signal())).toMatchObject({ status: "review", automaticRetry: false });
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
});
it("cancelled publication does no work", async () => {
  const f = await fixture(), puts = f.remote.create.mock.calls.length;
  await expect(f.module.run({ task: f.task, index: 0 }, AbortSignal.abort(Error("cancelled")))).rejects.toThrow("cancelled");
  expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.records.size).toBe(0);
});
