import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { textFingerprint, TextOutputSchema } from "@crawl-automation/v3-contracts";
import { labelExecutionFixture } from "./label-execution.fixture.js";
import { CodexTextProvider, type CodexConnectionOptions } from "./codex-provider.js";
import { CodexRpc } from "./codex-rpc.js";
import { TextModule } from "./module.js";
import { hashText } from "./handoff.js";

it("the real provider/RPC path passes the new schema and medium effort through an isolated child-process fixture", async () => {
  const f = labelExecutionFixture(), root = await mkdtemp(join(tmpdir(), "label-provider-"));
  const codexHome = join(root, "profile"); await mkdir(codexHome, { mode: 0o700 });
  const response = join(root, "response.json"); await writeFile(response, JSON.stringify(f.wire), { flag: "wx", mode: 0o600 });
  const connections: CodexConnectionOptions[] = [];
  const provider = await CodexTextProvider.open({ settings: { provider: "fixture", model: "fixture-model", reasoningEffort: "medium" },
    executable: process.execPath, codexHome, workRoot: join(root, "work"), runtimeProfileVersion: "fixture/1", timeoutMs: 5000, extractionProtocol: "label-extraction/1" }, {}, options => {
      connections.push(options);
      return new CodexRpc({ ...options, executable: process.execPath,
        args: [fileURLToPath(new URL("./codex.fixture.mjs", import.meta.url)), "label-result", response], env: {} });
    });
  const input = { ...f.input, ...provider.supported }; input.inputFingerprint = textFingerprint(input, hashText);
  try {
    await provider.check(AbortSignal.timeout(5000));
    const module = new TextModule({ ...f.deps, provider });
    expect(await module.run(input, AbortSignal.timeout(10000))).toMatchObject({ status: "registered" });
    const record = f.registry.data.get(input.operationId)!;
    const output = TextOutputSchema.parse(JSON.parse(Buffer.from(f.remote.data.get(record.result.objectKey)!).toString()));
    expect(output.resultSchemaVersion).toBe(3); expect(connections).toHaveLength(2); // capability check + one business execution
    f.local.data.clear(); const writes = f.remote.writes;
    expect(await module.run(input, AbortSignal.timeout(10000))).toMatchObject({ status: "registered" });
    expect(connections).toHaveLength(2); expect(f.remote.writes).toBe(writes);
  } finally { await provider.close(); }
});
