import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpRoute, type FileTransport, type Response, type Address } from "@crawl-automation/v3-acquisition";
import type { GncCaptureInput } from "@crawl-automation/v3-contracts";
import { GncHttpReader, GNC_HTTP_POLICY } from "./gnc-http.js";
import { GncAdapter } from "./gnc.js";
const input: GncCaptureInput = { kind: "product", requestId: "req", operationId: "op", brandId: "brand", sourceId: "source", binding: { sessionId: "session", egressId: "host/1" }, url: "https://www.gnc.com/123456.html", sku: "123456" };
const html = '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"Test"}</script><div id="productIngredientsAccordionContent">Ingredients: cellulose</div>';
const signal = () => new AbortController().signal;
function response(overrides: Partial<Response> = {}): Response {
  return { status: 200, headers: { "content-type": "text/html" }, body: (async function* () { yield Buffer.from(html); })(), close: vi.fn(), ...overrides };
}
function harness(r = response()) {
  const get = vi.fn<FileTransport["get"]>().mockResolvedValue(r);
  const transport = { egressId: "host/1", get };
  const route = createHttpRoute({ routeId: "r", version: "1", egressId: "host/1", mode: "host", managed: false }, { hostClient: transport });
  const dns = { resolve: vi.fn(async (): Promise<Address[]> => [{ address: "8.8.8.8", family: 4 }]) };
  const grant = { input: structuredClone(input), expiresAt: new Date(Date.now() + 60000).toISOString(), headers: { cookie: "session-canary" } };
  const reader = new GncHttpReader(route, [grant], dns);
  return { reader, get, transport, route, dns, grant, r };
}
afterEach(() => vi.useRealTimers());
describe("GNC bounded HTTP reader", () => {
  it("proxy-owned resolution does not consult fake-IP or unavailable client DNS", async () => {
    const h = harness();
    const route = { ...h.route, transport: { ...h.transport, targetResolution: "proxy" as const } };
    h.dns.resolve.mockRejectedValue(new Error("DNS unavailable"));
    const reader = new GncHttpReader(route, [h.grant], h.dns);
    await reader.read(input, signal());
    expect(h.dns.resolve).not.toHaveBeenCalled();
    expect(h.get.mock.calls[0]?.[1]).toBeUndefined();
    expect(h.get.mock.calls[0]?.[0].hostname).toBe("www.gnc.com");
  });
  it("connects injected network to GNC parser with original evidence", async () => {
    const h = harness(); const result = await new GncAdapter(h.reader).capture(input, signal());
    expect(result.data).toMatchObject({ sku: "123456", factsHtml: '<div id="productIngredientsAccordionContent">Ingredients: cellulose</div>' });
    expect(h.get).toHaveBeenCalledTimes(1); expect(h.r.close).toHaveBeenCalledTimes(1);
    expect(h.get.mock.calls[0]?.[1]).toEqual({ address: "8.8.8.8", family: 4 });
    expect(JSON.stringify(result)).not.toContain("session-canary");
    expect(result.network).toEqual(h.route.selection);
  });
  it("exact grant rejects altered Brand, source, operation, SKU and session before DNS", async () => {
    const h = harness();
    for (const patch of [{ brandId: "other" }, { sourceId: "other" }, { operationId: "other" }, { binding: { sessionId: "other", egressId: "host/1" } }, { url: "https://www.gnc.com/234567.html", sku: "234567" }])
      await expect(h.reader.read({ ...input, ...patch }, signal())).rejects.toThrow("GNC.SESSION_CONFLICT");
    expect(h.dns.resolve).not.toHaveBeenCalled(); expect(h.get).not.toHaveBeenCalled();
  });
  it("snapshots grants and forbids duplicate operation IDs/header injection", () => {
    const h = harness();
    expect(() => new GncHttpReader(h.route, [h.grant, h.grant])).toThrow("NETWORK.CONFIG_INVALID");
    expect(() => new GncHttpReader(h.route, [{ ...h.grant, headers: { host: "evil" } }])).toThrow("NETWORK.CONFIG_INVALID");
    h.grant.input.brandId = "changed"; h.grant.headers.cookie = "changed";
    return h.reader.read(input, signal()).then(() => expect(h.get.mock.calls[0]?.[2].cookie).toBe("session-canary"));
  });
  it("expired grant, changed egress and private DNS never dial", async () => {
    const h = harness();
    const expired = new GncHttpReader(h.route, [{ ...h.grant, expiresAt: new Date(0).toISOString() }], h.dns);
    await expect(expired.read(input, signal())).rejects.toThrow("GNC.SESSION_EXPIRED");
    h.dns.resolve.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(h.reader.read(input, signal())).rejects.toThrow("SOURCE.SSRF_BLOCKED");
    h.transport.egressId = "changed";
    await expect(h.reader.read(input, signal())).rejects.toThrow("NETWORK.ROUTE_MISMATCH"); expect(h.get).not.toHaveBeenCalled();
  });
  it.each([
    [302, "GNC.REDIRECT_UNVERIFIED"], [403, "GNC.ACCESS_CHALLENGE"], [429, "GNC.ACCESS_CHALLENGE"],
    [404, "GNC.NOT_FOUND"], [500, "GNC.HTTP_STATUS"],
  ])("closes HTTP %s, no redirect/fallback/retry", async (status, code) => {
    const r = response({ status }); const h = harness(r);
    await expect(h.reader.read(input, signal())).rejects.toThrow(code);
    expect(h.get).toHaveBeenCalledTimes(1); expect(r.close).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ "content-type": "application/pdf" }, "GNC.NOT_HTML"],
    [{ "content-encoding": "gzip" }, "GNC.ENCODING"],
    [{ "content-length": "abc" }, "GNC.BODY_INTEGRITY"],
    [{ "content-length": "1" }, "GNC.BODY_INTEGRITY"],
    [{ "content-length": "999999999" }, "GNC.PAGE_LIMIT"],
  ])("rejects invalid metadata/body: %j", async (headers, code) => {
    const r = response({ headers: { "content-type": "text/html", ...headers } }); const h = harness(r);
    await expect(h.reader.read(input, signal())).rejects.toThrow(code); expect(r.close).toHaveBeenCalledTimes(1);
  });
  it("caps streamed body without declared length, no truncation success", async () => {
    const r = response({ body: (async function* () { yield Buffer.alloc(GNC_HTTP_POLICY.maxBytes); yield Buffer.from("x"); throw Error("unreachable"); })() });
    await expect(harness(r).reader.read(input, signal())).rejects.toThrow("GNC.PAGE_LIMIT"); expect(r.close).toHaveBeenCalledTimes(1);
  });
  it("redacts unexpected provider errors", async () => {
    const h = harness(); h.get.mockRejectedValue(new Error("https://user:secret@proxy/"));
    await expect(h.reader.read(input, signal())).rejects.toThrow(/^SOURCE.NETWORK_UNAVAILABLE$/);
  });
  it("aborts stalled body, closes response and preserves caller cancellation", async () => {
    const r = response({ body: { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) } });
    const h = harness(r), c = new AbortController(); const pending = h.reader.read(input, c.signal);
    const assertion = expect(pending).rejects.toThrow("caller cancelled");
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(1)); c.abort(new Error("caller cancelled"));
    await assertion; expect(r.close).toHaveBeenCalledTimes(1);
  });
  it("deadline covers DNS stalls without requesting a page", async () => {
    vi.useFakeTimers(); const h = harness(); h.dns.resolve.mockReturnValue(new Promise(() => {}));
    const pending = expect(h.reader.read(input, signal())).rejects.toThrow("NETWORK.TIMEOUT");
    await vi.advanceTimersByTimeAsync(GNC_HTTP_POLICY.timeoutMs + 1); await pending; expect(h.get).not.toHaveBeenCalled();
  });
  it("closes a late response after cancellation", async () => {
    const h = harness(), c = new AbortController(); let resolve!: (r: Response) => void;
    h.get.mockImplementation(() => new Promise(r => { resolve = r; }));
    const pending = expect(h.reader.read(input, c.signal)).rejects.toThrow("cancel");
    await vi.waitFor(() => expect(h.get).toHaveBeenCalledTimes(1)); c.abort(new Error("cancel")); await pending;
    const late = response(); resolve(late); await vi.waitFor(() => expect(late.close).toHaveBeenCalledTimes(1));
  });
  it("concurrent operations keep separate input and cookie binding", async () => {
    const h = harness(); const second = { ...input, operationId: "op-2", binding: { ...input.binding, sessionId: "s-2" } };
    h.get.mockImplementation(async () => response());
    const reader = new GncHttpReader(h.route, [h.grant, { input: second, expiresAt: h.grant.expiresAt, headers: { cookie: "second" } }], h.dns);
    const results = await Promise.all([reader.read(input, signal()), reader.read(second, signal())]);
    expect(results.map(r => r.operationId)).toEqual(["op", "op-2"]);
    expect(h.get.mock.calls.map(c => c[2].cookie)).toEqual(["session-canary", "second"]);
  });
});
