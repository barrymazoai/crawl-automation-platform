import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { mkdtemp, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHttpRoute } from "@crawl-automation/v3-acquisition";
import type { GncCaptureInput } from "@crawl-automation/v3-contracts";
import { GncAdapter, GncHttpReader } from "../src/index.js";

// Test-only trust injection, NOT a production option. CONNECT fixtures forward only to our loopback
// TLS origin regardless of the requested hostname. No outbound site/proxy is contacted.
const trust = vi.hoisted(() => ({ ca: Buffer.alloc(0), enabled: true, sni: [] as string[], verify: [] as unknown[] }));
vi.mock("node:tls", async original => {
  const actual = await original<typeof import("node:tls")>();
  return { ...actual, connect: (options: ConnectionOptions) => {
    trust.sni.push(options.servername ?? ""); trust.verify.push(options.rejectUnauthorized);
    return actual.connect({ ...options, ...(trust.enabled ? { ca: trust.ca } : {}) });
  } };
});
const input: GncCaptureInput = { kind: "product", requestId: "req", operationId: "op", brandId: "brand", sourceId: "source", binding: { sessionId: "session", egressId: "proxy/1" }, url: "https://www.gnc.com/123456.html", sku: "123456" };
const html = '<script type="application/ld+json">{"@type":"Product","sku":"123456","name":"Fixture"}</script><div id="productIngredientsAccordionContent"><table><tr><td>Vitamin C</td><td>10 mg</td></tr></table>Other ingredients: cellulose</div>';
let root = "", origin: ReturnType<typeof httpsServer>, proxyA: ReturnType<typeof httpServer>, proxyB: ReturnType<typeof httpServer>;
let originPort = 0, portA = 0, portB = 0, deny = false, stall = false, responseStatus = 200, broken = false;
const sockets = new Set<Socket>();
const connects: { lane: string; authority: string; auth: string | undefined; cookie: string | undefined }[] = [];
const requests: { host: string | undefined; cookie: string | undefined; proxyAuth: string | undefined; encoding: string | undefined }[] = [];
const dns = { resolve: vi.fn(async () => { throw Error("Client target DNS must not run"); }) };
function track(s: Socket) { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => {}); }
async function listen(server: ReturnType<typeof httpServer> | ReturnType<typeof httpsServer>) {
  server.on("connection", track);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const a = server.address(); if (!a || typeof a === "string") throw Error("No port"); return a.port;
}
function proxy(lane: string) {
  const server = httpServer();
  server.on("connect", (req, client, head) => {
    connects.push({ lane, authority: req.url ?? "", auth: req.headers["proxy-authorization"], cookie: req.headers.cookie });
    if (stall) return;
    if (deny) { client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n"); return; }
    const upstream = connect(originPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    track(upstream); client.on("close", () => upstream.destroy()); upstream.on("close", () => client.destroy());
  });
  return server;
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v3-gnc-network-"));
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"), "-days", "1", "-subj", "/CN=www.gnc.com", "-addext", "subjectAltName=DNS:www.gnc.com"]);
  await chmod(join(root, "key.pem"), 0o600); trust.ca = await readFile(join(root, "cert.pem"));
  origin = httpsServer({ key: await readFile(join(root, "key.pem")), cert: trust.ca }, (req, res) => {
    requests.push({ host: req.headers.host, cookie: req.headers.cookie, proxyAuth: req.headers["proxy-authorization"], encoding: req.headers["accept-encoding"] });
    res.writeHead(responseStatus, { "content-type": "text/html", ...(broken ? { "content-length": Buffer.byteLength(html) + 20 } : {}), ...(responseStatus === 302 ? { location: "https://evil.test/" } : {}) });
    res.write(html.slice(0, 20)); setImmediate(() => { if (broken) res.destroy(); else res.end(html.slice(20)); });
  });
  originPort = await listen(origin); proxyA = proxy("A"); proxyB = proxy("B");
  portA = await listen(proxyA); portB = await listen(proxyB);
});
afterAll(async () => {
  for (const s of sockets) s.destroy();
  for (const server of [proxyA, proxyB, origin]) if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs(); console.log("Isolated proxy/TLS fixtures stopped; retained test certificates:", root);
});
function run(lane: "A" | "B" = "A", s = new AbortController().signal) {
  const i = { ...input, operationId: `op-${lane}`, binding: { ...input.binding, egressId: `proxy/${lane}` } };
  const route = createHttpRoute({ routeId: `lane-${lane}`, version: "1", egressId: i.binding.egressId, mode: "static-proxy", managed: true }, { proxyUrl: `http://user:synthetic-${lane}@127.0.0.1:${lane === "A" ? portA : portB}` });
  const reader = new GncHttpReader(route, [{ input: i, expiresAt: new Date(Date.now() + 60000).toISOString(), headers: { cookie: `origin-${lane}` } }], dns);
  return new GncAdapter(reader).capture(i, s);
}
describe.sequential("real local CONNECT/TLS to GNC adapter", () => {
  it("two proxy lanes run concurrently with hostname CONNECT, zero target DNS and isolated credentials", async () => {
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1"); vi.stubEnv("ALL_PROXY", "http://127.0.0.1:1");
    const results = await Promise.all([run("A"), run("B")]);
    expect(results.every(r => r.data && "sku" in r.data && r.data.sku === "123456")).toBe(true);
    expect(connects.map(c => c.lane).sort()).toEqual(["A", "B"]);
    for (const c of connects) {
      expect(c.authority).toBe("www.gnc.com:443"); expect(c.cookie).toBeUndefined();
      expect(c.auth).toBe(`Basic ${Buffer.from(`user:synthetic-${c.lane}`).toString("base64")}`);
    }
    expect(requests.map(r => r.cookie).sort()).toEqual(["origin-A", "origin-B"]);
    expect(requests.every(r => r.host === "www.gnc.com" && r.proxyAuth === undefined && r.encoding === "identity")).toBe(true);
    expect(trust.sni).toEqual(["www.gnc.com", "www.gnc.com"]); expect(trust.verify).toEqual([true, true]);
    expect(results.every(r => r.artifactDurable === false)).toBe(true);
    expect(dns.resolve).not.toHaveBeenCalled();
  });
  it("407 is a proxy error, not GNC challenge; no origin request or retry", async () => {
    deny = true; const n = requests.length, c = connects.length;
    try { await expect(run()).rejects.toThrow("NETWORK.PROXY_AUTH"); } finally { deny = false; }
    expect(requests.length).toBe(n); expect(connects.length - c).toBe(1);
  });
  it("untrusted origin TLS fails closed before HTTP", async () => {
    trust.enabled = false; const n = requests.length;
    try { await expect(run()).rejects.toThrow("SOURCE.NETWORK_UNAVAILABLE"); } finally { trust.enabled = true; }
    expect(requests.length).toBe(n);
  });
  it("redirects are not followed and credentials do not propagate", async () => {
    responseStatus = 302; const n = requests.length, c = connects.length;
    try { await expect(run()).rejects.toThrow("GNC.REDIRECT_UNVERIFIED"); } finally { responseStatus = 200; }
    expect(requests.length - n).toBe(1); expect(connects.length - c).toBe(1);
  });
  it("truncated response cannot become successful evidence", async () => {
    broken = true; const c = connects.length;
    try { await expect(run()).rejects.toThrow("SOURCE.NETWORK_UNAVAILABLE"); } finally { broken = false; }
    expect(connects.length - c).toBe(1);
  });
  it("cancelled CONNECT is closed without affecting another lane", async () => {
    stall = true; const controller = new AbortController(), c = connects.length;
    const pending = expect(run("A", controller.signal)).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(connects.length).toBe(c + 1));
    controller.abort(new Error("cancelled")); await pending; stall = false;
    expect((await run("B")).artifactDurable).toBe(false);
  });
});
