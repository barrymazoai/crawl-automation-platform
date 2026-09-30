import { validateHeaderValue } from "node:http";
import { z } from "zod";
import { BrowserError, CdpRenderedBrowser, type CdpBrowserConfig } from "./browser.js";
import { permittedUrl } from "./network.js";

/** Private deployment result. Never serialize into activity inputs/results, Review or artifact evidence. */
export type FileSessionSnapshot = { sessionId: string; egressId: string; browserId: string;
  resources: { url: string; expiresAt: string; headers: Record<string, string> }[] };
export interface FileSessionExporter {
  readonly sessionId: string;
  readonly egressId: string;
  exportFiles(urls: readonly string[], pageUrl: string, expiresAt: string, signal: AbortSignal): Promise<FileSessionSnapshot>;
}
const cookiesSchema = z.array(z.object({ name: z.string().min(1).max(1024), value: z.string().max(8192),
  domain: z.string().min(1), path: z.string().startsWith("/"), expires: z.number().finite(), session: z.boolean(),
  partitionKey: z.unknown().optional(), partitionKeyOpaque: z.boolean().optional() })).max(1000);
const fail = () => new BrowserError("SOURCE.BROWSER_SESSION_INVALID");
const MAX_AGE = 15 * 60 * 1000;

/** Same-origin only cookie export; cross-origin images are explicitly anonymous.
 * Partitioned cookies are unsupported rather than stripped of their isolation context.
 * This is not a browser fingerprint clone or proof that a site will accept HTTP image downloads.
 */
export class CdpFileSession implements FileSessionExporter {
  readonly sessionId: string;
  readonly egressId: string;
  private readonly browser: CdpRenderedBrowser;
  private readonly config: CdpBrowserConfig;
  private busy = false;
  constructor(config: CdpBrowserConfig) {
    this.browser = new CdpRenderedBrowser(config); // validates loopback and exact browser instance configuration
    this.config = structuredClone(config); this.sessionId = config.sessionId; this.egressId = config.egressId;
  }
  async exportFiles(rawUrls: readonly string[], rawPage: string, expiresAt: string, abort: AbortSignal): Promise<FileSessionSnapshot> {
    abort.throwIfAborted();
    if (this.busy) throw new BrowserError("SOURCE.BROWSER_BUSY");
    if (rawUrls.length > 100 || !z.iso.datetime().safeParse(expiresAt).success) throw fail();
    const end = Math.min(Date.parse(expiresAt), Date.now() + MAX_AGE);
    if (end <= Date.now()) throw fail();
    const urls = rawUrls.map(u => permittedUrl(u, this.config.allowedOrigins));
    const page = permittedUrl(rawPage, this.config.allowedOrigins);
    this.busy = true;
    const signal = AbortSignal.any([abort, AbortSignal.timeout(30000)]);
    const endpoint = new URL(this.config.endpoint).origin;
    let ws: WebSocket | undefined, targetId: string | undefined, stopped = false, nextId = 0;
    const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
    const stop = () => { stopped = true; for (const p of pending.values()) p.reject(fail()); pending.clear(); };
    const cancel = () => { stop(); ws?.close(); };
    signal.addEventListener("abort", cancel, { once: true });
    const control = async (path: string, method: string) => {
      const r = await fetch(endpoint + path, { method, redirect: "error", signal });
      if (!r.ok) { await r.body?.cancel(); throw fail(); }
      const parts: Uint8Array[] = []; let size = 0;
      for await (const b of r.body!) { size += b.length; if (size > 65536) throw fail(); parts.push(b); }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    };
    const send = (method: string, params: object = {}): Promise<any> => {
      signal.throwIfAborted(); if (stopped) return Promise.reject(fail());
      return new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject });
        try { ws!.send(JSON.stringify({ id, method, params })); } catch { pending.delete(id); reject(fail()); }
      });
    };
    try {
      await this.browser.preflight(signal);
      const target = await control("/json/new?about:blank", "PUT");
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(target.id ?? "")) throw fail();
      targetId = target.id;
      if (target.webSocketDebuggerUrl !== endpoint.replace("http:", "ws:") + "/devtools/page/" + targetId) throw fail();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.addEventListener("message", event => {
        try {
          if (String(event.data).length > 2 * 1024 * 1024) throw fail();
          const m = JSON.parse(String(event.data)), p = pending.get(m.id); if (!p) return;
          pending.delete(m.id); if (m.error) p.reject(fail()); else p.resolve(m.result ?? {});
        } catch { stop(); }
      });
      ws.addEventListener("error", stop); ws.addEventListener("close", stop);
      await new Promise<void>((resolve, reject) => {
        const done = () => { signal.removeEventListener("abort", error); ws!.removeEventListener("error", error); ws!.removeEventListener("close", error); };
        const error = () => { done(); reject(fail()); };
        ws!.addEventListener("open", () => { done(); resolve(); }, { once: true });
        ws!.addEventListener("error", error, { once: true }); ws!.addEventListener("close", error, { once: true });
        signal.addEventListener("abort", error, { once: true }); if (signal.aborted) error();
      });
      const { userAgent } = await send("Browser.getVersion");
      if (typeof userAgent !== "string" || !userAgent || userAgent.length > 8192) throw fail();
      validateHeaderValue("user-agent", userAgent);
      const resources: FileSessionSnapshot["resources"] = [];
      for (const url of urls) {
        let expiry = end;
        const headers: Record<string, string> = { "user-agent": userAgent, accept: "image/*" };
        if (url.origin === page.origin) {
          const { cookies } = await send("Network.getCookies", { urls: [url.href] });
          const parsed = cookiesSchema.parse(cookies);
          const matching = parsed.filter(c => {
            const domain = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
            const domainMatch = url.hostname === domain || (c.domain.startsWith(".") && url.hostname.endsWith("." + domain));
            const pathMatch = url.pathname === c.path || (url.pathname.startsWith(c.path) && (c.path.endsWith("/") || url.pathname[c.path.length] === "/"));
            return domainMatch && pathMatch && (c.session || c.expires * 1000 > Date.now());
          });
          for (const c of matching) {
            if (c.partitionKey !== undefined || c.partitionKeyOpaque || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(c.name) ||
              !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/.test(c.value)) throw fail();
            if (!c.session) expiry = Math.min(expiry, c.expires * 1000);
          }
          // Longest cookie path first; equal-path order remains the browser-returned order.
          const cookie = matching.sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join("; ");
          if (cookie.length > 8192) throw fail();
          if (cookie) headers.cookie = cookie;
          headers.referer = page.href;
        }
        resources.push({ url: url.href, expiresAt: new Date(expiry).toISOString(), headers });
      }
      await this.browser.preflight(signal); // reject an instance replacement during export
      signal.throwIfAborted();
      if (resources.some(r => Date.parse(r.expiresAt) <= Date.now())) throw fail();
      return { sessionId: this.sessionId, egressId: this.egressId, browserId: this.config.instanceId, resources };
    } catch {
      // Do not leak schema input, cookie contents, CDP responses or private endpoint in error messages.
      throw fail();
    } finally {
      signal.removeEventListener("abort", cancel); stop(); ws?.close();
      try {
        if (targetId) {
          const r = await fetch(endpoint + "/json/close/" + targetId, { redirect: "error", signal: AbortSignal.timeout(5000) });
          if (!r.ok) throw fail(); await r.body?.cancel();
        }
      } catch { throw new BrowserError("SOURCE.BROWSER_CLEANUP_UNKNOWN"); }
      finally { this.busy = false; }
    }
  }
}
