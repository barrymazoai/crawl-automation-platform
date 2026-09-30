import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CdpFileSession } from "../src/browser-session.js";

// Explicit opt-in. A new disposable profile, dead proxy and no page navigation; no user browser is attached.
describe.skipIf(!process.env.V3_TEST_CHROME)("private session export with real isolated Chrome", () => {
  let chrome: ChildProcess | undefined, root: string, endpoint: string, instanceId: string;
  const signal = () => AbortSignal.timeout(15000);
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "v3-session-chrome-"));
    chrome = spawn(process.env.V3_TEST_CHROME!, ["--headless=new", `--user-data-dir=${root}`, "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1", "--proxy-server=http://127.0.0.1:9", "--disable-background-networking",
      "--disable-component-update", "--disable-sync", "--disable-extensions", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
    let startupError: unknown; chrome.on("error", e => { startupError = e; });
    for (let i = 0; i < 100; i++) {
      if (startupError || chrome.exitCode !== null) throw Error("Isolated Chrome startup failed");
      try {
        const [port, path] = (await readFile(join(root, "DevToolsActivePort"), "utf8")).trim().split("\n");
        endpoint = `http://127.0.0.1:${port}`; instanceId = path!.split("/").at(-1)!; break;
      } catch { await delay(100); }
    }
    if (!endpoint) throw Error("Isolated Chrome timeout");
    const tab = await (await fetch(endpoint + "/json/new?about:blank", { method: "PUT", signal: signal() })).json() as { id: string; webSocketDebuggerUrl: string };
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", reject, { once: true }); });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("Cookie fixture timeout")), 5000);
        ws.addEventListener("message", event => {
          const m = JSON.parse(String(event.data)); if (m.id !== 1) return; clearTimeout(timer);
          if (m.error) reject(Error("Cookie fixture rejected")); else resolve();
        });
        ws.send(JSON.stringify({ id: 1, method: "Network.setCookies", params: { cookies: [
          { name: "synthetic_root", value: "fixture-only", url: "https://files.example/", secure: true, httpOnly: true },
          { name: "synthetic_path", value: "labels-only", domain: "files.example", path: "/labels", secure: true },
          { name: "synthetic_foreign", value: "never-export", url: "https://cdn.example/", secure: true },
        ] } }));
      });
    } finally { ws.close(); await fetch(endpoint + "/json/close/" + tab.id, { signal: signal() }); }
  }, 20000);
  afterAll(async () => {
    if (chrome?.pid && chrome.exitCode === null) {
      chrome.kill("SIGTERM");
      for (let i = 0; i < 50 && chrome.exitCode === null && chrome.signalCode === null; i++) await delay(100);
      if (chrome.exitCode === null && chrome.signalCode === null) throw Error("Isolated Chrome did not stop");
    }
    console.log("Isolated synthetic Chrome stopped; retained fixture profile:", root);
  });
  it("Chrome returns path-specific HttpOnly cookies; cross-origin requests remain anonymous", async () => {
    const pages = async () => (await (await fetch(endpoint + "/json/list", { signal: signal() })).json() as { id: string; type: string; url: string }[])
      .filter(t => t.type === "page").map(t => t.id).sort();
    // Chrome's close endpoint acknowledges the request before asynchronous target teardown finishes.
    await delay(200);
    const before = await pages();
    const browser = new CdpFileSession({ endpoint, instanceId, sessionId: "synthetic", egressId: "fixture/1",
      allowedOrigins: ["https://files.example", "https://cdn.example"] });
    const result = await browser.exportFiles(["https://files.example/labels/a.png", "https://files.example/other.png", "https://cdn.example/a.png"],
      "https://files.example/product.html", new Date(Date.now() + 300000).toISOString(), signal());
    expect(result.resources[0]!.headers.cookie).toContain("synthetic_root=fixture-only");
    expect(result.resources[0]!.headers.cookie).toContain("synthetic_path=labels-only");
    expect(result.resources[1]!.headers.cookie).toBe("synthetic_root=fixture-only");
    expect(result.resources[2]!.headers.cookie).toBeUndefined();
    expect(result.resources[0]!.headers["user-agent"]).toContain("Chrome/");
    let after = await pages();
    for (let i = 0; i < 20 && JSON.stringify(after) !== JSON.stringify(before); i++) { await delay(100); after = await pages(); }
    expect(after).toEqual(before);
  });
});
