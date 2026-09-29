import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** How the fake Codex CLI behaves for one test. */
export type FakeCodexMode = "answer" | "failed" | "exit" | "garbage" | "hang" | "silent" | "large";

/**
 * A stand-in for the `codex` executable: it records how it was started (arguments, prompt, environment names, the
 * attached image) under CODEX_HOME, then prints `codex exec --experimental-json` events for its mode.
 */
function fakeCodexScript(mode: FakeCodexMode): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.on("data", (chunk) => (prompt += chunk));
process.stdin.on("end", () => {
  const imageAt = args.indexOf("--image");
  const image = imageAt >= 0 ? fs.readFileSync(args[imageAt + 1]).toString("hex") : null;
  const call = { args, prompt, env: Object.keys(process.env).sort(), home: process.env.HOME, image };
  fs.appendFileSync(path.join(process.env.CODEX_HOME, "calls.jsonl"), JSON.stringify(call) + "\\n");
  const say = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  const mode = ${JSON.stringify(mode)};
  say({ type: "thread.started", thread_id: "thread-1" });
  say({ type: "turn.started" });
  if (mode === "hang") { setInterval(() => undefined, 1000); return; }
  if (mode === "exit") { process.stderr.write("boom token=secret-value"); process.exit(3); }
  if (mode === "garbage") { process.stdout.write("not json\\n"); return; }
  if (mode === "failed") { say({ type: "turn.failed", error: { message: "rate limit, api_key=sk-abcdefghijkl" } }); return; }
  if (mode === "large") { say({ type: "item.completed", item: { id: "m", type: "agent_message", text: "x".repeat(260000) } }); }
  if (mode === "answer") { say({ type: "item.completed", item: { id: "m", type: "agent_message", text: "{\\"ok\\":true}" } }); }
  say({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
});
`;
}

/** Private directories and a fake executable for one test, plus the calls it recorded. */
export async function fakeCodex(mode: FakeCodexMode) {
  const root = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const codexHome = join(root, "home");
  const workRoot = join(root, "work");
  await mkdir(codexHome, { mode: 0o700 });
  const executable = join(root, "codex");
  await writeFile(executable, fakeCodexScript(mode));
  await chmod(executable, 0o755);
  const settings = {
    settings: { provider: "openai", model: "gpt-5.5", reasoningEffort: "high" },
    executable,
    codexHome,
    workRoot,
    runtimeProfileVersion: "fixture-profile/1",
    timeoutMs: 5000,
  };
  const calls = async () =>
    (await readFile(join(codexHome, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            args: string[];
            prompt: string;
            env: string[];
            home: string;
            image: string | null;
          },
      );
  return { root, settings, calls };
}
