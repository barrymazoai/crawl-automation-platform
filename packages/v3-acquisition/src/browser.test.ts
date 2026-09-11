import { afterEach, describe, expect, it, vi } from "vitest";
import { CdpRenderedBrowser } from "./browser.js";
const config = { endpoint: "http://127.0.0.1:19876", instanceId: "instance", sessionId: "s", egressId: "lane/1", allowedOrigins: ["https://www.gnc.com"] };
const url = "https://www.gnc.com/123456.html";
const calls: string[] = [], http: string[] = [];
let navError = false, wrongFrame = false, redirected = false, closeFails = false;
class Socket extends EventTarget {
  static OPEN = 1; readyState = 1;
  constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  emit(method: string, params: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ method, params }) })); }
  send(raw: string) {
    const { id, method, params } = JSON.parse(raw); calls.push(method);
    let result: unknown = {};
    if (method === "Page.getFrameTree") result = { frameTree: { frame: { id: "main" } } };
    if (method === "Page.navigate") {
      this.emit("Fetch.requestPaused", { frameId: "main", requestId: "req", request: { url: redirected ? "https://evil.test/" : params.url } });
      this.emit("Network.responseReceived", { frameId: wrongFrame ? "child" : "main", loaderId: "loader", type: "Document", response: { status: 200, url, mimeType: "text/html" } });
      this.emit("Page.lifecycleEvent", { frameId: "main", loaderId: "loader", name: "load" });
      result = { frameId: "main", loaderId: "loader", ...(navError ? { errorText: "net::ERR_FAILED" } : {}) };
    }
    if (method === "Runtime.evaluate") result = { result: { value: { url, html: "<html>rendered</html>" } } };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result }) })));
  }
  close() { this.readyState = 3; }
}
function setup() {
  calls.length = 0; http.length = 0; navError = wrongFrame = redirected = closeFails = false;
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", vi.fn(async (u: string, init: RequestInit) => {
    http.push(u);
    if (!u.startsWith(config.endpoint + "/json/")) throw Error("No target fetch allowed");
    if (u.endsWith("/version")) return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:19876/devtools/browser/instance" });
    if (u.endsWith("/new?about:blank")) { expect(init.method).toBe("PUT"); return Response.json({ id: "own-tab", webSocketDebuggerUrl: "ws://127.0.0.1:19876/devtools/page/own-tab" }); }
    if (u.endsWith("/close/own-tab")) return new Response("closed", { status: closeFails ? 500 : 200 });
    throw Error("Unexpected CDP call");
  }));
  return new CdpRenderedBrowser(config);
}
afterEach(() => vi.unstubAllGlobals());
describe("dedicated Chrome CDP adapter", () => {
  it("explicit review retention leaves the exact tab open without repeating navigation",async()=>{
    setup();const retained=vi.fn(()=>true);
    const b=new CdpRenderedBrowser(config,false,undefined,retained);
    const page=await b.read(url,new AbortController().signal);
    expect(retained).toHaveBeenCalledWith(page);
    expect(http.some(u=>u.includes("/close/"))).toBe(false);
    expect(calls.filter(c=>c==="Page.navigate")).toHaveLength(1);
  });
  it("a non-review page still closes under the optional retention policy",async()=>{
    setup();const b=new CdpRenderedBrowser(config,false,undefined,()=>false);
    await b.read(url,new AbortController().signal);
    expect(http.at(-1)).toContain("/close/own-tab");
  });
  it("keeps the exact tab alive for site interaction and observes again without navigating",async()=>{
    setup(); let invoked=0;
    const b=new CdpRenderedBrowser(config,false,async(page,tab)=>{
      invoked++; expect(page.targetId).toBe("own-tab");
      expect(http.some(u=>u.includes("/close/"))).toBe(false);
      await tab.activate(); expect((await tab.snapshot()).targetId).toBe("own-tab");
    });
    await b.read(url,new AbortController().signal);
    expect(invoked).toBe(1);expect(calls.filter(c=>c==="Page.navigate")).toHaveLength(1);
    expect(http.at(-1)).toContain("/close/own-tab");
  });
  it("interaction failure closes only the owned tab and does not retry",async()=>{
    setup();const b=new CdpRenderedBrowser(config,false,async()=>{throw Error("hook failed");});
    await expect(b.read(url,new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_UNAVAILABLE");
    expect(calls.filter(c=>c==="Page.navigate")).toHaveLength(1);expect(http.at(-1)).toContain("/close/own-tab");
  });
  it("navigates Chrome, reads rendered DOM and closes only its own tab; no target fetch/DNS", async () => {
    const b = setup(), page = await b.read(url, new AbortController().signal);
    expect(page).toMatchObject({ html: "<html>rendered</html>", status: 200, targetId: "own-tab" });
    expect(calls.filter(c => c === "Page.navigate")).toHaveLength(1);
    expect(http).toHaveLength(3); expect(http[2]).toContain("/close/own-tab");
  });
  it.each(["http://localhost:9222", "http://192.168.0.25:9222", "http://user:pass@127.0.0.1:9222", "http://127.0.0.1:9222/path"])("rejects non-loopback or credential-bearing endpoint %s", endpoint => {
    expect(() => new CdpRenderedBrowser({ ...config, endpoint })).toThrow("SOURCE.BROWSER_CONFIG");
  });
  it("checks the browser instance before opening any tab", async () => {
    setup(); const b = new CdpRenderedBrowser({ ...config, instanceId: "wrong" });
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_INSTANCE_MISMATCH");
    expect(http).toHaveLength(1);
  });
  it("navigation failure is not retried and its tab is closed", async () => {
    const b = setup(); navError = true;
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_NAVIGATION");
    expect(calls.filter(c => c === "Page.navigate")).toHaveLength(1); expect(http.at(-1)).toContain("/close/own-tab");
  });
  it("keeps Chrome's bounded network error symbol for diagnosis", async () => {
    const b = setup(); navError = true;
    await expect(b.read(url, new AbortController().signal)).rejects.toMatchObject({ code: "SOURCE.BROWSER_NAVIGATION", reason: "net::ERR_FAILED" });
  });
  it("does not mistake an iframe response for the main product document", async () => {
    const b = setup(); wrongFrame = true;
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_DOCUMENT_UNVERIFIED");
  });
  it("blocks unexpected main-frame redirects before continuation", async () => {
    const b = setup(); redirected = true;
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_REDIRECT");
    expect(calls).toContain("Fetch.failRequest"); expect(calls).not.toContain("Fetch.continueRequest");
  });
  it("rejects overlapping use instead of sharing a tab; first operation still succeeds", async () => {
    const b = setup(), first = b.read(url, new AbortController().signal);
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_BUSY");
    expect((await first).status).toBe(200);
  });
  it("unknown tab cleanup cannot be reported as completed acquisition", async () => {
    const b = setup(); closeFails = true;
    await expect(b.read(url, new AbortController().signal)).rejects.toThrow("SOURCE.BROWSER_CLEANUP_UNKNOWN");
  });
  it("cancelled or unapproved input does not create a tab", async () => {
    const b = setup(), c = new AbortController(); c.abort();
    await expect(b.read(url, c.signal)).rejects.toThrow();
    await expect(b.read("https://evil.test/a", new AbortController().signal)).rejects.toThrow("SOURCE.ORIGIN_BLOCKED");
    expect(http).toHaveLength(0);
  });
});
