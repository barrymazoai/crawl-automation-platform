import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@crawl-automation/platform";
import { claimBrandScans } from "./brand-scan-claim.js";

// Runs against CRAWL_TEST_DATABASE_URL with every migration applied; each test rolls back.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
let client: Client;
let tx: Queryable;
let brands = 0;

const STORE = "https://www.amazon.com/stores/page/7B3902F7-D6C8-4226-97B1-BEB72807BEB3";
const SEARCH = "https://www.amazon.com/s?k=Natrol&i=hpc&rh=p_123%3A123";
const COSTCO =
  "https://www.costco.com/vitamins-herbals-dietary-supplements.html?refinement=brands%3DNatrol";

async function queue(channel: string, url: string, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const address = `${url}${url.includes("?") ? "&" : "?"}n=${index}`;
    const [brand] = await tx.query<{ id: string }>(
      "INSERT INTO brand (name) VALUES ($1) RETURNING id::text",
      [`Claim Brand ${(brands += 1)}`],
    );
    const [source] = await tx.query<{ id: string }>(
      "INSERT INTO brand_source (brand_id, channel, url, enabled) VALUES ($1, $2, $3, true) RETURNING id::text",
      [brand?.id, channel, address],
    );
    const [scan] = await tx.query<{ scanId: string }>(
      `INSERT INTO brand_scan (request_id, source_id, channel, url, requested_at)
       VALUES (gen_random_uuid(), $1, $2, $3, clock_timestamp() + $4 * interval '1 millisecond')
       RETURNING scan_id::text AS "scanId"`,
      [source?.id, channel, address, index],
    );
    ids.push(scan?.scanId ?? "");
  }
  return ids;
}

async function running() {
  return tx.query<{ channel: string; store: boolean; count: number }>(
    `SELECT channel, url LIKE 'https://www.amazon.com/stores/%' AS store, count(*)::int AS count
     FROM brand_scan WHERE state='running' GROUP BY 1, 2 ORDER BY 1, 2`,
  );
}

describe.skipIf(!connectionString)("brand scan claim", () => {
  beforeEach(async () => {
    client = new Client({ connectionString });
    await client.connect();
    await client.query("BEGIN");
    tx = { query: async (sql, values) => (await client.query(sql, [...(values ?? [])])).rows };
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    await client.end();
  });

  it("claims Amazon Store pages one at a time and leaves the shared slots to search pages", async () => {
    // KAN-243 round 2026-11-13: 501 Store scans waiting for Server 一's one Ego space must not hold every slot.
    const stores = await queue("amazon", STORE, 5);
    await queue("amazon", SEARCH, 5);
    await queue("costco", COSTCO, 3);

    const first = await claimBrandScans(tx, { limit: 4, staleMs: 1_800_000 });

    expect(first).toHaveLength(6);
    expect(await running()).toEqual([
      { channel: "amazon", store: false, count: 4 },
      { channel: "amazon", store: true, count: 1 },
      { channel: "costco", store: false, count: 1 },
    ]);
    expect(first.map(({ scanId }) => scanId)).toContain(stores[0]);

    const second = await claimBrandScans(tx, {
      limit: 4,
      staleMs: 1_800_000,
      active: first.map(({ scanId }) => scanId),
    });

    // The remaining search page is taken; the next Store page and Costco scan wait for their running one.
    expect(second).toHaveLength(1);
    expect(await running()).toEqual([
      { channel: "amazon", store: false, count: 5 },
      { channel: "amazon", store: true, count: 1 },
      { channel: "costco", store: false, count: 1 },
    ]);
  });

  it("starts the next Store page once the running one has finished", async () => {
    const stores = await queue("amazon", STORE, 2);
    await claimBrandScans(tx, { limit: 4, staleMs: 1_800_000 });
    await tx.query(
      `UPDATE brand_scan SET state='complete', finished_at=clock_timestamp(), result='{}'::jsonb
       WHERE scan_id=$1`,
      [stores[0]],
    );

    const next = await claimBrandScans(tx, { limit: 4, staleMs: 1_800_000, active: [] });

    expect(next.map(({ scanId }) => scanId)).toEqual([stores[1]]);
  });
});
