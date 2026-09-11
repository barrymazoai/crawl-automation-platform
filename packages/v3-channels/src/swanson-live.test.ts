import { expect, it } from "vitest";
import { RetainedPublication } from "@crawl-automation/v3-artifacts";
import { SwansonCatalogSource, swansonCatalogKey } from "./swanson-catalog-source.js";
import { SwansonLiveProduct } from "./swanson-live-product.js";
import { swansonLiveFixture, SwansonMemory } from "./swanson-live.fixture.js";
const signal = () => AbortSignal.timeout(3000);
it("real catalog fixture publishes two families without inventing selected variants or completeness", async () => {
  const f = swansonLiveFixture(), p = await f.catalog.read(f.input, signal());
  expect(p.entries).toHaveLength(2); expect(p.entries.every(e => e.kind === "family" && e.variantId === null)).toBe(true);
  expect(p.completion).toBe("unknown"); expect(p.endEvidence).toBeNull(); await f.catalog.verify(p, signal());
});
it("versioned evidence can close the displayed family directory with an explicit count, keeping historical receipts unchanged",async()=>{
 const f=swansonLiveFixture();f.browser.capture.mockResolvedValue({...f.projection,evidenceVersion:2,pagination:null});
 const p=await f.catalog.read(f.input,signal());expect(p).toMatchObject({completion:"complete",familyCount:2});expect(p.endEvidence).toEqual(p.source);await f.catalog.verify(p,signal());
});
it("cold catalog retry only reads retained R2-shaped storage, no recapture", async () => {
  const f = swansonLiveFixture(), p = await f.catalog.read(f.input, signal());
  const cold = new SwansonCatalogSource(new RetainedPublication(new SwansonMemory(), f.remote), "A.C. Grace Company");
  expect(await cold.read(f.input, signal())).toEqual(p); expect(f.browser.capture).toHaveBeenCalledOnce();
});
it("uncertain capture acknowledgement is never automatically navigated again", async () => {
  const f = swansonLiveFixture(); f.browser.capture.mockRejectedValue(Error("lost"));
  await expect(f.catalog.read(f.input, signal())).rejects.toThrow("lost");
  await expect(f.catalog.read(f.input, signal())).rejects.toThrow("CAPTURE_UNRESOLVED"); expect(f.browser.capture).toHaveBeenCalledOnce();
});
it.each(["entry", "complete", "owner", "bytes"])("catalog ledger verification rejects %s tampering", async mode => {
  const f = swansonLiveFixture(), p = await f.catalog.read(f.input, signal());
  if (mode === "entry") p.entries[0]!.listingId = "foreign";
  if (mode === "complete") { p.completion = "complete"; p.endEvidence = p.source; }
  if (mode === "owner") p.source.sourceId = "foreign";
  if (mode === "bytes") f.remote.data.set(`${swansonCatalogKey(f.input)}/projection.json`, Buffer.from("{}"));
  await expect(f.catalog.verify(p, signal())).rejects.toThrow();
});
it("unmapped next pages are rejected before browser work", async () => {
  const f = swansonLiveFixture(); await expect(f.catalog.read({ ...f.input, page: 1, cursor: "next" }, signal())).rejects.toThrow("PAGINATION_UNVERIFIED");
  expect(f.browser.capture).not.toHaveBeenCalled();
});
it("retained explicit next-page evidence supports incremental publication and cold readback",async()=>{
 const f=swansonLiveFixture(),next=f.scope.rootUrl+"?page=2";
 f.browser.capture.mockResolvedValueOnce({...f.projection,nextLinks:[next]});
 const first=await f.catalog.read(f.input,signal());expect(first.completion).toBe("more");expect(first.nextCursor).toBe(next);
 f.browser.capture.mockResolvedValueOnce({...f.projection,url:next,headingContext:"A.C. Grace Company\n4 results",nextLinks:[]});
 const input={...f.input,page:1,cursor:next},second=await f.catalog.read(input,signal());expect(second.completion).toBe("unknown");
 const cold=new SwansonCatalogSource(new RetainedPublication(new SwansonMemory(),f.remote),"A.C. Grace Company");
 expect(await cold.read(input,signal())).toEqual(second);expect(f.browser.capture).toHaveBeenCalledTimes(2);
});
it("catalog close failure retains projection but cannot produce a ready page or recapture", async () => {
  const f = swansonLiveFixture();
  const source = new SwansonCatalogSource(f.publication, "A.C. Grace Company", { capture: async (_input, _s, retain) => {
    await retain(f.projection); throw Error("SOURCE.PAGE_CLOSE_UNKNOWN");
  } });
  await expect(source.read(f.input, signal())).rejects.toThrow("PAGE_CLOSE_UNKNOWN");
  expect(f.remote.data.has(`${swansonCatalogKey(f.input)}/projection.json`)).toBe(true);
  expect(await source.inspect(f.input, signal())).toBeNull();
  await expect(source.read(f.input, signal())).rejects.toThrow("CAPTURE_UNRESOLVED");
});
it("family capture learns selected SKU, persists projection then prepares four sources", async () => {
  const f = swansonLiveFixture(), job = await f.job(), result = await f.live.capture(job, signal());
  expect(result.sourcePlan.owner.listingId).toBe(f.product.selectedForms[0].productId);
  expect(result.sourcePlan.owner.variantId).toBe(f.product.selectedForms[0].variantIds[0]);
  expect(result.sourcePlan.owner.listingId).not.toBe(job.discovery.entry.listingId);
  expect(await f.plans.run(result.sourcePlan, signal())).toMatchObject({ status: "prepared", manifest: { sources: expect.any(Array) } });
  expect((await f.plans.inspect(result.sourcePlan, signal()))!.manifest.sources).toHaveLength(4);
});
it("cold product capture does not reopen page or recalculate a mutable identity", async () => {
  const f = swansonLiveFixture(), job = await f.job(), first = await f.live.capture(job, signal());
  const cold = new SwansonLiveProduct(new RetainedPublication(new SwansonMemory(), f.remote), f.settings);
  expect(await cold.capture(job, signal())).toEqual(first); expect(f.productBrowser.capture).toHaveBeenCalledOnce();
});
it("same capture operation with changed settings is a conflict, not recapture", async () => {
  const f = swansonLiveFixture(), job = await f.job(); await f.live.capture(job, signal());
  const changed = new SwansonLiveProduct(f.publication, { ...f.settings, egressId: "other/1" }, f.productBrowser);
  await expect(changed.capture(job, signal())).rejects.toThrow("POLICY_CONFLICT"); expect(f.productBrowser.capture).toHaveBeenCalledOnce();
});
it("capture loss keeps intent and prevents automatic repeat", async () => {
  const f = swansonLiveFixture(), job = await f.job(); f.productBrowser.capture.mockRejectedValue(Error("lost"));
  await expect(f.live.capture(job, signal())).rejects.toThrow("lost");
  await expect(f.live.capture(job, signal())).rejects.toThrow("CAPTURE_UNRESOLVED"); expect(f.productBrowser.capture).toHaveBeenCalledOnce();
});
it("foreign product and ambiguous selected forms never produce a source plan", async () => {
  for (const mode of ["foreign", "forms"]) {
    const f = swansonLiveFixture(), job = await f.job(), p = structuredClone(f.product);
    if (mode === "foreign") p.url = "https://www.swansonvitamins.com/p/other";
    else p.selectedForms.push(p.selectedForms[0]);
    f.productBrowser.capture.mockResolvedValue(p); await expect(f.live.capture(job, signal())).rejects.toThrow();
    expect(await f.live.inspect(job, signal())).toBeNull();
  }
});
