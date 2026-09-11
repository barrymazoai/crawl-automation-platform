import { readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { LabelCollectedProductSchema } from "@crawl-automation/v3-contracts";
import { fixture, compareGncSample } from "./quality/gnc-sample.js";
const [root, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0); assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/);
assert.match(root ?? "", /^\/Users\/barry\/apps\/crawlv3-gnc-saved\.[A-Za-z0-9]+\/live$/);
const report = JSON.parse(await readFile(join(root!, "report.json"), "utf8"));
assert.equal(report.status, "finished"); assert.equal(report.inputMode, "ego-saved-plan-readonly-files");
const database = JSON.parse(await readFile(join(root!, "database-evidence.json"), "utf8"));
const sources = [];
for (const image of fixture.evidence.images) {
  const bytes = await readFile(`/Users/barry/apps/crawlv3-ego-files.mAw7HF/live/file-cache/${image.sha256}.blob`);
  assert.equal(bytes.length, image.byteSize); assert.equal(createHash("sha256").update(bytes).digest("hex"), image.sha256);
  sources.push({ index: image.index, sha256: image.sha256, verified: true });
}
assert.equal(database.products.length, 1); assert.equal(database.reviews.length, 0);
const raw = database.products[0].record, product = LabelCollectedProductSchema.parse(raw);
assert.equal(product.observation.brandId, fixture.brand.id); assert.equal(product.observation.sourceId, fixture.source.id);
assert.equal(product.observation.listingId, fixture.source.listingId); assert.equal(product.observation.variantId, fixture.source.variantId);
assert.equal(product.observation.observationId, fixture.evidence.observationId);
const candidates = product.provenance.map(p => ({ id: p.id, kind: p.kind, ...compareGncSample(p.candidate) }));
const collected = compareGncSample({ ...raw.provenance[0].candidate, formula: raw.formula, otherIngredients: raw.otherIngredients });
const warnings = product.warnings.map(w => w.code);
const packagingMatches = product.formula.servingsPerContainer === fixture.expected.packaging.collectedServingsPerContainer &&
  fixture.expected.packaging.requiredWarningCodes.every(code => warnings.includes(code));
const proof = { at: new Date().toISOString(), fixtureId: fixture.id, reviewStatus: fixture.review.status,
  model: report.model, effort: report.effort, sources, candidates, collected, packagingMatches, warnings,
  status: candidates.every(c => c.status === "match") && collected.status === "match" && packagingMatches ? "match" : "mismatch",
  legacyDatabaseRead: false, providerCalls: 0, productWrites: 0, userReviewed: false };
await writeFile(join(root!, "quality-verification.json"), JSON.stringify(proof, null, 2), { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(proof));
if (proof.status !== "match") process.exitCode = 1;
