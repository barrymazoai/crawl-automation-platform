import { mkdtemp, mkdir, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CodexTextProvider, codexTextConnection, type CodexConnectionOptions } from "./codex-provider.js";
import { CodexRpc } from "./codex-rpc.js";
const fixture = fileURLToPath(new URL("./codex.fixture.mjs", import.meta.url));
const request = { operationId: "operation", prompt: "evidence", outputSchema: { type: "object" } };
async function setup(scenario = "success") {
  const root = await mkdtemp(join(tmpdir(), "v3-codex-provider-"));
  const home = join(root, "auth"); await mkdir(home, { mode: 0o700 });
  const config = { settings: { provider: "fixture", model: "fixture-model", reasoningEffort: "high" },
    executable: process.execPath, codexHome: home, workRoot: join(root, "work"), timeoutMs: 3000, runtimeProfileVersion: "fixture/1" };
  const connections: CodexConnectionOptions[] = [];
  const provider = await CodexTextProvider.open(config, { PATH: "fixture-path", ALL_PROXY: "http://existing-proxy", R2_SECRET: "do-not-inherit" }, options => {
    connections.push(options);
    return new CodexRpc({ ...options, executable: process.execPath, args: [fixture, scenario], env: {} });
  });
  return { config, provider, connections };
}
it("runs one owned process with explicit settings and retries disabled", async () => {
  const f = await setup();
  try {
    expect(await f.provider.interpret(request, AbortSignal.timeout(4000))).toContain('"formula"');
    expect(f.connections).toHaveLength(1);
    expect(f.provider.policy).toMatchObject({ executionRetries: 0, internalModelRequests: "no-retries" });
    expect(f.connections[0]!.env).toMatchObject({ ALL_PROXY: "http://existing-proxy" });
    expect(f.connections[0]!.env).not.toHaveProperty("R2_SECRET");
    expect(f.connections[0]!.args.join(" ")).not.toMatch(/dangerously|danger-full-access/);
    expect(f.connections[0]!.args).toContain("model_providers.fixture.request_max_retries=0");
    expect(f.connections[0]!.args).toContain("model_providers.fixture.stream_max_retries=0");
    expect(await readdir(f.config.workRoot)).toEqual([]);
  } finally { await f.provider.close(); }
});
it("never restarts a failed business execution", async () => {
  const f = await setup("failed-turn");
  try {
    await expect(f.provider.interpret(request, AbortSignal.timeout(4000))).rejects.toThrow();
    expect(f.connections).toHaveLength(1);
    await expect(access(f.connections[0]!.cwd)).rejects.toThrow();
  } finally { await f.provider.close(); }
});
it("isolates concurrent operations with different working directories and processes", async () => {
  const f = await setup();
  try {
    await Promise.all(["one", "two"].map(operationId => f.provider.interpret({ ...request, operationId }, AbortSignal.timeout(4000))));
    expect(f.connections).toHaveLength(2);
    expect(new Set(f.connections.map(c => c.cwd)).size).toBe(2);
  } finally { await f.provider.close(); }
});
it("startup check only reads capabilities without a turn", async () => {
  const f = await setup("catalog-provider");
  try { await expect(f.provider.check(AbortSignal.timeout(4000))).rejects.toThrow("TEXT.CODEX_CATALOG_PROVIDER_MISMATCH"); }
  finally { await f.provider.close(); }
});
it("rejects new work after close without spawning", async () => {
  const f = await setup(); await f.provider.close();
  await expect(f.provider.interpret(request, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(f.connections).toHaveLength(0);
});
it("close cancels active work and creates no replacement", async () => {
  const f = await setup("internal-hang");
  const pending = f.provider.interpret(request, AbortSignal.timeout(4000));
  const assertion = expect(pending).rejects.toThrow();
  while (!f.connections.length) await new Promise(r => setTimeout(r, 5));
  await f.provider.close(); await assertion;
  expect(f.connections).toHaveLength(1);
});
it("version and timeout affect task compatibility, private node paths do not", async () => {
  const f = await setup();
  try {
    const expected = CodexTextProvider.describe(f.config);
    expect(CodexTextProvider.describe({ ...f.config, codexHome: "/other/private/home" })).toEqual(expected);
    expect(CodexTextProvider.describe({ ...f.config, runtimeProfileVersion: "fixture/2" })).not.toEqual(expected);
    expect(CodexTextProvider.describe({ ...f.config, timeoutMs: 10000 })).not.toEqual(expected);
  } finally { await f.provider.close(); }
});
it("does not inherit arbitrary environment secrets or rewrite existing proxy settings", async () => {
  const f = await setup();
  try {
    const c = codexTextConnection(f.config, "/isolated/task", { HTTPS_PROXY: "http://proxy", DATABASE_URL: "secret", CODEX_HOME: "/personal", HOME: "/personal" });
    expect(c.env).toEqual({ HTTPS_PROXY: "http://proxy", HOME: "/isolated/task", CODEX_HOME: f.config.codexHome });
  } finally { await f.provider.close(); }
});

it('attests process close even when the model turn fails',async()=>{
 const f=await setup('failed-turn'),stopped=vi.fn();
 try{await expect(f.provider.interpret(request,AbortSignal.timeout(4000),stopped)).rejects.toThrow();expect(stopped).toHaveBeenCalledOnce();}
 finally{await f.provider.close();}
});
