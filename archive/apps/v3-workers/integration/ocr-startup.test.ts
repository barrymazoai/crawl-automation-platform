import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
const exec = promisify(execFile), entry = resolve("dist/ocr-worker.js");
it("business OCR entry is fail-closed without explicit opt-in", async () => {
  const env = { ...process.env }; delete env.V3_OCR_LIVE_ENABLED; delete env.V3_OCR_CONFIG;
  await expect(exec(process.execPath, [entry, "--list"], { env })).rejects.toMatchObject({ code: 1 });
});
it.each([
  { endpoint: "https://example.com/ocr", provider: "contract-test/1" },
  { endpoint: "http://192.168.0.6:8081/ocr", trustedHttpOrigin: "http://192.168.0.6:8081", minScore: 0.3, provider: "contract-test/2" },
])("read-only metadata requires private config and never connects, including trusted LAN configuration: %j", async provider => {
  const root = await mkdtemp(join(tmpdir(), "ocr-startup-")), path = join(root, "settings.json");
  await writeFile(path, JSON.stringify({ provider,
    bearerToken: "synthetic-fixture-token", storageId: "test/1", cacheRoot: join(root, "cache"), journalRoot: join(root, "journal"),
    r2: { endpoint: `https://${"a".repeat(32)}.r2.cloudflarestorage.com`, bucket: "fixture-only", prefix: "v3/fixture" },
    r2Credentials: { accessKeyId: "synthetic-key", secretAccessKey: "synthetic-secret" },
    resultDatabase: { connectionString: "postgresql://fixture:synthetic-password@127.0.0.1:1/none", tls: false },
    reviewDatabase: { connectionString: "postgresql://fixture:synthetic-password@127.0.0.1:1/none", tls: false } }), { mode: 0o600 });
  const env = { ...process.env, V3_OCR_LIVE_ENABLED: "true", V3_OCR_CONFIG: path };
  const metadata = (await exec(process.execPath, [entry, "--list"], { env })).stdout;
  expect(JSON.parse(metadata)).toEqual([expect.objectContaining({ role: "ocr-file", testOnly: false, capability: "ocr.file", buildId: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
  expect(metadata).not.toContain("synthetic-"); expect(await readFile(entry, "utf8")).not.toContain("FixtureObjects");
  if (process.platform !== "win32") {
    await chmod(path, 0o644);
    await expect(exec(process.execPath, [entry, "--list"], { env })).rejects.toMatchObject({ code: 1 });
  }
});
