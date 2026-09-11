import { request } from "node:https";
import { z } from "zod";
import { ScraperApiRouteSchema, type NetworkCapability } from "@crawl-automation/v3-contracts";
import { permittedUrl } from "./network.js";
import type { Address, FileTransport, Response } from "./ports.js";
import { abortable } from "./core.js";

export class ScraperApiError extends Error {
  constructor(readonly code: "SCRAPERAPI.CONFIG_INVALID" | "SCRAPERAPI.AUTH" | "SCRAPERAPI.THROTTLED" | "SCRAPERAPI.PROVIDER_FAILURE" | "SCRAPERAPI.EXECUTION_UNKNOWN" | "SCRAPERAPI.REDIRECT_UNVERIFIED" | "SCRAPERAPI.CAPABILITY_UNAVAILABLE") { super(code); this.name = "ScraperApiError"; }
}
const PrivateConfig = z.strictObject({ apiKey: z.string().min(8).max(512).regex(/^[A-Za-z0-9_-]+$/),
  allowedOrigins: z.array(z.string().url()).min(1).max(32) });
/** Inject only from a trusted composition root; tasks cannot select a credential destination. */
export type ScraperApiRequestPort = (url: URL, signal: AbortSignal) => Promise<Response>;
const httpsOnce: ScraperApiRequestPort = async (url, signal) => new Promise((resolve, reject) => {
  // No automatic redirects, retries, external proxy discovery or raw error forwarding.
  const req = request(url, { method: "GET", signal, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384,
    headers: { accept: "*/*", "accept-encoding": "identity" } }, res => {
    const headers: Response["headers"] = {};
    for (const key of ["content-type", "content-length", "content-encoding", "location", "sa-final-url", "sa-credit-cost"]) {
      const v = res.headers[key]; headers[key] = Array.isArray(v) ? v.join(",") : v;
    }
    resolve({ status: res.statusCode ?? 0, headers, body: res, close: () => { res.destroy(); req.destroy(); } });
  });
  req.on("error", () => reject(new ScraperApiError("SCRAPERAPI.EXECUTION_UNKNOWN"))); req.end();
});

/** A request provider, NOT a persistent interactive browser. Session is a provider hint, not IP proof.
 * The provider may retry internally (documented up to 60s); this adapter submits once, never rotates
 * a session or escalates premium options. Caller must retain execution intent before invoking get(). */
export class ScraperApiTransport implements FileTransport {
  readonly targetResolution = "proxy" as const;
  readonly selection: z.infer<typeof ScraperApiRouteSchema>;
  readonly capabilities: readonly NetworkCapability[];
  readonly policy = Object.freeze({ applicationAttempts: 1, providerAttempts: "provider-managed", timeoutMs: 70000,
    redirects: 0, cookieForwarding: false, credentialForwarding: false, premiumEscalation: false });
  readonly #private: z.infer<typeof PrivateConfig>;
  get egressId() { return this.selection.egressId; }
  constructor(route: unknown, privateConfig: unknown, private readonly send: ScraperApiRequestPort = httpsOnce) {
    const r = ScraperApiRouteSchema.safeParse(route), c = PrivateConfig.safeParse(privateConfig);
    if (!r.success || !c.success) throw new ScraperApiError("SCRAPERAPI.CONFIG_INVALID");
    for (const origin of c.data.allowedOrigins) {
      try { const u = permittedUrl(origin, [origin]); if (u.href !== `${u.origin}/`) throw Error(); }
      catch { throw new ScraperApiError("SCRAPERAPI.CONFIG_INVALID"); }
    }
    this.selection = Object.freeze(r.data); this.#private = c.data;
    this.capabilities = Object.freeze(r.data.responseMode === "binary" ? ["http", "binary"] : r.data.responseMode === "rendered-html" ? ["http", "rendered-html"] : ["http"]);
  }
  async get(target: URL, address: Address | undefined, headers: Readonly<Record<string, string>>, outer: AbortSignal): Promise<Response> {
    permittedUrl(target.href, this.#private.allowedOrigins);
    if (address !== undefined || Object.keys(headers).some(k => k.toLowerCase() !== "accept") || Object.values(headers).some(v => typeof v !== "string" || /[\r\n\0]/.test(v)))
      throw new ScraperApiError("SCRAPERAPI.CONFIG_INVALID");
    outer.throwIfAborted();
    const url = new URL("https://api.scraperapi.com/");
    url.searchParams.set("api_key", this.#private.apiKey);
    url.searchParams.set("country_code", this.selection.countryCode);
    url.searchParams.set("follow_redirect", "false");
    if (this.selection.sessionNumber !== null) url.searchParams.set("session_number", String(this.selection.sessionNumber));
    if (this.selection.responseMode === "rendered-html") url.searchParams.set("render", "true");
    if (this.selection.responseMode === "binary") url.searchParams.set("binary_target", "true");
    // Last parameter prevents target query names from being interpreted as provider settings.
    url.searchParams.set("url", target.href);
    const timeout = AbortSignal.timeout(this.policy.timeoutMs), signal = AbortSignal.any([outer, timeout]);
    let response: Response | undefined;
    try {
      const saved = await abortable<Response>(this.send(url, signal).then(r => { if (signal.aborted) { r.close(); signal.throwIfAborted(); } return r; }), signal);
      response = saved; signal.throwIfAborted();
      if (response.status === 401) throw new ScraperApiError("SCRAPERAPI.AUTH");
      if (response.status === 429) throw new ScraperApiError("SCRAPERAPI.THROTTLED");
      if (response.status >= 300 && response.status < 400) throw new ScraperApiError("SCRAPERAPI.REDIRECT_UNVERIFIED");
      if (![200, 404, 410].includes(response.status)) throw new ScraperApiError("SCRAPERAPI.PROVIDER_FAILURE");
      const final = response.headers["sa-final-url"];
      if (final && new URL(final).href !== target.href) throw new ScraperApiError("SCRAPERAPI.REDIRECT_UNVERIFIED");
      // Only data-plane headers escape. Provider endpoint/key, set-cookie and redirects never do.
      const safeHeaders = Object.fromEntries(["content-type", "content-length", "content-encoding"].map(k => [k, response!.headers[k]]));
      let closed = false;
      const close = () => { if (!closed) { closed = true; signal.removeEventListener("abort", close); saved.close(); } };
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) close();
      const body = (async function* () {
        const iterator = saved.body[Symbol.asyncIterator]();
        try {
          while (true) {
            signal.throwIfAborted();
            const chunk = await abortable(Promise.resolve(iterator.next()), signal);
            signal.throwIfAborted(); if (chunk.done) break; yield chunk.value;
          }
        }
        catch { throw new ScraperApiError("SCRAPERAPI.EXECUTION_UNKNOWN"); }
        finally { close(); }
      })();
      return { status: response.status, headers: safeHeaders, body, close };
    } catch (error) {
      response?.close();
      if (error instanceof ScraperApiError) throw error;
      throw new ScraperApiError("SCRAPERAPI.EXECUTION_UNKNOWN");
    }
  }
}
