import assert from "node:assert/strict";
import { hostname } from "node:os";
import { join, isAbsolute } from "node:path";
import { writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createHttpRoute, pinAddress } from "@crawl-automation/v3-acquisition";
import { GncAdapter, GncHttpReader } from "../src/index.js";

// One explicitly scoped network compatibility probe. No Temporal, R2, OCR, model or old Worker.
// Build locally if necessary; EXECUTE ONLY on the user-selected Mac mini, in a new private directory.
async function main() {
  const [root] = process.argv.slice(2);
  if (!root || !isAbsolute(root) || process.platform !== "darwin" || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
  const info = await stat(root);
  if (!info.isDirectory() || (info.mode & 0o077)) throw Error("PRIVATE_DIRECTORY_REQUIRED");
  // A repeated invocation cannot issue another request under the same test identity.
  await writeFile(join(root, "attempt.json"), JSON.stringify({ host: hostname(), pid: process.pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const url = new URL("https://www.gnc.com/energy/613701.html"); // exact URL found in Mini's retained capture/discovery.json
  let guardTests = 0;
  for (const address of ["198.18.0.9", "127.0.0.1", "10.0.0.1"]) {
    await assert.rejects(pinAddress(url, { resolve: async () => [{ address, family: 4 }] }, AbortSignal.timeout(5000)), /SOURCE.SSRF_BLOCKED/); guardTests++;
  }
  assert.deepEqual(await pinAddress(url, { resolve: async () => [{ address: "8.8.8.8", family: 4 }] }, AbortSignal.timeout(5000)), { address: "8.8.8.8", family: 4 }); guardTests++;
  const route = createHttpRoute({ routeId: "mini-existing-gnc", version: "2-domain-connect", mode: "static-proxy", managed: true, egressId: "mini-gnc-selected/1" }, { proxyUrl: "http://127.0.0.1:7897" });
  const input = { kind: "product" as const, requestId: "mini-gnc-network", operationId: "mini-gnc-613701", brandId: "legacy-sample-unverified-brand", sourceId: "gnc",
    binding: { sessionId: "mini-existing-clash", egressId: route.selection.egressId }, url: url.href, sku: "613701" };
  let dnsCalls = 0, transportCalls = 0;
  const transport = route.transport;
  const counted = { ...route, transport: { egressId: transport.egressId, targetResolution: transport.targetResolution, get: (...args: Parameters<typeof transport.get>) => { transportCalls++; return transport.get(...args); } } };
  const reader = new GncHttpReader(counted, [{ input, expiresAt: new Date(Date.now() + 60000).toISOString() }], {
    resolve: async () => { dnsCalls++; throw Error("CLIENT_TARGET_DNS_FORBIDDEN"); },
  });
  let outcome: Record<string, unknown>;
  let sourceHash: string | undefined;
  try {
    const result = await new GncAdapter({ read: async (task, signal) => {
      const page = await reader.read(task, signal);
      // Preserve received HTML even if SKU/DOM parsing subsequently rejects it.
      sourceHash = createHash("sha256").update(page.bytes).digest("hex");
      await writeFile(join(root, "source.html"), page.bytes, { flag: "wx", mode: 0o600 });
      return page;
    } }).capture(input, AbortSignal.timeout(35000));
    // Never call partial capture an API-ready/collected product.
    await writeFile(join(root, "parsed.json"), JSON.stringify(result.data), { flag: "wx", mode: 0o600 });
    outcome = { status: "captured-not-collected", sourceHash };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "NETWORK.UNRESOLVED";
    outcome = { status: "blocked", code: /^[A-Z_.]+$/.test(code) ? code : "NETWORK.UNRESOLVED", sourceHash };
  }
  const report = { host: hostname(), platform: process.platform, arch: process.arch, node: process.version, pid: process.pid,
    url: url.href, network: route.selection, proxy: "http://127.0.0.1:7897", targetResolution: transport.targetResolution, guardTests, dnsCalls, transportCalls, outcome,
    actualPublicExitVerified: false, sourceRequestsBound: 1, retries: 0, r2Calls: 0, modelCalls: 0, databaseWrites: 0,
    clashChanges: 0, browserActions: 0, productCollected: false, at: new Date().toISOString() };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error("MINI_GNC_PROBE_FAILED_INSPECT_RETAINED_FILES"); process.exitCode = 1; });
