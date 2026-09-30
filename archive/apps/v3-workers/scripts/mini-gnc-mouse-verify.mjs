// Read-only audit of the latest native-mouse attempt; never invokes browser/input.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { parseEnv } from "node:util";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
const [root] = process.argv.slice(2);
assert.equal(process.argv.slice(2).length, 1);
assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root ?? "", /^\/Users\/barry\/apps\/crawlv3-gnc-pool\.[A-Za-z0-9]+\/live$/);
const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
assert.equal(report.status, "finished");
const input = JSON.parse(await readFile(join(root, "workflow-input.json"), "utf8"));
const base = `v3/gnc-mouse/${input.input.sourcePlan.task.capture.operationId}`;
const local = join(root, "gnc-product", "journal", base);
const env = parseEnv(await readFile("/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2", "utf8"));
assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
assert.equal(report.prefix, `crawlv3-acceptance/gnc-e2e-${report.id}`);
const client = new S3Client({ region: "auto", endpoint: env.CLOUDFLARE_R2_ENDPOINT,
  credentials: { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY } });
try {
  const names = (await readdir(local)).filter(n => /^(before\.html|location\.json|located\.(html|png)|target\.json|result\.json|after\.(html|png)|after-dom\.json)$/.test(n));
  assert.ok(names.includes("before.html") && names.includes("result.json"));
  const objects = [];
  for (const name of names) {
    const bytes = await readFile(join(local, name));
    const response = await client.send(new GetObjectCommand({Bucket:env.CLOUDFLARE_R2_BUCKET,Key:`${report.prefix}/${base}/${name}`}));
    const remote = Buffer.from(await response.Body.transformToByteArray());
    assert.ok(bytes.equals(remote));
    objects.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const result = JSON.parse(await readFile(join(local, "result.json"), "utf8"));
  if (result.attempts === 1) {
    const target = JSON.parse(await readFile(join(local, "target.json"), "utf8"));
    const response = await client.send(new GetObjectCommand({Bucket:env.CLOUDFLARE_R2_BUCKET,Key:`${report.prefix}/${base}/attempt.json`}));
    const marker = JSON.parse(await response.Body.transformToString());
    assert.deepEqual(marker, {operationId:result.operationId,request:target.request});
  }
  assert.equal(result.codexCalls, 0);
  const proof = { at: new Date().toISOString(), workflowId:report.workflowId, objects,
    nativeInvocations:result.attempts, codexCalls:result.codexCalls, stage:result.stage, status:result.status, code:result.code,
    downEvents:(result.events??[]).filter(e=>e.event==="DOWN_POSTED").length,
    upEvents:(result.events??[]).filter(e=>e.event==="UP_POSTED").length,
    nativeErrors:(result.events??[]).filter(e=>e.ok===false).map(e=>e.error), r2MatchesLocal:true };
  await writeFile(join(root,"mouse-verification.json"),JSON.stringify(proof,null,2),{flag:"wx",mode:0o600});
  console.log(JSON.stringify(proof));
} finally { client.destroy(); }
