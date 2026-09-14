import { expect, it } from "vitest";
import { AmazonLinkCatalog, AmazonLinkBatchSchema, AmazonLinkBatchesSchema } from "./amazon-link-batches.js";
import { amazonFixture, AmazonMemory, RetainedPublication } from "../../../packages/v3-channels/src/amazon-live.fixture.js";
const signal = () => AbortSignal.timeout(3000);
function fixture() {
  const f = amazonFixture(), requestId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
  const scope = { ...f.scope, region: "US", rootUrl: "https://www.amazon.com/" };
  const batch = AmazonLinkBatchSchema.parse({ codec: "amazon-link-batch/1", requestId, scope,
    candidateManifestSha256: "a".repeat(64), entries: [{ candidateId: "b".repeat(64), historyListingId: "c".repeat(64),
      entry: { listingId: "B000REPUY0", variantId: null, kind: "product", url: f.url } }] });
  return { ...f, batch, input: { ...f.input, catalogId: requestId, scope } };
}
it("retains explicit link provenance through cold replay without claiming catalog completeness", async () => {
  const f = fixture(), source = new AmazonLinkCatalog(f.publication, f.batch), page = await source.read(f.input, signal());
  expect(page).toMatchObject({ completion: "unknown", endEvidence: null, entries: [f.batch.entries[0]!.entry] });
  const cold = new AmazonLinkCatalog(new RetainedPublication(new AmazonMemory(), f.remote), f.batch);
  expect(await cold.read(f.input, signal())).toEqual(page);
  expect(f.browser.capture).not.toHaveBeenCalled();
  await expect(cold.verify({ ...page, completion: "complete", endEvidence: page.source }, signal())).rejects.toThrow();
});
it.each(["request", "scope", "page", "cursor"])("rejects foreign %s before retaining a list", async field => {
  const f = fixture(), input = { ...structuredClone(f.input), cursor: null as string | null };
  if (field === "request") input.catalogId = "foreign";
  if (field === "scope") input.scope.region = "JP";
  if (field === "page") input.page = 1;
  if (field === "cursor") input.cursor = "next";
  await expect(new AmazonLinkCatalog(f.publication, f.batch).read(input, signal())).rejects.toThrow("LINK_SCOPE_CONFLICT");
});
it("rejects altered retained entries and a changed manifest for the same request", async () => {
  const f = fixture(), page = await new AmazonLinkCatalog(f.publication, f.batch).read(f.input, signal());
  const changed = structuredClone(f.batch); changed.entries[0]!.entry = { ...changed.entries[0]!.entry, listingId: "B000000002", url: "https://www.amazon.com/dp/B000000002" };
  await expect(new AmazonLinkCatalog(f.publication, changed).verify(page, signal())).rejects.toThrow("LINK_EVIDENCE_CONFLICT");
});
it("bounds each submission and rejects conflicting identities, external origins and duplicate request IDs", () => {
  const f = fixture(), bad = structuredClone(f.batch);
  bad.entries.push(bad.entries[0]!); expect(AmazonLinkBatchSchema.safeParse(bad).success).toBe(false);
  bad.entries = structuredClone(f.batch.entries); bad.entries[0]!.entry.url = "https://evil.example/dp/B000REPUY0";
  expect(AmazonLinkBatchSchema.safeParse(bad).success).toBe(false);
  bad.entries[0]!.entry.url = "https://www.amazon.com/dp/B000000002";
  expect(AmazonLinkBatchSchema.safeParse(bad).success).toBe(false);
  expect(AmazonLinkBatchesSchema.safeParse([f.batch, f.batch]).success).toBe(false);
});
it("admits one bounded ten-product Temporal request and rejects an eleventh entry", async () => {
  const f = fixture();
  const entries = Array.from({ length: 11 }, (_, i) => {
    const asin = `B${String(i).padStart(9, "0")}`;
    return { ...f.batch.entries[0]!, entry: { ...f.batch.entries[0]!.entry, listingId: asin, url: `https://www.amazon.com/dp/${asin}` } };
  });
  const batch = { ...f.batch, entries: entries.slice(0, 10) };
  const page = await new AmazonLinkCatalog(f.publication, batch).read(f.input, signal());
  expect(page.entries).toHaveLength(10); expect(page.completion).toBe("unknown");
  expect(AmazonLinkBatchSchema.safeParse({ ...batch, entries }).success).toBe(false);
});
it('imported ASIN capture requires explicit request authorization instead of a fabricated store directory',async()=>{
 const f=fixture(),page=await new AmazonLinkCatalog(f.publication,f.batch).read(f.input,signal());
 const job=await f.job();job.discovery.catalogId=f.batch.requestId;job.discovery.scope=f.batch.scope;job.discovery.source=page.source;
 const {AmazonLiveProduct}=await import('../../../packages/v3-channels/src/amazon-live-product.js');
 const allowed=new AmazonLiveProduct(f.publication,f.settings,f.productBrowser,[f.batch.requestId]);
 const capture=await allowed.capture(job,signal());expect(capture.sourcePlan.owner.listingId).toBe('B000REPUY0');
 await expect(new AmazonLiveProduct(f.publication,f.settings).inspect(job,signal())).rejects.toThrow();
 expect(await new AmazonLiveProduct(f.publication,f.settings,undefined,[f.batch.requestId]).inspect(job,signal())).toEqual(capture);
});
