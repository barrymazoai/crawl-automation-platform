import { expect, it, vi } from "vitest";
import { ChannelBrandResolutions, resolveSwansonBrand, SWANSON_BRANDS_URL } from "./channel-brand.js";
import { RetainedPublication, type ObjectStore } from "@crawl-automation/v3-artifacts";
const url = "https://www.swansonvitamins.com/collections/brand-ac-grace-company";
const input = { operationId: "brand-link-test", brandId: "ac-grace", brandRevision: 1, channel: "swanson", region: "US", name: "A.C. Grace Company" };
const directory = { codec: "swanson-brand-directory/1", url: SWANSON_BRANDS_URL, capturedAt: "2026-09-10T02:00:00.000Z", title: "Shop your favorite brands", searchValue: "", entries: [{ name: input.name, url }] };
it("exact directory name yields its actual URL, not a guessed slug", () => expect(resolveSwansonBrand(input, directory)).toMatchObject({ status: "resolved", url, basis: "exact-name" }));
it("normalizes case, unicode compatibility and whitespace only", () => expect(resolveSwansonBrand({ ...input, name: "Ａ.Ｃ.  Grace Company" }, directory)).toMatchObject({ status: "resolved" }));
it("does not guess company suffix or fuzzy punctuation aliases", () => expect(resolveSwansonBrand({ ...input, name: "AC Grace" }, directory)).toMatchObject({ status: "review", code: "BRAND_LINK.NOT_FOUND", automaticRetry: false }));
it("uses only explicitly supplied aliases", () => expect(resolveSwansonBrand({ ...input, name: "AC Grace", aliases: [input.name] }, directory)).toMatchObject({ status: "resolved", basis: "explicit-alias" }));
it("different matching destinations are ambiguous, even if one matches the primary name", () => {
  const d = { ...directory, entries: [...directory.entries, { name: "Unique E", url: url + "-other" }] };
  expect(resolveSwansonBrand({ ...input, aliases: ["Unique E"] }, d)).toMatchObject({ status: "review", code: "BRAND_LINK.AMBIGUOUS" });
});
it("duplicate links to the same destination do not invent ambiguity", () => expect(resolveSwansonBrand(input, { ...directory, entries: [...directory.entries, ...directory.entries] })).toMatchObject({ status: "resolved" }));
it("public aggregate collections are retained in evidence but not treated as individual brands",()=>{
  const d={...directory,entries:[...directory.entries,{name:"Partner Brands",url:"https://www.swansonvitamins.com/collections/partner-brands"}]};
  expect(resolveSwansonBrand(input,d)).toMatchObject({status:"resolved"});
  expect(resolveSwansonBrand({...input,name:"Partner Brands"},d)).toMatchObject({status:"review",code:"BRAND_LINK.NOT_FOUND"});
});
it("filtered directory is not proof a brand is missing", () => expect(resolveSwansonBrand(input, { ...directory, searchValue: "other" })).toMatchObject({ status: "review", code: "BRAND_LINK.DIRECTORY_FILTERED" }));
it("existing source skips discovery entirely", () => expect(resolveSwansonBrand({ ...input, existingUrl: url }, null)).toMatchObject({ status: "resolved", basis: "existing-source" }));
it.each(["https://evil.example/collections/brand-ac-grace-company", url + "?token=secret", url + "#route", "https://www.swansonvitamins.com/brands/ac-grace"])("rejects unsupported candidate %s", candidate => expect(() => resolveSwansonBrand(input, { ...directory, entries: [{ name: input.name, url: candidate }] })).toThrow());
class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => { if (this.data.has(key)) return "exists" as const; this.data.set(key, bytes); return "created" as const; });
}
it("retained unresolved brand is passive; later directory changes do not replay it", async () => {
  const local = new Memory(), remote = new Memory(), module = new ChannelBrandResolutions(new RetainedPublication(local, remote));
  const signal = new AbortController().signal, request = { ...input, name: "missing" };
  const a = await module.run(request, directory, signal), puts = remote.create.mock.calls.length;
  const b = await new ChannelBrandResolutions(new RetainedPublication(new Memory(), remote)).run(request, { ...directory, entries: [{ name: "missing", url }] }, signal);
  expect(b).toEqual(a); expect(b.decision.status).toBe("review"); expect(remote.create).toHaveBeenCalledTimes(puts);
  await expect(module.run({ ...request, brandRevision: 2 }, directory, signal)).rejects.toThrow("INPUT_CONFLICT");
});
