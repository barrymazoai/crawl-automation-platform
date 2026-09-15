import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { CodexRpc, type CodexConnectionOptions } from "@crawl-automation/v3-codex";
import { CodexVisionProvider } from "./provider.js";
import { image, bytes } from "./testing.fixture.js";
const fixture = fileURLToPath(new URL("./codex.fixture.mjs", import.meta.url));
async function setup(scenario = "ok") {
  const root = await mkdtemp(join(tmpdir(), "v3-vision-provider-")), profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
  const connections: CodexConnectionOptions[] = [];
  const provider = await CodexVisionProvider.open({ settings: { model: "fixture", provider: "fixture", reasoningEffort: "medium" },
    executable: process.execPath, codexHome: profile, workRoot: join(root, "work"), runtimeProfileVersion: "fixture/1", timeoutMs: 3000 },
    { ALL_PROXY: "http://existing", DATABASE_URL: "secret" }, options => {
      connections.push(options); return new CodexRpc({ ...options, executable: process.execPath, args: [fixture, scenario], env: {} });
    });
  return { provider, connections };
}
it("attaches original bytes with original detail, no tools and unchanged proxy", async () => {
  const f = await setup();
  try {
    expect(JSON.parse(await f.provider.interpret(image, bytes, AbortSignal.timeout(4000)))).toEqual({ hash: image.sha256 });
    expect(f.connections).toHaveLength(1); expect(f.connections[0]!.env).not.toHaveProperty("DATABASE_URL");
    expect(f.connections[0]!.env.ALL_PROXY).toBe("http://existing");
    expect(f.connections[0]!.args).toContain("tools.view_image=false");
  } finally { await f.provider.close(); }
});
it("rejects text-only models before sending an image turn", async () => {
  const f = await setup("text-only");
  try { await expect(f.provider.interpret(image, bytes, AbortSignal.timeout(4000))).rejects.toThrow("VISION.CODEX_IMAGE_UNSUPPORTED"); }
  finally { await f.provider.close(); }
});
it("concurrent image calls have separate processes and private image files", async () => {
  const f = await setup();
  try {
    await Promise.all([1, 2].map(() => f.provider.interpret(image, bytes, AbortSignal.timeout(4000))));
    expect(new Set(f.connections.map(c => c.cwd)).size).toBe(2);
  } finally { await f.provider.close(); }
});
it("closed providers cannot start new image executions", async () => {
  const f = await setup(); await f.provider.close();
  await expect(f.provider.interpret(image, bytes, AbortSignal.timeout(1000))).rejects.toThrow();
  expect(f.connections).toHaveLength(0);
});

it('attests process close even when capability validation fails',async()=>{
 const f=await setup('text-only'),stopped=vi.fn();
 try{await expect(f.provider.interpret(image,bytes,AbortSignal.timeout(4000),stopped)).rejects.toThrow();expect(stopped).toHaveBeenCalledOnce();}
 finally{await f.provider.close();}
});
