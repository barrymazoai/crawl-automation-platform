import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LocalCheckpointStore, buildBrowserCapturePrompt, classifyUrl } from "./index";

describe("runtime routing", () => {
  it("routes Amazon to its fixed adapter and DTC to Browser Node", () => {
    expect(classifyUrl("https://www.amazon.com/dp/B000000000")).toMatchObject({ type: "sales_channel", adapter: "amazon" });
    expect(classifyUrl("brand.example/products/a")).toMatchObject({ type: "dtc_browser", adapter: null });
  });

  it("builds a browser prompt without hard-coding a git command", () => {
    const prompt = buildBrowserCapturePrompt({ url: "https://brand.example", runId: "run-1", jobDirectory: "/jobs/run-1", nodeId: "windows-1" });
    expect(prompt).toContain("拉取 crawl-products Skill 的最新代码");
    expect(prompt).not.toMatch(/git\s+pull/);
    expect(prompt).toContain("skuMissing=true");
  });

  it("persists resumable checkpoints in SQLite", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "crawl-runtime-"));
    const store = new LocalCheckpointStore(path.join(directory, "state.sqlite"));
    store.save("job-1", "capture", "running", { lastUploadedOrdinal: 3 }, "lease");
    expect(store.get("job-1")?.payload).toEqual({ lastUploadedOrdinal: 3 });
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});

