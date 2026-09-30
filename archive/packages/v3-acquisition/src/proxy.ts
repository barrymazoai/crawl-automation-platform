import { request as httpRequest, validateHeaderValue, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, Agent } from "node:https";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import type { Socket } from "node:net";
import { permittedUrl } from "./network.js";
import { AcquisitionError, type Address, type FileTransport, type Response } from "./ports.js";

export class NetworkError extends Error {
  constructor(readonly code: "NETWORK.CONFIG_INVALID" | "NETWORK.CAPABILITY_UNAVAILABLE" | "NETWORK.HOST_CLIENT_REQUIRED" |
    "NETWORK.ROUTE_MISMATCH" | "NETWORK.PROXY_AUTH" | "NETWORK.PROXY_UNAVAILABLE" | "NETWORK.TIMEOUT") {
    super(code); this.name = "NetworkError";
  }
}
/** Explicit private deployment configuration, never a task URL. HTTP auth only on loopback. */
function proxyEndpoint(raw: string): URL {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol) || u.pathname !== "/" || u.search || u.hash || raw.length > 4096 ||
      !u.hostname || (u.protocol === "http:" && (u.username || u.password) && !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname)))
      throw Error();
    decodeURIComponent(u.username); decodeURIComponent(u.password);
    return u;
  } catch { throw new NetworkError("NETWORK.CONFIG_INVALID"); }
}

/** One CONNECT and one verified HTTPS GET. No pool, redirect, retry, environment fallback or global mutation.
 * CONNECT carries the hostname; the trusted proxy owns DNS and resolved-address restrictions.
 * Host/SNI and certificate verification retain the target hostname. No client-side target DNS.
 */
export class StaticProxyTransport implements FileTransport {
  readonly targetResolution = "proxy" as const;
  readonly #proxy: URL;
  constructor(readonly egressId: string, proxyUrl: string) {
    if (!egressId || egressId === "direct/1") throw new NetworkError("NETWORK.CONFIG_INVALID");
    this.#proxy = proxyEndpoint(proxyUrl);
  }
  async get(url: URL, address: Address | undefined, headers: Readonly<Record<string, string>>, signal: AbortSignal): Promise<Response> {
    permittedUrl(url.href, [url.origin]);
    // Reject outdated callers instead of silently ignoring an address they believe is pinned.
    if (address !== undefined) throw new NetworkError("NETWORK.CONFIG_INVALID");
    signal.throwIfAborted();
    // Reject transport/header overrides; proxy authentication must never reach the origin.
    const names = new Set<string>();
    if (Object.entries(headers).some(([k, v]) => {
      const lower = k.toLowerCase(), duplicate = names.has(lower); names.add(lower);
      return duplicate || !["cookie", "authorization", "user-agent", "accept", "referer"].includes(lower) ||
        typeof v !== "string" || v.length > 8192 || /[\r\n\0]/.test(v);
    }))
      throw new NetworkError("NETWORK.CONFIG_INVALID");
    try { for (const [k, v] of Object.entries(headers)) validateHeaderValue(k, v); }
    catch { throw new NetworkError("NETWORK.CONFIG_INVALID"); }
    return new Promise((resolve, reject) => {
      const proxy = this.#proxy;
      const authority = `${url.hostname}:443`;
      const connectHeaders: Record<string, string> = { host: authority };
      if (proxy.username || proxy.password) connectHeaders["proxy-authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
      let tunnel: Socket | undefined, secure: TLSSocket | undefined, origin: ClientRequest | undefined, agent: Agent | undefined, connection: ClientRequest | undefined;
      let closed = false;
      const cleanup = () => {
        if (closed) return; closed = true;
        clearTimeout(timer); signal.removeEventListener("abort", stop);
        origin?.destroy(); secure?.destroy(); tunnel?.destroy(); agent?.destroy(); connection?.destroy();
      };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const stop = () => fail(signal.reason instanceof Error ? signal.reason : new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE"));
      // Proxy timeout also covers a consumer which never drains/closes a response.
      const timer = setTimeout(() => fail(new NetworkError("NETWORK.TIMEOUT")), 30000);
      try { connection = (proxy.protocol === "https:" ? httpsRequest : httpRequest)({
        protocol: proxy.protocol, hostname: proxy.hostname.replace(/^\[|\]$/g, ""), port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
        method: "CONNECT", path: authority, headers: connectHeaders, agent: false, maxHeaderSize: 16384,
        ...(proxy.protocol === "https:" ? { rejectUnauthorized: true } : {}),
      }); } catch { fail(new NetworkError("NETWORK.CONFIG_INVALID")); return; }
      connection.on("error", () => fail(new NetworkError("NETWORK.PROXY_UNAVAILABLE")));
      connection.on("response", res => { res.destroy(); fail(new NetworkError(res.statusCode === 407 ? "NETWORK.PROXY_AUTH" : "NETWORK.PROXY_UNAVAILABLE")); });
      connection.on("connect", (res, socket, head) => {
        tunnel = socket;
        if (closed || signal.aborted) { socket.destroy(); return; }
        socket.on("error", () => fail(new NetworkError("NETWORK.PROXY_UNAVAILABLE")));
        if (res.statusCode !== 200 || head.length) { fail(new NetworkError(res.statusCode === 407 ? "NETWORK.PROXY_AUTH" : "NETWORK.PROXY_UNAVAILABLE")); return; }
        secure = tlsConnect({ socket, servername: url.hostname, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] });
        secure.on("error", () => fail(new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE")));
        secure.once("secureConnect", () => {
          if (closed || signal.aborted) { cleanup(); return; }
          agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
          agent.createConnection = () => secure!;
          origin = httpsRequest(url, { method: "GET", agent, maxHeaderSize: 16384,
            headers: { ...headers, host: url.host, "accept-encoding": "identity" }, rejectUnauthorized: true,
          }, (response: IncomingMessage) => {
            if (closed) { response.destroy(); return; }
            const selected: Response["headers"] = {};
            for (const key of ["content-type", "content-length", "content-encoding", "location"]) {
              const v = response.headers[key]; selected[key] = Array.isArray(v) ? v.join(",") : v;
            }
            resolve({ status: response.statusCode ?? 0, headers: selected, body: response, close: cleanup });
          });
          origin.on("error", () => fail(new AcquisitionError("SOURCE.NETWORK_UNAVAILABLE")));
          origin.end();
        });
      });
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop(); else connection.end();
    });
  }
}
