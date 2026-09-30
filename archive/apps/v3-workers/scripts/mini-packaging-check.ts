// Mini-only, read-only real evidence check plus synthetic parser regressions. No model/Workflow writes.
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { readFile, writeFile, mkdtemp, lstat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { join } from "node:path";
import { createR2Objects, FileCopies, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { GncLabelOutcomeSchema, TextDocumentSchema } from "@crawl-automation/v3-contracts";
import { PackagingEvidence, extractPackagingFacts } from "@crawl-automation/v3-product";

assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.equal(process.argv[2], "--read-saved-gnc");
const root = await mkdtemp("/Users/barry/apps/crawlv3-packaging."), config = "/Users/barry/apps/crawlv3-gnc-live-ioVGhu/.env.r2";
const info = await lstat(config); assert.ok(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077));
const env = parseEnv(await readFile(config, "utf8")); assert.equal(env.CLOUDFLARE_R2_BUCKET, "supply-smart-test");
assert.ok(env.CLOUDFLARE_R2_ENDPOINT && env.CLOUDFLARE_R2_ACCESS_KEY_ID && env.CLOUDFLARE_R2_SECRET_ACCESS_KEY);
const r2 = createR2Objects({ endpoint: env.CLOUDFLARE_R2_ENDPOINT, bucket: env.CLOUDFLARE_R2_BUCKET!,
  prefix: "crawlv3-acceptance/gnc-live-19c120bf-a716-4333-b005-e015babea3c3", timeoutMs: 20000 },
  { accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID, secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY });
let reads = 0;
const remote = { read: (...args: Parameters<typeof r2.store.read>) => { reads++; return r2.store.read(...args); },
  create: async (): Promise<never> => { throw Error("READ_ONLY_WRITE_DENIED"); } };
try {
  const parsed = GncLabelOutcomeSchema.parse(JSON.parse(await readFile(new URL("./saved-gnc-manifest.json", import.meta.url), "utf8")).result);
  assert.equal(parsed.status, "prepared"); if (parsed.status !== "prepared") throw Error("NOT_PREPARED");
  const source = parsed.manifest.sources.find(s => s.kind === "text")!;
  assert.ok(source.kind === "text" && source.task.source.kind === "prepared");
  if (source.kind !== "text" || source.task.source.kind !== "prepared") throw Error("NOT_PREPARED");
  const owner = parsed.manifest.observation, ref = source.task.source.document;
  const artifacts = new ArtifactResolver(await FileCopies.open(join(root, "cache")), remote), signal = AbortSignal.timeout(60000);
  const facts = await new PackagingEvidence(artifacts).inspect(owner, [ref], signal);
  const bytes = (await artifacts.resolve(ref, owner, signal)).bytes;
  const document = TextDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  await artifacts.resolve(document.source, owner, signal);
  assert.equal(facts.servingSize.value, "2"); assert.equal(facts.servingsPerContainer.status, "conflict");
  assert.deepEqual(facts.servingsPerContainer.claims.map(c => c.value), ["3", "12"]);
  assert.equal(facts.servingsPerContainer.value, null); assert.equal(facts.productComposition, "unknown");
  assert.equal(facts.containerCount, null); assert.deepEqual(facts.blockingIssues, []);
  assert.ok(facts.warnings.includes("PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"));
  for (const claim of [...facts.servingSize.claims, ...facts.servingsPerContainer.claims, ...facts.unresolvedPackMentions])
    assert.equal(document.text.slice(claim.quote.start, claim.quote.end), claim.quote.text);
  const checks: string[] = [];
  const test = (name: string, fn: () => void) => { fn(); checks.push(name); };
  const parse = (text: string) => extractPackagingFacts(owner, [{ ref, document: { ...document, text } }]);
  test("12 Pack alone is neither servings nor bundle classification", () => {
    const f = parse("Gummies - 12 Pack"); assert.equal(f.servingsPerContainer.status, "unknown");
    assert.equal(f.unresolvedPackMentions[0]?.value, "12 Pack"); assert.equal(f.containerCount, null); assert.equal(f.productComposition, "unknown");
  });
  test("explicit serving count stays separate, no computed total units", () => {
    const f = parse("Serving Size: 2 gummies\nServings Per Container: 12");
    assert.equal(f.servingSize.value, "2 gummies"); assert.equal(f.servingsPerContainer.value, "12"); assert.equal(f.containerCount, null);
  });
  test("conflicting container counts retained as warning, not silently selected", () => {
    const f = parse("Servings Per Container: 3\nServings Per Container\n\n12");
    assert.equal(f.servingsPerContainer.value, null); assert.equal(f.servingsPerContainer.claims.length, 2); assert.equal(f.blockingIssues.length, 0);
  });
  test("serving size conflict is not downgraded", () => {
    assert.deepEqual(parse("Serving Size: 2\nServing Size: 3").blockingIssues, ["PACKAGING.SERVING_SIZE_CONFLICT"]);
  });
  test("repeated equivalent count retains citations without conflict", () => {
    const f = parse("Servings Per Container: 12\nServings Per Container\n12"); assert.equal(f.servingsPerContainer.status, "observed"); assert.equal(f.servingsPerContainer.claims.length, 2);
  });
  test("Pack of 12 and 12-Pack remain unresolved pack expressions", () => {
    const f = parse("Pack of 12\n12-Pack"); assert.equal(f.unresolvedPackMentions.length, 2); assert.equal(f.servingsPerContainer.status, "unknown");
  });
  test("missing quantity does not consume next heading", () => {
    assert.equal(parse("Servings Per Container\nOther Ingredients\nPectin").servingsPerContainer.status, "unknown");
  });
  test("foreign product document is rejected", () => {
    assert.throws(() => extractPackagingFacts(owner, [{ ref, document: { ...document, listingId: "foreign" } }]));
  });
  test("duplicate source rejected", () => {
    assert.throws(() => extractPackagingFacts(owner, [{ ref, document }, { ref, document }]));
  });
  test("source order independent", () => {
    const a = { ref, document }, b = { ref: { ...ref, objectKey: "another/document.json" }, document: { ...document, text: "Servings Per Container: 3" } };
    assert.deepEqual(extractPackagingFacts(owner, [a, b]), extractPackagingFacts(owner, [b, a]));
  });
  await writeFile(join(root, "facts.json"), JSON.stringify(facts, null, 2), { mode: 0o600, flag: "wx" });
  const proof = { status: "passed", root, codec: facts.codec, realSavedEvidence: true, observedContainerCounts: ["3", "12"],
    servingSize: facts.servingSize.value, composition: facts.productComposition, containerCount: facts.containerCount,
    warningCodes: facts.warnings, blockingIssues: facts.blockingIssues, checks, reads, r2Writes: 0, modelCalls: 0,
    databaseWrites: 0, productAdmissionChanged: false };
  await writeFile(join(root, "proof.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" }); console.log(JSON.stringify(proof));
} finally { r2.close(); }
