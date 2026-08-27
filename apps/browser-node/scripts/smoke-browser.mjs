import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startChromeLane } from "../../../packages/runtime/dist/index.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const requestedUrlIndex = process.argv.indexOf("--url");
const requestedUrl = requestedUrlIndex >= 0 ? process.argv[requestedUrlIndex + 1] : null;
const adapter = await import(pathToFileURL(path.join(repositoryRoot, "crawl-products", "lib", "worker-cdp-browser.mjs")).href);

let result;
const chrome = await startChromeLane({
  id: 1,
  profileRoot: process.env.CHROME_PROFILE_ROOT ?? path.join(repositoryRoot, ".automation-state", "chrome-smoke"),
  ...(process.env.CHROME_EXECUTABLE_PATH ? { executablePath: process.env.CHROME_EXECUTABLE_PATH } : {}),
  headless: process.env.CHROME_HEADLESS === "true",
  startupTimeoutMs: Number(process.env.CHROME_STARTUP_TIMEOUT_MS || 20_000),
  preflight: async (cdpUrl) => {
    const binding = await adapter.connectWorkerBrowser({ cdpUrl });
    let tab;
    try {
      tab = await binding.tabs.new();
      const url = requestedUrl || "data:text/html,<title>crawl-browser-ready</title><main>ready</main>";
      await tab.goto(url);
      const [title, finalUrl, screenshot] = await Promise.all([
        tab.playwright.evaluate(() => document.title),
        tab.url(),
        tab.screenshot(),
      ]);
      if (!screenshot?.length) throw new Error("worker_cdp_smoke_screenshot_empty");
      let image;
      if (requestedUrl) {
        const imageUrl = await tab.playwright.evaluate(() =>
          [...document.images].map((item) => item.currentSrc || item.src).find((value) => /^https?:/i.test(value)) || null
        );
        if (imageUrl) {
          const fetched = await adapter.createBrowserImageFetcher(tab)(imageUrl);
          image = { url: imageUrl, byteSize: fetched.bytes.length, mime: fetched.mime };
        }
      }
      result = { status: "ok", title, finalUrl, screenshotBytes: screenshot.length, ...(image ? { image } : {}) };
    } finally {
      await tab?.close().catch(() => {});
      await binding.disconnect().catch(() => {});
    }
  },
});

try {
  console.log(JSON.stringify({ ...result, chromeHealthyAfterPreflight: await chrome.health(), cdpHost: new URL(chrome.cdpUrl).hostname, laneId: chrome.id }, null, 2));
} finally {
  await chrome.close();
}
