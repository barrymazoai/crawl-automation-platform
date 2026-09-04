import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NoCompanyStore, type NoCompanyProductEntry } from "./no-company-store.js";

function entry(overrides: Partial<NoCompanyProductEntry> = {}): NoCompanyProductEntry {
  return {
    channel: "swanson", externalId: "SW123", brand: "NOW Foods", runId: "run-1",
    sourceUrl: "https://www.swansonvitamins.com/collections/all?facet.brand=NOW%20Foods",
    title: "NOW Foods Vitamin C 1000", productUrl: "https://www.swansonvitamins.com/p/x",
    capturedAt: "2026-09-04T00:00:00.000Z", sku: "SW123", price: "12.99",
    ingredients: ["Vitamin C"], factsRows: 3,
    raw: { id: "SW123" }, semantic: { ingredients: ["Vitamin C"] },
    unified: { clientRef: "SW123", productName: "NOW Foods Vitamin C 1000", baseName: null, variant: {}, variantConfidence: 90, variantSource: "channel_attrs", attrsRaw: {} },
    facts: { facts: { rows: [{ name: "Vitamin C" }, { name: "Zinc" }, { name: "Calcium" }] } as any },
    ...overrides,
  };
}

describe("无公司产品旁库", () => {
  let dir: string;
  let store: NoCompanyStore;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), "no-company-")); store = new NoCompanyStore(path.join(dir, "x.sqlite")); });
  afterEach(() => { store.close(); });

  it("写入后能按渠道/品牌汇总，成分表行数也保留", () => {
    store.upsertMany([entry(), entry({ externalId: "SW124", factsRows: 0, facts: null }), entry({ externalId: "G1", channel: "gnc", brand: "Ghost" })]);
    expect(store.count()).toBe(3);
    const rows = store.summary();
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: "swanson", brand: "NOW Foods", n: 2, with_facts: 1 }),
      expect.objectContaining({ channel: "gnc", brand: "Ghost", n: 1, with_facts: 1 }),
    ]));
  });

  it("同一 (channel, externalId) 再次写入以最新为准，不重复", () => {
    store.upsert(entry({ title: "old" }));
    store.upsert(entry({ title: "new", runId: "run-2" }));
    expect(store.count()).toBe(1);
    const only = store.summary()[0]!;
    expect(only.n).toBe(1);
  });

  it("批量写入中途失败会整体回滚", () => {
    expect(() => store.upsertMany([entry(), { ...entry({ externalId: "bad" }), raw: undefined as unknown as object, ingredients: undefined as unknown as string[] }]))
      .toThrow();
    expect(store.count()).toBe(0);
  });

  it("重新打开同一文件数据还在", () => {
    store.upsert(entry());
    store.close();
    const reopened = new NoCompanyStore(path.join(dir, "x.sqlite"));
    expect(reopened.count()).toBe(1);
    reopened.close();
    store = new NoCompanyStore(path.join(dir, "y.sqlite"));
  });
});
