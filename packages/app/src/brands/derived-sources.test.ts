import { expect, it, vi } from "vitest";
import { DerivedBrandSources } from "./derived-sources.js";
import type { ScanSource } from "../brand-scans/scan-model.js";

const id = "11111111-1111-4111-8111-111111111111";
const source: ScanSource = {
  sourceId: id,
  brandId: id,
  brandName: "Example",
  channel: "amazon",
  url: "https://source.example/brand",
  enabled: false,
};
function setup(rows: ScanSource[] = [source]) {
  const existing = new Set<string>();
  const addDisabledSources = vi.fn(async (rows: readonly { brandId: string; url: string }[]) => {
    const before = existing.size;
    rows.forEach((row) => existing.add(`${row.brandId}:${row.url}`));
    const created = existing.size - before;
    return { created, existing: rows.length - created };
  });
  const derive = vi.fn((row: ScanSource) =>
    row.url === source.url ? "https://target.example/brand" : null,
  );
  const sources = vi.fn(async () => rows);
  return {
    addDisabledSources,
    derive,
    sources,
    service: new DerivedBrandSources({
      sources: { sources },
      store: { brandNames: vi.fn(), addDisabledSources },
      channel: "wholefoods",
      derive,
    }),
  };
}

it("derives disabled sources even from disabled input sources and is idempotent", async () => {
  const test = setup();
  expect(await test.service.import({ sourceIds: [id] })).toEqual({ created: 1, skipped: 0 });
  expect(await test.service.import({ sourceIds: [id] })).toEqual({ created: 0, skipped: 1 });
  expect(test.addDisabledSources).toHaveBeenCalledWith([
    { brandId: id, channel: "wholefoods", url: "https://target.example/brand" },
  ]);
});

it("counts duplicate, missing and unconvertible inputs as skipped", async () => {
  const missing = "22222222-2222-4222-8222-222222222222";
  const invalid = "33333333-3333-4333-8333-333333333333";
  const test = setup([
    source,
    { ...source, sourceId: invalid, url: "https://source.example/no-id" },
  ]);
  expect(await test.service.import({ sourceIds: [id, id, missing, invalid] })).toEqual({
    created: 1,
    skipped: 3,
  });
  expect(test.sources).toHaveBeenCalledWith([id, missing, invalid]);
});

it("validates input before reading or writing sources", async () => {
  const test = setup();
  await expect(test.service.import({ sourceIds: [] })).rejects.toThrow();
  expect(test.sources).not.toHaveBeenCalled();
  expect(test.addDisabledSources).not.toHaveBeenCalled();
});

it("writes nothing when no source can be derived", async () => {
  const test = setup([]);
  expect(await test.service.import({ sourceIds: [id] })).toEqual({ created: 0, skipped: 1 });
  expect(test.addDisabledSources).not.toHaveBeenCalled();
});
