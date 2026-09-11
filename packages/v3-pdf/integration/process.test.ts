import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

let cwd: string;
beforeAll(async () => { cwd = await mkdtemp(join(tmpdir(), "pdf-process-")); });
const run = (mode: string, signal = new AbortController().signal, timeoutMs = 5000) => runProcess({
  executable: resolve(".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
  args: ["-I", resolve("integration/fixtures/process.py"), mode], cwd, stdin: "{}", timeoutMs, signal,
});
it.each(["stdout", "stderr", "bad", "extra"])("bounds protocol: %s", async mode => {
  await expect(run(mode)).rejects.toMatchObject({ code: "PDF.PROTOCOL" });
});
it("classifies hard process crash", async () => {
  await expect(run("crash")).rejects.toMatchObject({ code: "PDF.PROCESS_FAILED" });
});
it("classifies missing Python without hanging", async () => {
  await expect(runProcess({ executable: join(cwd, "missing-python"), args: [], cwd, stdin: "{}", timeoutMs: 1000,
    signal: new AbortController().signal })).rejects.toMatchObject({ code: "PDF.PROCESS_FAILED" });
});
it("timeout escalates to kill and waits for actual process close", async () => {
  const start = performance.now();
  await expect(run("hang", undefined, 500)).rejects.toMatchObject({ code: "PDF.TIMEOUT" });
  expect(performance.now() - start).toBeLessThan(4000);
});
it("in-flight cancel terminates a process that ignores SIGTERM", async () => {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 500);
  try { await expect(run("hang", controller.signal)).rejects.toMatchObject({ code: "PDF.CANCELLED" }); }
  finally { clearTimeout(timer); }
});
it("does not inherit provider credentials", async () => {
  const prior = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
  process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = "synthetic-fixture-not-a-secret";
  try { await expect(run("secret")).resolves.toBeUndefined(); }
  finally {
    if (prior === undefined) delete process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;
    else process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY = prior;
  }
});
