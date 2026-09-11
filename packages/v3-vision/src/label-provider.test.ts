import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { CodexRpc, type CodexConnectionOptions } from "@crawl-automation/v3-codex";
import { gncLabelFixture } from "../../v3-contracts/src/label.fixture.js";
import { CodexVisionProvider } from "./provider.js";
import { labelExecutionFixture } from "./label-execution.fixture.js";
import { VisionModule } from "./module.js";

it("real provider/RPC sends new schema, medium effort and unchanged original bytes to a no-network child fixture", async () => {
  const f = labelExecutionFixture(), root = await mkdtemp(join(tmpdir(), "label-vision-provider-"));
  const codexHome = join(root, "profile"); await mkdir(codexHome, { mode: 0o700 });
  const response = join(root, "response.json");
  await writeFile(response, JSON.stringify({ imageSha256: f.task.input.selection.image.sha256, candidate: gncLabelFixture() }), { flag: "wx", mode: 0o600 });
  const connections: CodexConnectionOptions[] = [];
  const provider = await CodexVisionProvider.open({ settings: { provider: "fixture", model: "fixture", reasoningEffort: "medium" },
    executable: process.execPath, codexHome, workRoot: join(root, "work"), runtimeProfileVersion: "fixture/1", timeoutMs: 5000,
    extractionProtocol: "label-extraction/1" }, {}, options => {
      connections.push(options);
      return new CodexRpc({ ...options, executable: process.execPath,
        args: [fileURLToPath(new URL("./codex.fixture.mjs", import.meta.url)), "label-result", response], env: {} });
    });
  const task = { ...f.task, configFingerprint: provider.fingerprint };
  try {
    await provider.check(AbortSignal.timeout(5000));
    const module = new VisionModule({ ...f.dependencies, provider });
    expect(await module.run(task.input, AbortSignal.timeout(10000))).toMatchObject({ status: "candidate" });
    expect(await f.handoff.complete(task, AbortSignal.timeout(5000))).toMatchObject({ codec: "vision-result/2" });
    expect(connections).toHaveLength(2); f.local.data.clear(); const writes = f.remote.writes;
    expect(await module.run(task.input, AbortSignal.timeout(5000))).toMatchObject({ status: "candidate", replayed: true });
    expect(await f.handoff.inspect(task, AbortSignal.timeout(5000))).not.toBeNull();
    expect(connections).toHaveLength(2); expect(f.remote.writes).toBe(writes);
  } finally { await provider.close(); }
});
