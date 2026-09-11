import { hostname } from "node:os";
import { isAbsolute, join } from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { startChromeLane } from "../../runtime/src/chrome-lane.js";
import { BrowserError, CdpRenderedBrowser } from "@crawl-automation/v3-acquisition";
import { GncAdapter, GncBrowserReader } from "../src/index.js";

async function main() {
  const [root] = process.argv.slice(2);
  if (!root || !isAbsolute(root) || process.platform !== "darwin" || !/^barrydeMac-mini(?:\.|$)/.test(hostname())) throw Error("MINI_ONLY");
  const dir = await stat(root); if (!dir.isDirectory() || (dir.mode & 0o077)) throw Error("PRIVATE_DIRECTORY_REQUIRED");
  await writeFile(join(root, "attempt.json"), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  let chromePid: number | undefined;
  // Reuse the inspected old launch utility, not its batch crawler, retry holder or page sweeper.
  const chrome = await startChromeLane({ id: 1, profileRoot: join(root, "profile"), headless: false, locale: "en-US", timezone: "America/New_York",
    spawnImpl: (exe, args) => {
      const child = spawn(exe, ["--proxy-server=http://127.0.0.1:7897", ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TZ: "America/New_York" } });
      chromePid = child.pid; return child;
    } });
  const network = { routeId: "mini-browser-gnc", version: "browser-cdp-1", mode: "static-proxy", managed: true, egressId: "mini-gnc-selected/1" } as const;
  const input = { kind: "product" as const, requestId: "mini-browser", operationId: "mini-browser-613701", brandId: "legacy-sample-unverified-brand", sourceId: "gnc",
    binding: { sessionId: "mini-browser-session", egressId: network.egressId }, url: "https://www.gnc.com/energy/613701.html", sku: "613701" };
  let result: Record<string, unknown>, browserId: string | undefined;
  try {
    const version = await (await fetch(chrome.cdpUrl + "/json/version", { signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string };
    browserId = new URL(version.webSocketDebuggerUrl).pathname.split("/").at(-1)!;
    const browser = new CdpRenderedBrowser({ endpoint: chrome.cdpUrl, instanceId: browserId, sessionId: input.binding.sessionId, egressId: network.egressId, allowedOrigins: ["https://www.gnc.com"] }, true);
    const reader = new GncBrowserReader(network, { sessionId: browser.sessionId, egressId: browser.egressId, read: async (url, signal) => {
      const page = await browser.read(url, signal);
      await writeFile(join(root, "rendered.html"), page.html, { flag: "wx", mode: 0o600 });
      if (page.screenshot) await writeFile(join(root, "page.png"), page.screenshot, { flag: "wx", mode: 0o600 });
      await writeFile(join(root, "page.json"), JSON.stringify({ url: page.url, status: page.status, contentType: page.contentType, browserId: page.browserId, targetId: page.targetId }), { flag: "wx", mode: 0o600 });
      return page;
    } }, [{ input, expiresAt: new Date(Date.now() + 60000).toISOString() }]);
    const captured = await new GncAdapter(reader).capture(input, AbortSignal.timeout(50000));
    await writeFile(join(root, "parsed.json"), JSON.stringify(captured.data), { flag: "wx", mode: 0o600 });
    result = { status: "captured-not-collected", sha256: captured.sha256 };
  } catch (e) {
    if (e instanceof BrowserError && e.screenshot) await writeFile(join(root, "failure.png"), e.screenshot, { flag: "wx", mode: 0o600 });
    const code = e && typeof e === "object" && "code" in e ? String(e.code) : "GNC.UNRESOLVED";
    result = { status: "blocked", code: /^(GNC|SOURCE)\.[A-Z_]+$/.test(code) ? code : "GNC.UNRESOLVED",
      ...(e instanceof BrowserError ? { reason: e.reason, screenshotSaved: !!e.screenshot } : {}) };
  } finally { await chrome.close(); }
  const report = { host: hostname(), browserId, chromePid, cdpUrl: chrome.cdpUrl, profile: chrome.profileDirectory,
    input, result, browserNavigationLimit: 1, retries: 0, targetFetchCalls: 0, targetDnsCalls: 0, proxy: "http://127.0.0.1:7897",
    clashChanges: 0, r2Calls: 0, modelCalls: 0, pdfCalls: 0, productCollected: false, at: new Date().toISOString() };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify(report));
}
main().catch(() => { console.error("MINI_BROWSER_PROBE_FAILED_INSPECT_EVIDENCE"); process.exitCode = 1; });
