// Explicit synthetic CDP fixture for Temporal tests. NOT a real browser or production fallback.
// Real Chrome behavior has a separate Mac mini probe. Only the test preload imports this file.
import https from "node:https";
const request = https.request, originalFetch = globalThis.fetch;
const base = "http://127.0.0.1:19876", targets = new Set();
let nextTarget = 0;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith(base + "/json/")) return originalFetch(url, options);
  if (url === base + "/json/version") return Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:19876/devtools/browser/fixture" });
  if (url === base + "/json/new?about:blank" && options.method === "PUT") {
    const id = `fixture-${++nextTarget}`; targets.add(id);
    return Response.json({ id, webSocketDebuggerUrl: `ws://127.0.0.1:19876/devtools/page/${id}` });
  }
  const id = String(url).split("/").at(-1);
  if (String(url).startsWith(base + "/json/close/") && targets.delete(id)) return new Response("closed");
  return new Response("fixture refused", { status: 400 });
};
globalThis.WebSocket = class extends EventTarget {
  static OPEN = 1; readyState = 1; document = null;
  constructor(url) {
    super(); if (!targets.has(new URL(url).pathname.split("/").at(-1))) throw Error("Unknown test tab");
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  async send(raw) {
    const { id, method, params } = JSON.parse(raw); let result = {};
    try {
      if (method === "Page.getFrameTree") result = { frameTree: { frame: { id: "main" } } };
      if (method === "Page.navigate") {
        if (process.env.V3_TEST_DENY_SOURCE === "true") throw Error("Test source denied");
        const url = new URL(params.url); if (url.hostname !== "www.gnc.com") throw Error("Unexpected test origin");
        this.document = await new Promise((resolve, reject) => {
          const req = request({ hostname: "127.0.0.1", port: Number(process.env.V3_TEST_S3_PORT), servername: "www.gnc.com", path: url.pathname + url.search,
            method: "GET", headers: { host: "www.gnc.com" }, rejectUnauthorized: true }, res => {
            const chunks = []; res.on("data", b => chunks.push(b)); res.on("error", reject);
            res.on("end", () => resolve({ status: res.statusCode, html: Buffer.concat(chunks).toString(), url: params.url }));
          }); req.on("error", reject); req.end();
        });
        this.emit({ method: "Network.responseReceived", params: { type: "Document", frameId: "main", loaderId: "loader", response: { status: this.document.status, url: params.url, mimeType: "text/html" } } });
        this.emit({ method: "Page.lifecycleEvent", params: { frameId: "main", loaderId: "loader", name: "load" } });
        result = { frameId: "main", loaderId: "loader" };
      }
      if (method === "Runtime.evaluate") result = { result: { value: this.document } };
      this.emit({ id, result });
    } catch { this.emit({ id, error: { message: "Synthetic browser failure" } }); }
  }
  close() { this.readyState = 3; }
};
