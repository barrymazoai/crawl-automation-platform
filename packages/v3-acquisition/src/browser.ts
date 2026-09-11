import { setTimeout as delay } from "node:timers/promises";
import { permittedUrl } from "./network.js";

export class BrowserError extends Error {
  screenshot?: Uint8Array;
  reason?: string;
  constructor(readonly code: string) { super(code); this.name = "BrowserError"; }
}
export type RenderedPage = { url: string; status: number; contentType: string; html: string;
  browserId: string; targetId: string; screenshot?: Uint8Array };
export interface RenderedBrowser {
  readonly sessionId: string;
  readonly egressId: string;
  read(url: string, signal: AbortSignal): Promise<RenderedPage>;
}
export type CdpBrowserConfig = { endpoint: string; instanceId: string; sessionId: string; egressId: string; allowedOrigins: readonly string[] };
/** Runs while the owned tab is alive; site-specific logic belongs outside this browser. */
export type RenderedInteraction = {
  snapshot(): Promise<RenderedPage>;
  evaluate(expression: string): Promise<unknown>;
  document(): Promise<any>;
  box(nodeId: number): Promise<any>;
  hit(x: number, y: number): Promise<any>;
  geometry(): Promise<any>;
  activate(): Promise<void>;
};
export type RenderedPageInteraction = (page: RenderedPage, tab: RenderedInteraction, signal: AbortSignal) => Promise<void>;
type Message = { id?: number; method?: string; params?: any; result?: any; error?: unknown };

/** A dedicated, already configured host Chrome. No browser launch, route switching or target fetch.
 * Owns only the newly created tab. The operator owns profile/egress isolation and the Chrome process.
 */
