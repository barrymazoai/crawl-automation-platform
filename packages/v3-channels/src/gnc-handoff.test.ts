import { describe, expect, it, vi } from "vitest";
import { GncAcquireInputSchema, type GncAcquireInput, type ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { GncAdapter, type GncPageReader } from "./gnc.js";
import { AcquireGncModule, GncCaptureEvidence, gncKeys } from "./gnc-handoff.js";
import { ResolveGncReceipt } from "./gnc-receipt.js";
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string, limit: number, signal: AbortSignal) => { signal.throwIfAborted(); const bytes = this.data.get(key); if (bytes && bytes.length > limit) throw Error("limit"); return bytes ?? null; });
  create = vi.fn(async (key: string, bytes: Uint8Array, _media: string, signal: AbortSignal) => {
    signal.throwIfAborted(); if (this.data.has(key)) return "exists" as const; this.data.set(key, Buffer.from(bytes)); return "created" as const;
  });
}
const input: GncAcquireInput = { schemaVersion: 1, implementationVersion: "gnc-acquire/1",
  owner: { schemaVersion: 1, requestId: "req", observationId: "obs", brandId: "brand", sourceId: "source", listingId: "listing", variantId: null },
  capture: { kind: "product", requestId: "req", operationId: "op", brandId: "brand", sourceId: "source", binding: { sessionId: "s", egressId: "host/1" }, url: "https://www.gnc.com/123456.html", sku: "123456" },
  network: { routeId: "r", version: "1", egressId: "host/1", mode: "host", managed: false } };
