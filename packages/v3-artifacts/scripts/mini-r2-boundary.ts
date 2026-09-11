import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, access } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { VisionTaskSchema } from "@crawl-automation/v3-contracts";
import { ArtifactResolver, FileCopies, createR2Objects, sha256 } from "../src/index.js";

// Explicit read-only acceptance: existing authorized GNC image, no PUT/delete API.
async function main() {
  const [mode, configPath, statePath, outputRoot] = process.argv.slice(2);
  assert.ok(mode === "host" || mode === "container");
  assert.ok(configPath && statePath && outputRoot);
  if (mode === "host") assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
  const env = parseEnv(await readFile(configPath, "utf8"));
  const capture = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu";
  const state = mode === "host" ? null : JSON.parse(await readFile(statePath, "utf8"));
  const saved = state ?? await (async () => {
    const task = VisionTaskSchema.parse(JSON.parse(await readFile(join(capture, "gallery-v2-renewal/label-codex-plan/vision-task.json"), "utf8")));
    const { scope } = JSON.parse(await readFile(join(capture, "attempt.json"), "utf8"));
    return { scope, ref: task.input.selection.image, owner: task.input.selection.observation };
  })();
  assert.equal(saved.scope.bucket, "supply-smart-test");
  assert.equal(saved.scope.prefix, "crawlv3-acceptance/gnc-live-19c120bf-a716-4333-b005-e015babea3c3");
  assert.equal(env.CLOUDFLARE_R2_ENDPOINT, saved.scope.endpoint);
  assert.equal(env.CLOUDFLARE_R2_BUCKET, saved.scope.bucket);
  if (mode === "host") await writeFile(statePath, JSON.stringify(saved), { flag: "wx", mode: 0o600 });
  const credentials = { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY! };
  const remote = createR2Objects(saved.scope, credentials);
  let reads = 0;
  const store = { read: (...args: Parameters<typeof remote.store.read>) => { reads++; return remote.store.read(...args); },
    create: async (): Promise<never> => { throw Error("READ_ONLY"); } };
  const cache = await mkdtemp(join(outputRoot, "cache-"));
  const resolver = new ArtifactResolver(await FileCopies.open(cache), store);
  const client = new S3Client({ endpoint: saved.scope.endpoint, region: "auto", credentials: { ...credentials }, maxAttempts: 1, forcePathStyle: true });
  try {
    let hostPathVisible = true;
    try { await access(capture); } catch { hostPathVisible = false; }
    if (mode === "container") assert.equal(hostPathVisible, false);
    const command = new GetObjectCommand({ Bucket: saved.scope.bucket, Key: `${saved.scope.prefix}/${saved.ref.objectKey}` });
    const fresh = await getSignedUrl(client, command, { expiresIn: 60 });
    const good = await fetch(fresh, { signal: AbortSignal.timeout(30000), redirect: "error" });
    assert.equal(good.status, 200);
    assert.equal(sha256(new Uint8Array(await good.arrayBuffer())), saved.ref.sha256);
    // Backdate only this URL's signing time; never change the machine clock.
    const expired = await getSignedUrl(client, command, { expiresIn: 1, signingDate: new Date(Date.now() - 120000) });
    const bad = await fetch(expired, { signal: AbortSignal.timeout(30000), redirect: "error" });
    const body = await bad.text();
    assert.equal(bad.status, 403);
    assert.match(body, /expir/i);
    const first = await resolver.resolve(saved.ref, saved.owner, AbortSignal.timeout(30000));
    const second = await resolver.resolve(saved.ref, saved.owner, AbortSignal.timeout(30000));
    assert.equal(first.from, "remote"); assert.equal(second.from, "local");
    assert.equal(reads, 1); assert.equal(sha256(first.bytes), saved.ref.sha256);
    const report = { mode, status: "passed", hostPathVisible, freshUrlStatus: good.status, expiredUrlStatus: bad.status,
      stableKeyAfterExpiry: first.from, nextRead: second.from, signedReads: reads, urlReads: 2, puts: 0, deletes: 0,
      byteSize: first.bytes.length, sha256: saved.ref.sha256, retentionBasis: "user-confirmed-no-completed-object-expiration" };
    await writeFile(join(outputRoot, `${mode}-report.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally { remote.close(); client.destroy(); }
}
main().catch(() => { console.error("R2_BOUNDARY_CHECK_FAILED"); process.exitCode = 1; });
