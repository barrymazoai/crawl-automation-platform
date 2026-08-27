import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { chromeExecutableCandidates, startChromeLane } from "./chrome-lane";

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
});
