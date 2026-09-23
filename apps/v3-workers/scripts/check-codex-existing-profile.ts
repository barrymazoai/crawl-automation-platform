// Read-only startup check. Uses the existing private profile without starting a thread/turn.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { CodexTextProvider } from "@crawl-automation/v3-text";
import { CodexVisionProvider } from "@crawl-automation/v3-vision";
if (!/^(servers-Mac-mini|RC-workstation)(?:\.|$)/i.test(hostname())) throw Error("Run on the deployment host");
const config = JSON.parse(await readFile(process.argv[2]!, "utf8"));
let p: CodexTextProvider | CodexVisionProvider | undefined;
try {
  p = await (process.argv[3] === "--vision" ? CodexVisionProvider : CodexTextProvider).open(config.codex, process.env);
  await p.check(AbortSignal.timeout(30000));
  console.log(JSON.stringify({ existingProfilePreflight: "passed", modelTurnStarted: false }));
} catch (e) {
  console.log(JSON.stringify({ existingProfilePreflight: "failed", code: (e as {code?: string}).code ?? "UNKNOWN" }));
  process.exitCode = 1;
} finally { await p?.close(); }
