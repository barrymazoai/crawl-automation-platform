import { constants } from "node:fs";
import { open, readFile, writeFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { parseEnv, isDeepStrictEqual as equal } from "node:util";
import { CdpRenderedBrowser } from "@crawl-automation/v3-acquisition";
import { createR2Objects } from "@crawl-automation/v3-artifacts";
import { GncAcquireInputSchema } from "@crawl-automation/v3-contracts";
import { TextLocalStore } from "../../v3-text/src/files.js";
import { AcquireGncModule, GncCaptureEvidence, GncAdapter, GncBrowserReader, gncKeys } from "../src/index.js";

// One explicitly approved SKU. This harness does not start Temporal, models, PDF or a Brand crawl.
async function main() {
  const [root] = process.argv.slice(2);
  if (!root || !isAbsolute(root) || !/^barrydeMac-mini(?:\.|$)/.test(hostname()) || process.env.V3_GNC_SINGLE_LIVE !== "true") throw Error("MINI_OPT_IN_REQUIRED");
  if ((await stat(root)).mode & 0o077) throw Error("PRIVATE_ROOT_REQUIRED");
  const monitorRoot = "/Users/barry/apps/crawlv3-gnc-manual-76ENrC";
  const monitor = JSON.parse(await readFile(join(monitorRoot, "verification/monitor.json"), "utf8"));
  if (monitor.status !== "completed" || monitor.checks.at(-1)?.phase !== "t30" ||
    monitor.checks.at(-1).results.find((r: any) => r.label === "Virginia")?.outcome !== "product-visible") throw Error("SESSION_OBSERVATION_NOT_READY");
  const manifest = JSON.parse(await readFile(join(monitorRoot, "lanes.json"), "utf8"));
  const lane = manifest.lanes.find((l: any) => l.label === "Virginia"); if (!lane) throw Error("LANE_MISSING");
  const require = createRequire("/Users/barry/apps/crawl-platform-v4-parallel/apps/backend/package.json");
  const cfg = require("yaml").parse(await readFile(join(lane.root, "proxy.yaml"), "utf8"));
  const proxy = cfg.proxies.find((p: any) => p.name === lane.name);
  if (proxy?.server !== lane.exitIp || proxy["dialer-proxy"] !== lane.front || !equal(cfg.rules, ["MATCH," + lane.name])) throw Error("LANE_CONFIG_CHANGED");
  const rules = await (await fetch(`http://127.0.0.1:${lane.apiPort}/rules`, { signal: AbortSignal.timeout(5000) })).json() as any;
  if (!rules.rules?.some((r: any) => r.type === "Match" && r.proxy === lane.name)) throw Error("LANE_RUNTIME_CHANGED");
  const authFile = await open(join(root, ".env.r2"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let env: ReturnType<typeof parseEnv>;
  try { const s = await authFile.stat(); if (!s.isFile() || s.size > 8192 || (s.mode & 0o077)) throw Error("PRIVATE_AUTH_REQUIRED"); env = parseEnv(await authFile.readFile("utf8")); }
  finally { await authFile.close(); }
  if (env.CLOUDFLARE_R2_BUCKET !== "supply-smart-test") throw Error("TEST_BUCKET_REQUIRED");
  const id = randomUUID(), scope = { endpoint: env.CLOUDFLARE_R2_ENDPOINT!, bucket: env.CLOUDFLARE_R2_BUCKET,
    prefix: `crawlv3-acceptance/gnc-live-${id}`, timeoutMs: 15000 };
  const r2 = createR2Objects(scope, { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! });
  const local = await TextLocalStore.open(join(root, "journal")), signal = () => AbortSignal.timeout(30000);
  const network = { routeId: "mini-virginia-fixed", version: "private-lane-1", mode: "static-proxy", managed: true, egressId: "mini-virginia-fixed/1" } as const;
  const input = GncAcquireInputSchema.parse({ schemaVersion: 1, implementationVersion: "gnc-acquire/1",
    owner: { schemaVersion: 1, requestId: `req-${id}`, observationId: `obs-${id}`, brandId: "acceptance-focus-fuel", sourceId: "gnc",
      listingId: "613701", variantId: null },
    capture: { kind: "product", requestId: `req-${id}`, operationId: `op-${id}`, brandId: "acceptance-focus-fuel", sourceId: "gnc",
      url: "https://www.gnc.com/energy/613701.html", sku: "613701", binding: { sessionId: `browser-${lane.browserId}`, egressId: network.egressId } }, network });
  const browserConfig = { endpoint: `http://127.0.0.1:${lane.cdpPort}`, instanceId: lane.browserId,
    sessionId: input.capture.binding.sessionId, egressId: network.egressId, allowedOrigins: ["https://www.gnc.com"] };
  const browser = new CdpRenderedBrowser(browserConfig, true); await browser.preflight(signal());
  // Do not reuse a root for another live request, even after a harness failure.
  await writeFile(join(root, "attempt.json"), JSON.stringify({ input, scope, browser: browserConfig, proxyUrl: `http://127.0.0.1:${lane.proxyPort}`, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  let gets = 0, puts = 0, navigations = 0;
  const remote = { read: (...a: Parameters<typeof r2.store.read>) => { gets++; return r2.store.read(...a); },
    create: (...a: Parameters<typeof r2.store.create>) => { puts++; return r2.store.create(...a); } };
  const reviews = { read: async (id: string) => { const b = await local.read(`reviews/${id}.json`, 8388608, signal()); return b ? JSON.parse(Buffer.from(b).toString()) : null; },
    append: async (r: any) => local.create(`reviews/${r.reviewId}.json`, Buffer.from(JSON.stringify(r)), "application/json", signal()) };
  const evidence = new GncCaptureEvidence({ local, remote, reviews });
  const reader = new GncBrowserReader(network, { sessionId: browser.sessionId, egressId: browser.egressId, read: async (url, s) => {
    if (++navigations !== 1) throw Error("SINGLE_NAVIGATION_ONLY");
    const page = await browser.read(url, s);
    await writeFile(join(root, "rendered.html"), page.html, { flag: "wx", mode: 0o600 });
    if (page.screenshot) await writeFile(join(root, "page.png"), page.screenshot, { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "page.json"), JSON.stringify({ url: page.url, status: page.status, contentType: page.contentType, browserId: page.browserId }), { flag: "wx", mode: 0o600 });
    return page;
  } }, [{ input: input.capture, expiresAt: new Date(Date.now() + 300000).toISOString() }]);
  try {
    const result = await new AcquireGncModule(evidence, new GncAdapter(reader)).run(input, AbortSignal.timeout(180000));
    const report = { result, gets, puts, navigations, scope, at: new Date().toISOString(), productCollected: false,
      reviewsRepository: "isolated-local", temporal: false, models: 0, pdf: 0, retries: 0, sharedClashChanges: 0 };
    await writeFile(join(root, "capture-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    if (result.status === "durable") {
      const bytes = await remote.read(gncKeys(input).evidence, 8388608, signal());
      await writeFile(join(root, "parsed.json"), bytes!, { flag: "wx", mode: 0o600 });
    }
    console.log(JSON.stringify({ status: result.status, code: "code" in result ? result.code : null, navigations, gets, puts, productCollected: false }));
  } finally { r2.close(); }
}
main().catch(e => { const raw = e?.code ?? e?.message; console.error(JSON.stringify({ status: "LIVE_CAPTURE_UNRESOLVED", code: typeof raw === "string" && /^[A-Z_.]+$/.test(raw) ? raw : "REDACTED" })); process.exitCode = 1; });
