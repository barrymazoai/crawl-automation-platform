import { lstat, mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { CodexVisionProvider } from "../../v3-vision/src/provider.js";
import { CodexTextProvider } from "../../v3-text/src/codex-provider.js";
import { CodexRpc, codexConnection } from "../../v3-codex/src/index.js";
import { GncProductInputSchema } from "@crawl-automation/v3-contracts";
import { isDeepStrictEqual as equal } from "node:util";

async function main() {
  if (!/^barrydeMac-mini(?:\.|$)/.test(hostname()) || process.env.V3_GNC_SINGLE_LIVE !== "true") throw Error("MINI_OPT_IN_REQUIRED");
  const root = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu/gallery-v2-renewal";
  const label = process.argv[2] ?? "codex-preflight";
  if (!/^codex-preflight(?:-[a-z0-9-]{1,30})?$/.test(label)) throw Error("INVALID_LABEL");
  const dir = join(root, label), home = join(dir, "profile");
  await mkdir(dir, { mode: 0o700 }); await mkdir(home, { mode: 0o700 });
  const source = "/Users/barry/.codex/auth.json", stat = await lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 65536) throw Error("PRIVATE_AUTH_REQUIRED");
  const auth = await readFile(source); if (JSON.parse(auth.toString()).auth_mode !== "chatgpt") throw Error("CHATGPT_AUTH_REQUIRED");
  const ownedAuth = join(home, "auth.json");
  await writeFile(ownedAuth, auth, { mode: 0o600, flag: "wx" });
  const config = { settings: { provider: "openai", model: "gpt-5.6-luna", reasoningEffort: "medium" },
    executable: "/opt/homebrew/bin/codex", codexHome: home, workRoot: join(dir, "work"), runtimeProfileVersion: "gnc-live/1", timeoutMs: 240000 };
  let provider: Awaited<ReturnType<typeof CodexVisionProvider.open>> | undefined;
  let stage = "profile";
  try {
    await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600, flag: "wx" });
    const input = GncProductInputSchema.parse(JSON.parse(await readFile(join(root, "product-plan.json"), "utf8")).input);
    if (!equal(CodexTextProvider.describe(config), input.text) || CodexVisionProvider.describe(config).configFingerprint !== input.visionConfigFingerprint) throw Error("PROFILE_MISMATCH");
    provider = await CodexVisionProvider.open(config, process.env); stage = "catalog";
    await provider.check(AbortSignal.timeout(60000));
    stage = "account";
    const rpc = new CodexRpc(codexConnection(config, config.workRoot, process.env));
    let accountType: unknown;
    try { await rpc.initialize(AbortSignal.timeout(15000)); const result = await rpc.request("account/read", { refreshToken: false }, AbortSignal.timeout(15000)) as any; accountType = result.account?.type; }
    finally { await rpc.close(); }
    if (accountType !== "chatgpt") throw Error("CHATGPT_AUTH_REQUIRED");
    const report = { status: "ready", settings: config.settings, catalogModalities: ["text", "image"], accountType, models: 0,
      admissionAndQuotaVerified: false, sourceAuthChanged: false };
    await writeFile(join(dir, "report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report));
  } catch (e: any) {
    const raw = e?.code ?? e?.message, code = typeof raw === "string" && /^[A-Z_.]+$/.test(raw) ? raw : "REDACTED";
    const report = { status: "blocked", stage, code, models: 0, sourceAuthChanged: false };
    await writeFile(join(dir, "report.json"), JSON.stringify(report), { flag: "wx", mode: 0o600 }); console.log(JSON.stringify(report)); process.exitCode = 1;
  } finally { await provider?.close(); await unlink(ownedAuth); }
}
main().catch(() => { console.error("PREFLIGHT_UNRESOLVED"); process.exitCode = 1; });