export class CdpRenderedBrowser implements RenderedBrowser {
  readonly sessionId: string;
  readonly egressId: string;
  readonly #config: CdpBrowserConfig;
  #busy = false;
  constructor(config: CdpBrowserConfig, private readonly screenshots = false, private readonly interaction?: RenderedPageInteraction,
    private readonly retainForReview?: (page:RenderedPage)=>boolean) {
    let u: URL;
    try { u = new URL(config.endpoint); } catch { throw new BrowserError("SOURCE.BROWSER_CONFIG"); }
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port || u.pathname !== "/" || u.username || u.password || u.search || u.hash ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(config.instanceId) || !config.sessionId || !config.egressId)
      throw new BrowserError("SOURCE.BROWSER_CONFIG");
    if (!config.allowedOrigins.length || config.allowedOrigins.length > 20) throw new BrowserError("SOURCE.BROWSER_CONFIG");
    for (const origin of config.allowedOrigins) if (permittedUrl(origin, [origin]).origin !== origin) throw new BrowserError("SOURCE.BROWSER_CONFIG");
    this.#config = { ...config, endpoint: u.origin, allowedOrigins: [...config.allowedOrigins] };
    this.sessionId = config.sessionId; this.egressId = config.egressId;
  }
  private async control(path: string, method: string, signal: AbortSignal) {
    const r = await fetch(this.#config.endpoint + path, { method, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
    if (!r.ok) throw new BrowserError("SOURCE.BROWSER_UNAVAILABLE");
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const b of r.body!) { size += b.length; if (size > 65536) { await r.body?.cancel().catch(() => {}); throw new BrowserError("SOURCE.BROWSER_PROTOCOL"); } chunks.push(b); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  async preflight(signal: AbortSignal) {
    const v = await this.control("/json/version", "GET", signal);
    const expected = this.#config.endpoint.replace("http:", "ws:") + "/devtools/browser/" + this.#config.instanceId;
    if (v.webSocketDebuggerUrl !== expected) throw new BrowserError("SOURCE.BROWSER_INSTANCE_MISMATCH");
  }
  async read(rawUrl: string, abort: AbortSignal): Promise<RenderedPage> {
    const url = permittedUrl(rawUrl, this.#config.allowedOrigins);
    abort.throwIfAborted();
    if (this.#busy) throw new BrowserError("SOURCE.BROWSER_BUSY");
    this.#busy = true;
    const deadline = new AbortController(), signal = AbortSignal.any([abort, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new BrowserError("SOURCE.BROWSER_TIMEOUT")), this.interaction ? 120000 : 45000);
    let ws: WebSocket | undefined, targetId: string | undefined, failure: unknown, lastPage:RenderedPage|undefined;
    const pending = new Map<number, { resolve: (r: any) => void; reject: (e: unknown) => void }>();
    let nextId = 0, stopped: unknown, redirected = false;
    const stop = (reason: unknown) => { stopped ??= reason; for (const p of pending.values()) p.reject(stopped); pending.clear(); };
    const onAbort = () => { stop(signal.reason); ws?.close(); };
    signal.addEventListener("abort", onAbort, { once: true });
    const send = (method: string, params: Record<string, unknown> = {}): Promise<any> => {
      signal.throwIfAborted(); if (stopped) return Promise.reject(stopped);
      return new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject });
        try { ws!.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); reject(new BrowserError("SOURCE.BROWSER_DISCONNECTED")); }
      });
    };
    try {
      await this.preflight(signal);
      const target = await this.control("/json/new?about:blank", "PUT", signal);
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(target.id ?? "")) throw new BrowserError("SOURCE.BROWSER_PROTOCOL");
      targetId = target.id;
      if (target.webSocketDebuggerUrl !== this.#config.endpoint.replace("http:", "ws:") + "/devtools/page/" + targetId)
        throw new BrowserError("SOURCE.BROWSER_PROTOCOL");
      ws = new WebSocket(target.webSocketDebuggerUrl);
      let frame = "", latestLoader = "";
      const documents = new Map<string, { status: number; url: string; mimeType: string }>();
      const loaded = new Set<string>();
      ws.addEventListener("message", event => {
        let m: Message;
        try { if (String(event.data).length > 16 * 1024 * 1024) throw Error(); m = JSON.parse(String(event.data)); }
        catch { stop(new BrowserError("SOURCE.BROWSER_PROTOCOL")); return; }
        if (m.id !== undefined) {
          const p = pending.get(m.id); pending.delete(m.id);
          if (m.error) p?.reject(new BrowserError("SOURCE.BROWSER_PROTOCOL")); else p?.resolve(m.result ?? {});
        } else if (m.method === "Fetch.requestPaused") {
          const p = m.params;
          const block = p.frameId === frame && p.request.url !== url.href;
          if (block) redirected = true;
          void send(block ? "Fetch.failRequest" : "Fetch.continueRequest", { requestId: p.requestId, ...(block ? { errorReason: "Aborted" } : {}) }).catch(stop);
        } else if (m.method === "Network.responseReceived" && m.params.type === "Document" && m.params.frameId === frame) {
          const p = m.params; latestLoader = p.loaderId; documents.set(p.loaderId, { status: p.response.status, url: p.response.url, mimeType: p.response.mimeType });
        } else if (m.method === "Page.lifecycleEvent" && m.params.frameId === frame && m.params.name === "load") loaded.add(m.params.loaderId);
      });
      ws.addEventListener("error", () => stop(new BrowserError("SOURCE.BROWSER_DISCONNECTED")));
      ws.addEventListener("close", () => stop(new BrowserError("SOURCE.BROWSER_DISCONNECTED")));
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", cancel); ws!.removeEventListener("error", error); ws!.removeEventListener("close", error); };
        const error = () => { done(); reject(new BrowserError("SOURCE.BROWSER_DISCONNECTED")); };
        const cancel = () => { done(); reject(signal.reason); };
        ws!.addEventListener("open", () => { done(); resolve(); }, { once: true });
        ws!.addEventListener("error", error, { once: true }); ws!.addEventListener("close", error, { once: true });
        signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
      });
      await send("Page.enable"); await send("Network.enable"); await send("Page.setLifecycleEventsEnabled", { enabled: true });
      frame = (await send("Page.getFrameTree")).frameTree.frame.id;
      await send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
      const nav = await send("Page.navigate", { url: url.href });
      if (nav.errorText || !nav.loaderId) {
        const error = new BrowserError(redirected ? "SOURCE.BROWSER_REDIRECT" : "SOURCE.BROWSER_NAVIGATION");
        // Keep Chrome's bounded error symbol, never a raw provider message/URL/credential.
        error.reason = typeof nav.errorText === "string" && /^net::ERR_[A-Z_]+$/.test(nav.errorText) ? nav.errorText : "DOCUMENT_LOADER_MISSING";
        throw error;
      }
      while (!loaded.has(nav.loaderId)) {
        if (stopped) throw stopped; if (redirected) throw new BrowserError("SOURCE.BROWSER_REDIRECT");
        await delay(100, undefined, { signal });
      }
      await delay(1500, undefined, { signal }); // same render-settle interval as the old host Chrome implementation
      if (redirected) throw new BrowserError("SOURCE.BROWSER_REDIRECT");
      const snapshotPage = async (): Promise<RenderedPage> => {
      if (redirected) throw new BrowserError("SOURCE.BROWSER_REDIRECT");
      const doc = documents.get(latestLoader || nav.loaderId);
      if (!doc || doc.url !== url.href) throw new BrowserError("SOURCE.BROWSER_DOCUMENT_UNVERIFIED");
      const snapshot = await send("Runtime.evaluate", { expression: `(() => { const html = document.documentElement.outerHTML; return { url: location.href, html: html.length > 2097152 ? null : html }; })()`, returnByValue: true });
      const value = snapshot.result?.value;
      if (snapshot.exceptionDetails || !value || value.url !== url.href || typeof value.html !== "string" || Buffer.byteLength(value.html) > 2097152)
        throw new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
      const page: RenderedPage = { url: value.url, status: doc.status, contentType: doc.mimeType, html: value.html, browserId: this.#config.instanceId, targetId: targetId! };
      if (this.screenshots) {
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        if (typeof shot.data !== "string" || shot.data.length > 12 * 1024 * 1024) throw new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
        page.screenshot = Buffer.from(shot.data, "base64");
      }
      signal.throwIfAborted(); lastPage=page; return page;
      };
      const initial = await snapshotPage();
      if (!this.interaction) return initial;
      await this.interaction(initial, {
        snapshot: snapshotPage,
        document: async () => (await send("DOM.getDocument", {depth:-1,pierce:true})).root,
        box: async nodeId => (await send("DOM.getBoxModel", {nodeId})).model,
        hit: async (x,y) => send("DOM.getNodeForLocation", {x:Math.round(x),y:Math.round(y)}),
        geometry: async () => {
          const window=await send("Browser.getWindowForTarget", {targetId});
          const layout=await send("Page.getLayoutMetrics");
          return {bounds:window.bounds,layout:layout.cssLayoutViewport,visual:layout.cssVisualViewport};
        },
        evaluate: async expression => {
          const result = await send("Runtime.evaluate", { expression, returnByValue: true });
          if (result.exceptionDetails) {
            const error = new BrowserError("SOURCE.BROWSER_SNAPSHOT_INVALID");
            const name = result.exceptionDetails.exception?.className;
            error.reason = typeof name === "string" && /^[A-Za-z]{1,40}Error$/.test(name) ? name : "EVALUATION_EXCEPTION";
            const description=result.exceptionDetails.exception?.description;
            if (typeof description === "string" && /^(TypeError|ReferenceError|SyntaxError):/.test(description))
              error.reason=description.split("\n")[0]!.slice(0,240);
            throw error;
          }
          return result.result?.value;
        },
        activate: async () => { await send("Page.bringToFront"); },
      }, signal);
      return await snapshotPage();
    } catch (e) {
      failure = e;
      if (this.screenshots && e instanceof BrowserError && ws?.readyState === WebSocket.OPEN && !signal.aborted && !stopped) {
        try {
          const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
          if (typeof shot.data === "string" && shot.data.length <= 12 * 1024 * 1024) e.screenshot = Buffer.from(shot.data, "base64");
        } catch { /* Diagnostic failure does not replace the navigation error. */ }
      }
      if (abort.aborted) throw abort.reason;
      if (signal.aborted) throw new BrowserError("SOURCE.BROWSER_TIMEOUT");
      if (e instanceof BrowserError) throw e;
      throw new BrowserError("SOURCE.BROWSER_UNAVAILABLE");
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", onAbort);
      stop(new BrowserError("SOURCE.BROWSER_DISCONNECTED")); ws?.close();
      try {
        if (targetId && !(lastPage && this.retainForReview?.(lastPage))) {
          const r = await fetch(this.#config.endpoint + "/json/close/" + targetId, { redirect: "error", signal: AbortSignal.timeout(5000) });
          if (!r.ok) throw Error(); await r.body?.cancel();
        }
      } catch { if (!failure) throw new BrowserError("SOURCE.BROWSER_CLEANUP_UNKNOWN"); }
      finally { this.#busy = false; }
    }
  }
}
