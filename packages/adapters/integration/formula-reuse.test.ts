import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { FormulaLookup, SiblingFormulaReuse, type FormulaLink } from "@crawl-automation/app";
import { hashString } from "@crawl-automation/processing";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresFormulaIndex } from "../src/postgres/postgres-formula-index.js";
import { PostgresFormulaLinks } from "../src/postgres/postgres-formula-links.js";
import { startTemporaryPostgres, type TemporaryPostgres } from "./temporary-postgres.js";

/** Amazon and Whole Foods share ASIN formulas; every other channel only its own (as the adapters declare). */
const families = {
  channels: (channel: string) =>
    ["amazon", "wholefoods"].includes(channel) ? ["amazon", "wholefoods"] : [channel],
};

const hasPostgres = (() => {
  try {
    execFileSync("initdb", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();

const fixture = JSON.parse(
  readFileSync(new URL("../src/postgres/fixtures/collected-product.json", import.meta.url), "utf8"),
) as Record<string, unknown> & { observation: Record<string, unknown> };
const runId = "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11";

/** A real collected record, owned by the given source and listing. */
async function collect(
  database: Database,
  owner: { operationId: string; sourceId: string; listingId: string },
) {
  const record = {
    ...fixture,
    operationId: owner.operationId,
    observation: { ...fixture.observation, observationId: `obs-${owner.operationId}`, ...owner },
  };
  delete (record.observation as Record<string, unknown>)["operationId"];
  await database.query(
    `INSERT INTO collected_product (operation_id, observation_id, record_hash, record)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [
      owner.operationId,
      `obs-${owner.operationId}`,
      hashString(JSON.stringify(record)),
      JSON.stringify(record),
    ],
  );
}

describe.skipIf(!hasPostgres)("formula reuse against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;
  let database: Database;
  let index: PostgresFormulaIndex;
  const sources: Record<string, string> = {};

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    database = postgres.database;
    index = new PostgresFormulaIndex(database);
    const brands = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Nordic Naturals') RETURNING id",
    );
    const brandId = brands[0]?.id ?? "";
    for (const [channel, url] of [
      ["amazon", "https://www.amazon.com/"],
      ["wholefoods", "https://www.wholefoodsmarket.com/"],
      ["swanson", "https://www.swansonvitamins.com/collections/brand-nordic-naturals"],
    ]) {
      const rows = await database.query<{ id: string }>(
        "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, $2, $3) RETURNING id",
        [brandId, channel, url],
      );
      sources[channel ?? ""] = rows[0]?.id ?? "";
    }
    await collect(database, {
      operationId: "amazon-formula",
      sourceId: sources["amazon"] ?? "",
      listingId: "B002CQU54Q",
    });
    await collect(database, {
      operationId: "swanson-60",
      sourceId: sources["swanson"] ?? "",
      listingId: "omega-60",
    });
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("a Whole Foods listing finds the Amazon formula of the same ASIN; other channels do not", async () => {
    const lookup = new FormulaLookup(index, families);
    const asin = { listingId: "B002CQU54Q", variantId: null };
    expect(await lookup.findKnown({ channel: "wholefoods", ...asin })).toEqual({
      operationId: "amazon-formula",
    });
    expect(await lookup.findKnown({ channel: "swanson", ...asin })).toBeNull();
  });

  it("both a family member and a product's own formula require the exact variant", async () => {
    const channels = ["swanson"];
    expect(
      await index.findForMember({ channels, listingId: "omega-60", variantId: "4412" }),
    ).toBeNull();
    expect(await index.findForMember({ channels, listingId: "omega-60", variantId: null })).toEqual(
      { operationId: "swanson-60", listingId: "omega-60", variantId: null },
    );
    expect(
      await index.findKnown({ channels, listingId: "omega-60", variantId: "4412" }),
    ).toBeNull();
    expect((await index.readSaved("swanson-60"))?.formula.columns.length).toBeGreaterThan(0);
    expect(await index.readSaved("missing")).toBeNull();
  });

  it("a link is written once, then is the product's known formula; a different link is a conflict", async () => {
    const links = new PostgresFormulaLinks(database);
    const link: FormulaLink = {
      linkId: hashString(JSON.stringify(["formula-link/1", "swanson", "omega-120", null])),
      channel: "swanson",
      listingId: "omega-120",
      variantId: null,
      formulaOperationId: "swanson-60",
      sibling: { listingId: "omega-60", variantId: null },
      evidence: { check: "label-text-match/1" },
      runId,
    };
    expect(await links.record(link)).toEqual(link);
    expect(await links.record({ ...link, runId: "0b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11" })).toEqual(
      link,
    );
    await expect(
      links.record({ ...link, sibling: { listingId: "omega-30", variantId: null } }),
    ).rejects.toMatchObject({
      code: "FORMULA.LINK_CONFLICT",
    });
    const known = await index.findKnown({
      channels: ["swanson"],
      listingId: "omega-120",
      variantId: null,
    });
    expect(known).toEqual({ operationId: "swanson-60" });
  });

  it("the reuse service reads the saved sibling formula from the database", async () => {
    const reuse = new SiblingFormulaReuse({
      index,
      families,
      links: new PostgresFormulaLinks(database),
    });
    const result = await reuse.reuse({
      runId,
      channel: "swanson",
      listingId: "omega-240",
      variantId: null,
      labelText: "Supplement Facts",
      family: {
        differsBy: "size",
        group: "Size",
        selectedLabel: "240 Softgels",
        members: [
          {
            listingId: "omega-60",
            variantId: null,
            url: "https://www.swansonvitamins.com/p/omega-60",
            label: "60 Softgels",
          },
        ],
      },
    });
    // The label text lacks the saved formula's rows, so the product is extracted in full: nothing linked.
    expect(result).toEqual({
      status: "extract",
      reason: "FORMULA.LABEL_MISMATCH",
      coverage: {
        scope: "enumerated-family",
        members: [
          {
            listingId: "omega-60",
            variantId: null,
            url: "https://www.swansonvitamins.com/p/omega-60",
            seen: false,
            queued: false,
          },
        ],
      },
    });
  });
});

type Field = { text: string } | null;
type Saved = {
  formula: { servingSize: Field; columns: { rows: { name: Field; amount: Field }[] }[] };
  otherIngredients: { items: { text: string }[] } | null;
};

/** A label that prints exactly the saved formula, as the new size's page would. */
function labelOf(saved: Saved): string {
  const rows = saved.formula.columns.flatMap((column) =>
    column.rows.map((row) => `${row.name?.text ?? ""} ${row.amount?.text ?? ""}`),
  );
  const others = saved.otherIngredients?.items.map((item) => item.text).join(", ") ?? "None";
  return [
    `Serving Size ${saved.formula.servingSize?.text ?? ""}`,
    ...rows,
    `Other Ingredients: ${others}`,
  ].join("\n");
}

describe.skipIf(!hasPostgres)("sibling reuse end to end against a real PostgreSQL", () => {
  let postgres: TemporaryPostgres;

  beforeAll(async () => {
    postgres = await startTemporaryPostgres();
    const database = postgres.database;
    const brands = await database.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ('Healthy Origins') RETURNING id",
    );
    const rows = await database.query<{ id: string }>(
      "INSERT INTO brand_source (brand_id, channel, url) VALUES ($1, 'swanson', $2) RETURNING id",
      [brands[0]?.id, "https://www.swansonvitamins.com/collections/brand-healthy-origins"],
    );
    await collect(database, {
      operationId: "sibling-60",
      sourceId: rows[0]?.id ?? "",
      listingId: "ho-60",
    });
  }, 120_000);

  afterAll(async () => {
    await postgres?.stop();
  });

  it("links the sibling's formula when the label matches, and the product then knows its formula", async () => {
    const index = new PostgresFormulaIndex(postgres.database);
    const saved = (await index.readSaved("sibling-60")) as unknown as Saved;
    const reuse = new SiblingFormulaReuse({
      index,
      families,
      links: new PostgresFormulaLinks(postgres.database),
    });
    const request = {
      runId,
      channel: "swanson",
      listingId: "ho-120",
      variantId: null,
      labelText: labelOf(saved),
      family: {
        differsBy: "size",
        group: "Size",
        selectedLabel: "120 Gummies",
        members: [
          {
            listingId: "ho-60",
            variantId: null,
            url: "https://www.swansonvitamins.com/p/ho-60",
            label: "60 Gummies",
          },
        ],
      },
    };
    expect(await reuse.reuse(request)).toMatchObject({
      status: "reused",
      formulaOperationId: "sibling-60",
      siblingListingId: "ho-60",
    });
    const known = await index.findKnown({
      channels: ["swanson"],
      listingId: "ho-120",
      variantId: null,
    });
    expect(known).toEqual({ operationId: "sibling-60" });
  });
});