const html = '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"Vitamin"}</script><div id="productIngredientsAccordionContent"><table><tr><td>Vitamin C</td><td>10 mg</td></tr></table>Other ingredients: cellulose</div>';
const signal = () => new AbortController().signal;
function fixture(content = html, task = structuredClone(input)) {
  const local = new Memory(), remote = new Memory(), records = new Map<string, ReviewRecord>();
  const reviews = { read: vi.fn(async (id: string) => records.get(id) ?? null), append: vi.fn(async (r: ReviewRecord) => { if (!records.has(r.reviewId)) records.set(r.reviewId, structuredClone(r)); }) };
  const read = vi.fn<GncPageReader["read"]>(async capture => ({ operationId: capture.operationId, requestedUrl: capture.url, finalUrl: capture.url,
    binding: capture.binding, status: 200, contentType: "text/html", bytes: Buffer.from(content), network: task.network }));
  const adapter = new GncAdapter({ read }), evidence = new GncCaptureEvidence({ local, remote, reviews });
  return { task, local, remote, reviews, records, read, adapter, evidence, module: new AcquireGncModule(evidence, adapter) };
}
describe("GNC durable source/evidence handoff", () => {
  it.each([[307, '<p>Press &amp; Hold to confirm you are a human.</p>', "GNC.ACCESS_CHALLENGE"],
    [404, '<p>Page not found</p>', "GNC.NOT_FOUND"], [500, '<p>Unavailable</p>', "GNC.HTTP_STATUS"]])(
    "retains HTTP %s failure HTML in passive SOURCE Review; a cold worker never recrawls", async (status, body, code) => {
      const f = fixture(String(body)), read = f.read.getMockImplementation()!;
      f.read.mockImplementation(async (...args) => ({ ...await read(...args), status: Number(status) }));
      const out = await f.module.run(f.task, signal());
      expect(out).toMatchObject({ status: "review", code, automaticRetry: false });
      const keys = gncKeys(f.task);
      expect(Buffer.from(f.remote.data.get(keys.source)!).toString()).toBe(body);
      expect(f.remote.data.has(keys.received)).toBe(true);
      expect(f.remote.data.has(keys.evidence)).toBe(false); expect(f.remote.data.has(keys.completion)).toBe(false);
      expect([...f.records.values()][0]?.failure).toMatchObject({ category: "SOURCE", code, executionFact: "executed", automaticRetry: false });
      const puts = f.remote.create.mock.calls.length;
      const cold = new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews });
      expect(await new AcquireGncModule(cold, f.adapter).run(f.task, signal())).toEqual(out);
      expect(await new ResolveGncReceipt(cold).run({ task: f.task, receipt: out }, signal())).toEqual(out);
      expect(f.read).toHaveBeenCalledTimes(1); expect(f.remote.create).toHaveBeenCalledTimes(puts);
    });
  it("receipt-only cold consumer verifies lost acknowledgements without source reads or publication", async () => {
    const f = fixture(), out = await f.module.run(f.task, signal());
    const puts = f.remote.create.mock.calls.length;
    const e = new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews });
    const receipt = new ResolveGncReceipt(e);
    expect(await receipt.run({ task: f.task, receipt: null }, signal())).toEqual(out);
    expect(await receipt.run({ task: f.task, receipt: out }, signal())).toEqual(out);
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("receipt rejects forged durable hints even if a real completion exists", async () => {
    const f = fixture(), out = await f.module.run(f.task, signal());
    if (out.status !== "durable") throw Error();
    const puts = f.remote.create.mock.calls.length;
    expect(await new ResolveGncReceipt(f.evidence).run({ task: f.task, receipt: { ...out, inputFingerprint: "a".repeat(64) } }, signal()))
      .toMatchObject({ status: "review", code: "GNC.EVIDENCE_CONFLICT" });
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("receipt-only missing completion creates passive Review without claiming or fetching", async () => {
    const f = fixture();
    expect(await new ResolveGncReceipt(f.evidence).run({ task: f.task, receipt: null }, signal()))
      .toMatchObject({ status: "review", code: "GNC.NOT_DURABLE", automaticRetry: false });
    expect(f.remote.create).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
    expect(f.records.size).toBe(1);
  });
  it("receipt verifies prior Review and never resumes a partial local candidate", async () => {
    const f = fixture("<div>no matching SKU</div>");
    const out = await f.module.run(f.task, signal()), puts = f.remote.create.mock.calls.length;
    const e = new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews });
    expect(await new ResolveGncReceipt(e).run({ task: f.task, receipt: out }, signal())).toEqual(out);
    expect(await new ResolveGncReceipt(e).run({ task: f.task, receipt: null }, signal())).toEqual(out);
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("receipt cancellation performs no source, storage write or Review work", async () => {
    const f = fixture(), c = new AbortController(); c.abort(Error("cancel"));
    await expect(new ResolveGncReceipt(f.evidence).run({ task: f.task, receipt: null }, c.signal)).rejects.toThrow("cancel");
    expect(f.remote.create).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.records.size).toBe(0);
  });
  it("stores raw HTML and parsed evidence with ownership before completion; cold replacement only reads", async () => {
    const f = fixture(), out = await f.module.run(f.task, signal()); expect(out.status).toBe("durable");
    if (out.status !== "durable") throw Error();
    expect(out.source).toMatchObject({ kind: "source-html", observationId: "obs", listingId: "listing" });
    expect(Buffer.from(f.remote.data.get(out.source.objectKey)!).toString()).toBe(html);
    expect(f.remote.data.size).toBe(9);
    const record = await f.evidence.inspect(f.task, signal()); expect(record?.input).toEqual(f.task);
    const puts = f.remote.create.mock.calls.length;
    const next = new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews });
    expect(await new AcquireGncModule(next, f.adapter).run(f.task, signal())).toEqual(out);
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("catalog is one page, not a completed Brand, and retains its own observation", async () => {
    const task = structuredClone(input); task.capture = { ...task.capture, kind: "catalog-page", url: "https://www.gnc.com/brands/example/" } as GncAcquireInput["capture"];
    delete (task.capture as unknown as Record<string, unknown>).sku;
    const f = fixture('<div class="product-tile"><a href="/123456.html">Vitamin</a></div>', task);
    const out = await f.module.run(task, signal()); expect(out.status).toBe("durable");
    const saved = JSON.parse(Buffer.from(f.remote.data.get(gncKeys(task).evidence)!).toString());
    expect(saved).toMatchObject({ kind: "catalog-page", data: { completion: "unverified_end", entries: [{ sku: "123456" }] } });
  });
  it("retains and publishes raw HTML before a SKU parser failure; passive Review is stable", async () => {
    const f = fixture(html.replace('"123456"', '"999999"'));
    const out = await f.module.run(f.task, signal()); expect(out).toMatchObject({ status: "review", code: "GNC.SKU_UNVERIFIED" });
    expect(f.remote.data.has(gncKeys(f.task).source)).toBe(true); expect(f.remote.data.has(gncKeys(f.task).received)).toBe(true);
    expect(f.remote.data.has(gncKeys(f.task).completion)).toBe(false);
    expect([...f.records.values()][0]?.failure.executionFact).toBe("executed");
    const puts = f.remote.create.mock.calls.length;
    expect(await f.module.run(f.task, signal())).toEqual(out); expect(f.records.size).toBe(1);
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "received", "evidence", "completion"] as const)("lost %s PUT acknowledgement reconciles without another PUT", async name => {
    const f = fixture(), create = f.remote.create.getMockImplementation()!; const key = gncKeys(f.task)[name];
    f.remote.create.mockImplementation(async (...args) => { const result = await create(...args); if (args[0] === key) throw Error("lost ack"); return result; });
    expect(await f.module.run(f.task, signal())).toMatchObject({ status: "durable" });
    expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(1); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "evidence", "completion"] as const)("unknown %s upload is never retried from same or empty cache", async name => {
    const f = fixture(), create = f.remote.create.getMockImplementation()!, key = gncKeys(f.task)[name];
    f.remote.create.mockImplementation(async (...args) => { if (args[0] === key) throw Error("secret provider error"); return create(...args); });
    const out = await f.module.run(f.task, signal()); expect(out).toMatchObject({ status: "review", code: "GNC.PUBLICATION_UNKNOWN" });
    expect(f.local.data.has(gncKeys(f.task).source)).toBe(true);
    const next = new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews });
    expect(await new AcquireGncModule(next, f.adapter).run(f.task, signal())).toEqual(out);
    await f.evidence.resume(f.task, signal()).catch(() => {});
    expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(1); expect(f.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...f.records.values()])).not.toContain("secret provider error");
  });
  it("can resume a retained candidate before its next PUT was ever attempted, without a crawler", async () => {
    const f = fixture(), read = f.remote.read.getMockImplementation()!, key = gncKeys(f.task).evidence; let fail = true;
    f.remote.read.mockImplementation(async (...args) => { if (fail && args[0] === key) throw Error("read unavailable before publish"); return read(...args); });
    expect(await f.module.run(f.task, signal())).toMatchObject({ status: "review" });
    expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(0);
    fail = false; const resumed = await new GncCaptureEvidence({ local: f.local, remote: f.remote, reviews: f.reviews }).resume(f.task, signal());
    expect(resumed).not.toBeNull(); expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.remote.create.mock.calls.filter(c => c[0] === key)).toHaveLength(1);
  });
  it("shared execution intent with no completion never causes a replacement to recrawl", async () => {
    const f = fixture(); f.remote.data.set(gncKeys(f.task).intent, Buffer.from("{}"));
    expect(await f.module.run(f.task, signal())).toMatchObject({ status: "review", code: "GNC.EXECUTION_UNKNOWN" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("unknown execution-intent acknowledgement never starts network", async () => {
    const f = fixture(), create = f.remote.create.getMockImplementation()!;
    f.remote.create.mockImplementation(async (...args) => { const out = await create(...args); if (args[0] === gncKeys(f.task).intent) throw Error("lost"); return out; });
    expect(await f.module.run(f.task, signal())).toMatchObject({ code: "GNC.EXECUTION_UNKNOWN" }); expect(f.read).not.toHaveBeenCalled();
  });
  it("concurrent duplicate starts issue at most one page read", async () => {
    const f = fixture(), second = new AcquireGncModule(new GncCaptureEvidence({ local: new Memory(), remote: f.remote, reviews: f.reviews }), f.adapter);
    const out = await Promise.all([f.module.run(f.task, signal()), second.run(f.task, signal())]);
    expect(out.some(r => r.status === "durable")).toBe(true); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("refuses changed owner/route and corrupted already published HTML without repair or recrawl", async () => {
    const f = fixture(); expect(await f.module.run(f.task, signal())).toMatchObject({ status: "durable" });
    const puts = f.remote.create.mock.calls.length;
    const foreign = { ...f.task, owner: { ...f.task.owner, observationId: "other" } };
    expect(await f.module.run(foreign, signal())).toMatchObject({ status: "review", code: "GNC.EVIDENCE_CONFLICT" });
    f.remote.data.set(gncKeys(f.task).source, Buffer.from("corrupted"));
    expect(await f.module.run(f.task, signal())).toMatchObject({ status: "review", code: "ARTIFACT.INTEGRITY" });
    expect(f.remote.create).toHaveBeenCalledTimes(puts); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched request/source/egress in shared schema before side effects", () => {
    for (const patch of [{ owner: { ...input.owner, sourceId: "other" } }, { network: { ...input.network, egressId: "other" } }])
      expect(GncAcquireInputSchema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it("does not claim Review persisted if the repository cannot confirm it", async () => {
    const f = fixture("<div>no product</div>"); f.reviews.append.mockRejectedValue(new Error("private DB message"));
    await expect(f.module.run(f.task, signal())).rejects.toThrow("GNC.REVIEW_UNVERIFIED");
    expect([...f.local.data.keys()].some(k => k.startsWith("gnc-reviews/"))).toBe(true);
  });
  it("late cancellation retains received HTML locally, does not publish or re-execute", async () => {
    const f = fixture(), c = new AbortController(), read = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => { const page = await read(...args); c.abort(new Error("cancel")); return page; });
    expect(await f.module.run(f.task, c.signal)).toMatchObject({ status: "review", code: "GNC.CANCELLED" });
    expect(f.local.data.has(gncKeys(f.task).source)).toBe(true); expect(f.remote.data.has(gncKeys(f.task).source)).toBe(false);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
});
