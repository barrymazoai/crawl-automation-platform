import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EgoRunner } from "./ego-runner.js";
import { EGO_MARKER } from "./ego-script.js";

const result = { kind: "result", targetId: "t1", closed: true, failure: null, value: { ok: 1 } };

/** A stand-in `ego-browser`: prints a notice and its marked lines on the given stream. */
async function fakeEgo(stream: "stdout" | "stderr"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ego-runner-"));
  const path = join(dir, "ego-browser");
  const fd = stream === "stdout" ? 1 : 2;
  const lines = [
    "[ego-browser:notice] Ego Lite update is available",
    `${EGO_MARKER}${JSON.stringify({ kind: "opened", targetId: "t1" })}`,
    `${EGO_MARKER}${JSON.stringify(result)}`,
  ];
  const body = lines.map((line) => `printf '%s\\n' '${line}' >&${fd}`).join("\n");
  await writeFile(path, `#!/bin/sh\ncat > /dev/null\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

describe("EgoRunner", () => {
  // Under PM2 (no terminal) Ego prints the script's output on stderr (2026-09-30, Server 一).
  it.each(["stdout", "stderr"] as const)("reads the round result printed on %s", async (stream) => {
    const runner = new EgoRunner({
      cliPath: await fakeEgo(stream),
      taskSpaceId: 2,
      roundTimeoutMs: 10_000,
      maxHtmlBytes: 1_024,
    });
    const answer = await runner.run("round script", new AbortController().signal);
    expect(answer).toMatchObject({ targetId: "t1", closed: true, value: { ok: 1 } });
  });
});
