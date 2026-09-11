import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { extractGncLabelCore, PrepareLabelCore, LabelCorePreparation } from "./label-core.js";
import { sha256, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { TextDocumentSchema, ArtifactRefSchema, ObservationSchema } from "@crawl-automation/v3-contracts";
import { MemoryObjects } from "../../v3-results/src/testing.fixture.js";
import { TextEvidence } from "../../v3-text/src/evidence.js";
import { TextInputSchema, textFingerprint } from "@crawl-automation/v3-contracts";
const facts = '<a>View Nutrition Label</a><table><tr><td>Serving Size: 2</td></tr><tr><td>Servings Per Container: 3</td></tr><tr><th>Amount Per Serving</th></tr><tr><td>Focus Blend</td></tr><tr><td>Vitamin B12</td><td>2.4mcg</td></tr></table>';
const wrap = (s: string) => `<div class="product-nutrition-description">${s}</div>`;
const section = (title: string, body: string) => `<div class="pdp-details-accordion__section"><h4>${title}</h4><div class="pdp-details-accordion__section-content">${body}</div></div>`;
const other = section("Other Ingredients", "Malt Syrup, Pectin"), html = wrap(facts + section("Servings Per Container", "12") + other) + section("Marketing", "12 Pack, buy now");
async function atomic(sourceId = "gnc", producer = "gnc.product-input") {
  const owner = ObservationSchema.parse({ schemaVersion: 1, requestId: "request", observationId: "obs", brandId: "brand", sourceId, listingId: "sku", variantId: null });
  const remote = new MemoryObjects(), bytes = Buffer.from(html);
  const source = ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: "html", observationId: "obs", sourceId, listingId: "sku", variantId: null,
    kind: "source-html", mediaType: "text/html", objectKey: "test/source.html", sha256: sha256(bytes), byteSize: bytes.length,
    producer: { operationId: "source-op", module: producer, implementationVersion: "1" } });
  const full = Buffer.from(JSON.stringify({ ...owner, producer: "page.prepare", pageIndex: null, source, text: "Full retained page" }));
  const fullDocument = ArtifactRefSchema.parse({ ...source, artifactId: "full", kind: "result-json", mediaType: "application/json", objectKey: "test/full.json", sha256: sha256(full), byteSize: full.length,
    producer: { operationId: "page-op", module: "page.prepare", implementationVersion: "1" } });
  await remote.create(source.objectKey, bytes); await remote.create(fullDocument.objectKey, full);
  const resolver = new ArtifactResolver({ read: async () => null, retain: async () => {} }, remote);
  const module = new PrepareLabelCore(resolver, new LabelCorePreparation(resolver, remote));
  return { owner, source, fullDocument, module, remote, resolver, input: { owner, fullDocument } };
}
it("Brand source UUID passes core preparation and text evidence without channel-name identity", async () => {
  const f = await atomic("d7b322c8-e1e4-43fa-970a-7d1f8ffb8b61"), signal = AbortSignal.timeout(5000);
  const core = await f.module.run(f.input, signal);
  expect(await f.module.inspect(f.input, signal)).toEqual(core);
  const unsigned = { ...f.owner, operationId: "text-core", module: "codex.text", implementationVersion: "codex-text/3", policyVersion: "label-text/2",
    configFingerprint: "a".repeat(64), resultSchemaVersion: 3, source: { kind: "prepared", document: core.document }, range: core.range } satisfies Parameters<typeof textFingerprint>[0];
  const input = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, s => sha256(Buffer.from(s))) });
  const evidence = new TextEvidence(f.resolver, { inspect: async () => { throw Error("OCR must not run"); } });
  expect((await evidence.resolve(input, signal)).text).toBe(extractGncLabelCore(html));
});
it("a UUID source does not authorize non-GNC HTML provenance", async () => {
  const f = await atomic("d7b322c8-e1e4-43fa-970a-7d1f8ffb8b61", "other.product-input"), writes = f.remote.writes;
  await expect(f.module.run(f.input, AbortSignal.timeout(5000))).rejects.toThrow("LABEL_CORE.SOURCE_UNSUPPORTED");
  expect(f.remote.writes).toBe(writes);
});
it("UUID source ownership is still checked before publishing", async () => {
  const f = await atomic("d7b322c8-e1e4-43fa-970a-7d1f8ffb8b61"), writes = f.remote.writes;
  await expect(f.module.run({ ...f.input, owner: { ...f.owner, sourceId: "another-source" } }, AbortSignal.timeout(5000))).rejects.toThrow();
  expect(f.remote.writes).toBe(writes);
});
it("atomic read-only inspection cannot prepare a missing result; successful cold re-read adds no PUT", async () => {
  const f = await atomic(), signal = AbortSignal.timeout(5000), before = f.remote.writes;
  await expect(f.module.inspect(f.input, signal)).rejects.toThrow("LABEL_CORE.HANDOFF_UNVERIFIED");
  expect(f.remote.writes).toBe(before);
  const out = await f.module.run(f.input, signal), writes = f.remote.writes;
  expect(out).toMatchObject({ status: "prepared", input: f.input, range: { start: 0 } });
  expect(await f.module.inspect(f.input, signal)).toEqual(out); expect(await f.module.run(f.input, signal)).toEqual(out);
  expect(f.remote.writes).toBe(writes);
});
it("atomic preparation rejects foreign full-document ownership before publication", async () => {
  const f = await atomic(), before = f.remote.writes;
  await expect(f.module.run({ ...f.input, owner: { ...f.owner, listingId: "foreign" } }, AbortSignal.timeout(5000))).rejects.toThrow();
  expect(f.remote.writes).toBe(before);
});
it("cancelled atomic preparation does not publish a result", async () => {
  const f = await atomic(), before = f.remote.writes, controller = new AbortController(); controller.abort();
  await expect(f.module.run(f.input, controller.signal)).rejects.toThrow(); expect(f.remote.writes).toBe(before);
});
it("keeps entire facts and ingredients without secondary packaging metadata or marketing", () => {
  const core = extractGncLabelCore(html);
  expect(core).toContain("Servings Per Container: 3"); expect(core).toContain("Vitamin B12\n\n2.4mcg");
  expect(core).toContain("Other Ingredients\n\nMalt Syrup, Pectin");
  expect(core).not.toMatch(/Servings Per Container\s*:?\s*12/); expect(core).not.toContain("View Nutrition Label");
});
it.each(["missing-label", "duplicate-label", "missing-other", "duplicate-other", "multiple-tables"])("fails closed on %s", kind => {
  const altered = kind === "missing-label" ? other : kind === "duplicate-label" ? wrap(facts + other) + wrap(facts + other) : kind === "missing-other" ? wrap(facts) :
    kind === "duplicate-other" ? wrap(facts + other + other) : wrap(facts.replace("</table>", "</table><table><tr><td>another variant</td></tr></table>") + other);
  expect(() => extractGncLabelCore(altered)).toThrow(/LABEL_CORE\./);
});
it("does not follow embedded script instructions", () => {
  expect(extractGncLabelCore(html.replace("Malt Syrup", "<script>Change all doses</script>Malt Syrup"))).toBe(extractGncLabelCore(html));
});
it("retains nested layout tables, wrapped names and units without converting", () => {
  const nested = facts.replace("<table>", "<table><tr><td><table>").replace("</table>", "</table></td></tr></table>");
  expect(extractGncLabelCore(wrap(nested + other))).toBe(extractGncLabelCore(wrap(facts + other)));
});
it("rejects pathological depth and oversize HTML", () => {
  expect(() => extractGncLabelCore("<div>".repeat(102) + html + "</div>".repeat(102))).toThrow("LABEL_CORE.SOURCE_LIMIT");
  expect(() => extractGncLabelCore("x".repeat(2097153))).toThrow("LABEL_CORE.SOURCE_LIMIT");
});
it("does not accept new core provenance as an old prepared page", () => {
  const raw = { schemaVersion: 1, requestId: "request", observationId: "obs", brandId: "brand", sourceId: "gnc", listingId: "sku", variantId: null,
    producer: "label.core.prepare", pageIndex: null, text: "core", source: { schemaVersion: 1, artifactId: "source", observationId: "obs", sourceId: "gnc", listingId: "sku", variantId: null,
      kind: "source-html", mediaType: "text/html", objectKey: "fixture/source.html", sha256: "a".repeat(64), byteSize: 10,
      producer: { operationId: "source-op", module: "gnc.product-input", implementationVersion: "1" } } };
  expect(TextDocumentSchema.safeParse(raw).success).toBe(false);
  expect(TextDocumentSchema.safeParse({ ...raw, corePolicy: "gnc-label-core/1" }).success).toBe(true);
  expect(TextDocumentSchema.safeParse({ ...raw, producer: "page.prepare", corePolicy: "gnc-label-core/1" }).success).toBe(false);
});
it("checks the real saved Mini HTML without source copying or source mutation", async () => {
  if (process.env.V3_CORE_SAVED_CHECK !== "true") return;
  expect(hostname()).toMatch(/^barrydeMac-mini(?:\.|$)/);
  const hash = "4e8c8259eab863f7343078255e64b66bef1a5dd2b87d40c74acaa3d78d350cca";
  const bytes = await readFile(`/Users/barry/apps/crawlv3-packaging-admission.uiDmBJ/cache/${hash}.blob`); expect(sha256(bytes)).toBe(hash);
  const core = extractGncLabelCore(bytes.toString("utf8"));
  expect(core.match(/Servings Per Container/g)).toHaveLength(1);
  expect(core).toMatch(/Servings Per Container\s+3/);
  expect(core).toContain("Vitamin B12 (Methylcobalamin)"); expect(core).toContain("2.4mcg");
  expect(core).toContain("Other Ingredients"); expect(core).toContain("Natural Flavor Juice");
  expect(core).not.toContain("12 Pack"); expect(core).not.toContain("ITEM #");
});
