import { afterEach, expect, it, vi } from "vitest";
import { CdpFileSession } from "./browser-session.js";
const config = { endpoint: "http://127.0.0.1:19876", instanceId: "instance", sessionId: "s", egressId: "lane/1",
  allowedOrigins: ["https://www.gnc.com", "https://cdn.example"] };
const page = "https://www.gnc.com/123456.html", url = "https://www.gnc.com/labels/a.png";
const cookie = { name: "session", value: "synthetic-only", domain: "www.gnc.com", path: "/", expires: -1, session: true };
let jar: unknown[], badInstance: boolean, badClose: boolean;
const calls: { method: string; params: any }[] = [], http: string[] = [];
class Socket extends EventTarget {
  constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw); calls.push({ method, params });
    const result = method === "Browser.getVersion" ? { userAgent: "SyntheticChrome/1" } : { cookies: jar };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) })));
  }
  close() {}
}
function setup() {
  jar = [cookie]; calls.length = http.length = 0; badInstance = badClose = false;
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    http.push(raw); if (!raw.startsWith(config.endpoint + "/json/")) throw Error("No external fetch");
    if (raw.endsWith("/version")) return Response.json({ webSocketDebuggerUrl: `ws://127.0.0.1:19876/devtools/browser/${badInstance ? "wrong" : "instance"}` });
    if (raw.endsWith("/new?about:blank")) return Response.json({ id: "own", webSocketDebuggerUrl: "ws://127.0.0.1:19876/devtools/page/own" });
    if (raw.endsWith("/close/own")) return new Response("closed", { status: badClose ? 500 : 200 });
    throw Error("Unexpected control request");
  }));
  return new CdpFileSession(config);
}
const expiry = () => new Date(Date.now() + 3600000).toISOString();
const signal = () => new AbortController().signal;
afterEach(() => vi.unstubAllGlobals());
it("exports per-URL private headers without navigation and closes only its own blank tab", async () => {
  const b = setup(), before = Date.now(), result = await b.exportFiles([url, "https://cdn.example/a.png"], page, expiry(), signal());
  expect(result).toMatchObject({ sessionId: "s", egressId: "lane/1", browserId: "instance" });
  expect(result.resources[0]!.headers).toEqual({ cookie: "session=synthetic-only", referer: page, "user-agent": "SyntheticChrome/1", accept: "image/*" });
  expect(result.resources[1]!.headers).toEqual({ "user-agent": "SyntheticChrome/1", accept: "image/*" });
  expect(Date.parse(result.resources[0]!.expiresAt)).toBeLessThanOrEqual(before + 900100);
  expect(calls).toEqual([{ method: "Browser.getVersion", params: {} }, { method: "Network.getCookies", params: { urls: [url] } }]);
  expect(http.at(-1)).toBe(config.endpoint + "/json/close/own");
});
it("filters host-only, domain, path and expired cookies and caps expiry to the earliest cookie", async () => {
  const b = setup(), end = Math.floor(Date.now() / 1000) + 120;
  jar = [cookie, { ...cookie, name: "long", path: "/labels", expires: end, session: false },
    { ...cookie, name: "parent", domain: ".gnc.com" }, { ...cookie, name: "host", domain: "gnc.com" },
    { ...cookie, name: "other", domain: "notgnc.com" }, { ...cookie, name: "path", path: "/label" },
    { ...cookie, name: "expired", expires: 1, session: false }];
  const r = (await b.exportFiles([url], page, expiry(), signal())).resources[0]!;
  expect(r.headers.cookie).toBe("long=synthetic-only; session=synthetic-only; parent=synthetic-only");
  expect(Date.parse(r.expiresAt)).toBe(end * 1000);
});
it.each([{ partitionKey: { topLevelSite: "https://www.gnc.com" } }, { partitionKeyOpaque: true },
  { value: "secret; injected=1" }, { name: "secret\r\n" }, { expires: null }])("rejects unsupported/malformed cookie without exposing its value: %j", async change => {
  const b = setup(); jar = [{ ...cookie, ...change }];
  await expect(b.exportFiles([url], page, expiry(), signal())).rejects.toThrow("SOURCE.BROWSER_SESSION_INVALID");
  expect(http.at(-1)).toContain("/close/own");
});
it("does not export cookies for a foreign origin even if the browser jar contains them", async () => {
  const b = setup(); jar = [{ ...cookie, domain: "cdn.example" }];
  const r = await b.exportFiles(["https://cdn.example/a.png"], page, expiry(), signal());
  expect(r.resources[0]!.headers.cookie).toBeUndefined(); expect(calls).toHaveLength(1);
});
it("rejects wrong browser instance before creating a target", async () => {
  const b = setup(); badInstance = true;
  await expect(b.exportFiles([url], page, expiry(), signal())).rejects.toThrow("SOURCE.BROWSER_SESSION_INVALID");
  expect(http).toHaveLength(1); expect(calls).toHaveLength(0);
});
it("cleanup failure never returns a successful grant", async () => {
  const b = setup(); badClose = true;
  await expect(b.exportFiles([url], page, expiry(), signal())).rejects.toThrow("SOURCE.BROWSER_CLEANUP_UNKNOWN");
});
it("rejects expired, cancelled and unapproved inputs before CDP", async () => {
  const b = setup(), c = new AbortController(); c.abort();
  await expect(b.exportFiles([url], page, expiry(), c.signal)).rejects.toThrow();
  await expect(b.exportFiles([url], page, "2000-01-01T00:00:00Z", signal())).rejects.toThrow();
  await expect(b.exportFiles(["https://evil.example/a"], page, expiry(), signal())).rejects.toThrow();
  expect(http).toHaveLength(0);
});
it("rejects concurrent exports without interfering with the first", async () => {
  const b = setup(), first = b.exportFiles([url], page, expiry(), signal());
  await expect(b.exportFiles([url], page, expiry(), signal())).rejects.toThrow("SOURCE.BROWSER_BUSY");
  expect((await first).resources).toHaveLength(1);
});
