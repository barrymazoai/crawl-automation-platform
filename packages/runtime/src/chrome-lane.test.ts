import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { chromeExecutableCandidates, startChromeLane, sweepChromePages } from "./chrome-lane";

function fakeChild() {
  const child = new EventEmitter() as any;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {} };
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0));
    return true;
  });
  return child;
}

describe("Chrome worker lanes", () => {
  it("uses Windows Chrome installation paths", () => {
    expect(chromeExecutableCandidates("win32", {
      LOCALAPPDATA: "C:\\Users\\Barry\\AppData\\Local",
      PROGRAMFILES: "C:\\Program Files",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    })).toContain("C:\\Users\\Barry\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe");
  });

  it("does not become healthy until CDP and the Playwright preflight pass", async () => {
    const child = fakeChild();
    const preflight = vi.fn(async () => {});
    const lane = await startChromeLane({
      id: 2,
      profileRoot: ".automation-state/chrome",
      port: 9332,
      resolveExecutable: vi.fn(async () => "C:\\Chrome\\chrome.exe"),
      spawnImpl: vi.fn(() => child),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }), { status: 200 })),
      preflight,
    });

    expect(lane.cdpUrl).toBe("http://127.0.0.1:9332");
    expect(preflight).toHaveBeenCalledWith(lane.cdpUrl);
    await expect(lane.health()).resolves.toBe(true);
    await lane.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills Chrome when the Playwright preflight fails", async () => {
    const child = fakeChild();
    await expect(startChromeLane({
      id: 1,
      profileRoot: ".automation-state/chrome",
      port: 9331,
      resolveExecutable: vi.fn(async () => "C:\\Chrome\\chrome.exe"),
      spawnImpl: vi.fn(() => child),
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools" }), { status: 200 })),
      preflight: vi.fn(async () => { throw new Error("playwright_attach_failed"); }),
    })).rejects.toThrow("playwright_attach_failed");
    expect(child.kill).toHaveBeenCalled();
  });

  it("任务收尾只关 page 类型页签、留一个，不碰 service worker", async () => {
    const closedIds: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/json/list")) {
        return new Response(JSON.stringify([
          { id: "p3", type: "page", url: "https://brand.example/products/c" },
          { id: "p2", type: "page", url: "https://brand.example/products/b" },
          { id: "sw", type: "service_worker", url: "https://brand.example/sw.js" },
          { id: "p1", type: "page", url: "about:blank" },
        ]), { status: 200 });
      }
      const m = url.match(/\/json\/close\/(\w+)$/);
      if (m) { closedIds.push(m[1]!); return new Response("Target is closing", { status: 200 }); }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(sweepChromePages("http://127.0.0.1:9333", fetchImpl)).resolves.toEqual({ closed: 2, kept: 1, failed: 0 });
    expect(closedIds).toEqual(["p3", "p2"]);
  });

  it("CDP 端点不可用时收尾不抛错", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    await expect(sweepChromePages("http://127.0.0.1:9333", fetchImpl)).resolves.toEqual({ closed: 0, kept: 0, failed: 0 });
  });
});
