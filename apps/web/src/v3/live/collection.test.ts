import { afterEach, describe, expect, it, vi } from "vitest";
import { Source, CollectionSubmission, DeliveryReceipt, CollectionCapabilities, temporalExecutionUrl } from "@crawl-automation/v3-contracts";
import { archiveCollection, collectionArchiveKey, collectionStorageKey, deliveryLabel, prepareCollection, readCollection, readCollectionState, sendCollection } from "./collection";

const source = Source.parse({ id: "10000000-0000-4000-8000-000000000001", brandId: "10000000-0000-4000-8000-000000000002", channel: "dtc", region: "US", url: "https://fixture.example/", enabled: true, revision: 2, createdAt: "2026-09-06T00:00:00Z", updatedAt: "2026-09-06T00:00:00Z" });
function memory(): Storage { const values = new Map<string,string>(); return { get length() { return values.size; }, key: n => [...values.keys()][n] ?? null, clear: () => values.clear(), getItem: k => values.get(k) ?? null, setItem: (k,v) => { values.set(k,v); }, removeItem: k => { values.delete(k); } }; }
const receipt = (key: string) => CollectionSubmission.parse({ requestId: key, workflowId: `v3-collection-${key}`, state: "PENDING_DELIVERY", snapshot: { brandId: source.brandId, brandName: "Fixture", sourceId: source.id, sourceRevision: 2, channel: source.channel, region: source.region, url: source.url }, createdAt: source.createdAt });
const delivery = (key: string) => DeliveryReceipt.parse({ requestId: key, target: { clusterId: "test", namespace: "default", taskQueue: "probe", workflowType: "Probe" }, inputHash: "a".repeat(64), state: "CONFIRMED", runId: "10000000-0000-4000-8000-000000000003", observedStatus: "RUNNING", lastIssue: null, terminalEventId: null, intentAt: source.createdAt, checkedAt: source.createdAt, closedAt: null });
afterEach(() => vi.unstubAllGlobals());
describe("manual collection request boundary", () => {
  it("persists a frozen version before sending and restores the same identity", () => {
    const storage = memory(); const intent = prepareCollection(storage, source);
    expect(readCollection(storage)).toEqual(intent);
    expect(intent.input).toEqual({ sourceRevision: 2 });
    expect(() => prepareCollection(storage, source)).toThrow();
  });
  it("fails closed on unavailable or corrupt storage", () => {
    expect(() => readCollection({ getItem: () => "{" } as unknown as Storage)).toThrow();
    const storage = memory(); storage.setItem = () => { throw Error("quota"); };
    expect(() => prepareCollection(storage, source)).toThrow("quota");
  });
  it.each(["NETWORK", "REVISION_CONFLICT", "SOURCE_BUSY", "SUBMISSIONS_DISABLED"])("preserves %s failures and retries the same key/body", async code => {
    const storage = memory(); const intent = prepareCollection(storage, source);
    const fetcher = vi.fn();
    if (code === "NETWORK") fetcher.mockRejectedValueOnce(new Error("lost"));
    else fetcher.mockResolvedValueOnce(Response.json({ error: { code, message: "fixture" } }, { status: code === "SUBMISSIONS_DISABLED" ? 503 : 409 }));
    fetcher.mockResolvedValueOnce(Response.json(receipt(intent.key), { status: 202 })); vi.stubGlobal("fetch", fetcher);
    await expect(sendCollection(intent)).rejects.toThrow();
    expect(readCollection(storage)).toEqual(intent);
    await expect(sendCollection(readCollection(storage)!)).resolves.toEqual(receipt(intent.key));
    expect(fetcher.mock.calls[0]![1].headers).toEqual(fetcher.mock.calls[1]![1].headers);
    expect(fetcher.mock.calls[0]![1].body).toBe(fetcher.mock.calls[1]![1].body);
  });
  it.each(["wrong-key", "wrong-source", "wrong-revision", "wrong-status"])("does not accept %s as a successful receipt", async fault => {
    const intent = prepareCollection(memory(), source); const value = receipt(intent.key);
    if (fault === "wrong-key") { value.requestId = crypto.randomUUID(); value.workflowId = `v3-collection-${value.requestId}`; }
    if (fault === "wrong-source") value.snapshot.sourceId = crypto.randomUUID();
    if (fault === "wrong-revision") value.snapshot.sourceRevision++;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value, { status: fault === "wrong-status" ? 200 : 202 })));
    await expect(sendCollection(intent)).rejects.toMatchObject({ uncertain: true });
  });
  it("a readback 404 does not clear the pending key or POST again", async () => {
    const storage = memory(); const intent = prepareCollection(storage, source);
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ item: null })).mockResolvedValueOnce(Response.json({ error: { code: "SUBMISSION_NOT_FOUND", message: "absent" } }, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readCollectionState(source, intent)).submission).toBeNull();
    expect(readCollection(storage)).toEqual(intent);
    expect(fetcher.mock.calls.every(c => c[1].method === undefined)).toBe(true);
  });
  it("does not mistake another active request for this pending request", async () => {
    const intent = prepareCollection(memory(), source); const other = receipt(crypto.randomUUID());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ item: other })).mockResolvedValueOnce(Response.json({ error: { code: "SUBMISSION_NOT_FOUND", message: "absent" } }, { status: 404 })));
    const result = await readCollectionState(source, intent);
    expect(result.active).toEqual(other); expect(result.submission).toBeNull();
  });
  it("archives the key before clearing the active slot", () => {
    const storage = memory(); const intent = prepareCollection(storage, source);
    archiveCollection(storage, intent);
    expect(storage.getItem(collectionStorageKey)).toBeNull();
    expect(JSON.parse(storage.getItem(collectionArchiveKey)!)).toEqual([intent]);
    expect(prepareCollection(storage, source).key).not.toBe(intent.key);
  });
  it("does not clear the original if archival storage fails", () => {
    const storage = memory(); const intent = prepareCollection(storage, source);
    storage.setItem = () => { throw Error("quota"); };
    expect(() => archiveCollection(storage, intent)).toThrow(); expect(readCollection(storage)).toEqual(intent);
  });
  it("labels acceptance, uncertainty and terminal status independently", () => {
    const s = receipt(crypto.randomUUID()); const d = delivery(s.requestId);
    expect(deliveryLabel(s, null)).toContain("不代表已运行");
    expect(deliveryLabel(s, { ...d, lastIssue: "UNAVAILABLE" })).toContain("待核验");
    expect(deliveryLabel(s, d)).toContain("不代表 Worker 已开始");
    expect(deliveryLabel(s, { ...d, state: "CLOSED", observedStatus: "FAILED" })).toContain("FAILED");
    expect(deliveryLabel(s, { ...d, state: "CLOSED", observedStatus: "COMPLETED" })).toContain("不代表产品已入库");
  });
  it("links only the configured cluster and a verified run identity", () => {
    const s = receipt(crypto.randomUUID()); const d = delivery(s.requestId);
    const cap = CollectionCapabilities.parse({ submissionIntakeEnabled: true, environment: "isolated-acceptance", temporalUi: [{ clusterId: "test", baseUrl: "http://127.0.0.1:8234" }] });
    expect(temporalExecutionUrl(cap,s,d)).toContain(`/workflows/${s.workflowId}/${d.runId}/history`);
    expect(temporalExecutionUrl({ ...cap, temporalUi: [] },s,d)).toBeNull();
    expect(temporalExecutionUrl(cap,s,{ ...d, requestId: crypto.randomUUID() })).toBeNull();
    for (const lastIssue of ["IDENTITY_MISMATCH", "RUN_CHANGED", "CHAIN_CONTINUED"] as const) expect(temporalExecutionUrl(cap,s,{ ...d,lastIssue })).toBeNull();
    expect(() => CollectionCapabilities.parse({ ...cap, temporalUi: [{ clusterId: "test", baseUrl: "javascript:alert(1)" }] })).toThrow();
    expect(() => CollectionCapabilities.parse({ ...cap, temporalUi: [{ clusterId: "test", baseUrl: "https://user:secret@example.com" }] })).toThrow();
  });
});
