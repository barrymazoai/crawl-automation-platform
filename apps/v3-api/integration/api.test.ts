import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serve } from "@hono/node-server";
import { createApp } from "../src/http/app.js";
import { PostgresBrands } from "../src/storage/postgres-brands.js";
import { Brand, Source } from "@crawl-automation/v3-contracts";
import { startTestDatabase } from "./postgres.js";

const token = "v3-integration-test-token-not-a-production-secret";
let db: Awaited<ReturnType<typeof startTestDatabase>>;
let app: ReturnType<typeof createApp>;
beforeAll(async () => {
  db = await startTestDatabase();
  app = createApp(new PostgresBrands(db.pool), token);
});
afterAll(async () => {
  if (db) await db.close();
});
const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
function request(
  path: string,
  method = "GET",
  input?: unknown,
  key = randomUUID(),
) {
  return app.request(`/api/v3${path}`, {
    method,
    headers: { ...headers, "Idempotency-Key": key },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function newBrand(name = `Sample ${randomUUID()}`) {
  const response = await request("/brands", "POST", { name });
  expect(response.status).toBe(201);
  return Brand.parse(await response.json());
}
async function newSource(
  brandId: string,
  url = "https://brand.example/products",
) {
  const response = await request(`/brands/${brandId}/sources`, "POST", {
    channel: "dtc",
    url,
  });
  expect(response.status).toBe(201);
  return Source.parse(await response.json());
}

describe("V3 HTTP API with a fresh real PostgreSQL cluster", () => {
  it("requires authentication, JSON, bounded inputs and request IDs", async () => {
    expect((await app.request("/api/v3/brands")).status).toBe(401);
    expect(
      (
        await app.request("/api/v3/brands", {
          method: "POST",
          headers,
          body: '{"name":"A"}',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/v3/brands", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Idempotency-Key": randomUUID(),
          },
          body: '{"name":"A"}',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await app.request("/api/v3/brands", {
          method: "POST",
          headers: { ...headers, "Idempotency-Key": randomUUID() },
          body: "{",
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/brands", "POST", { name: "A", note: "x".repeat(17000) }))
        .status,
    ).toBe(413);
    expect((await request("/brands?limit=1000")).status).toBe(400);
    expect(
      (await request("/brands", "POST", { name: "A", legacyId: "old" })).status,
    ).toBe(400);
  });
  it("persists Brand and multiple sources without any company or legacy records", async () => {
    const brand = await newBrand();
    expect((await request(`/brands/${brand.id}`)).status).toBe(200);
    const source = await newSource(brand.id);
    await newSource(brand.id, "https://brand.example/collections");
    expect(source.enabled).toBe(false);
    const rows = await db.pool.query(
      "SELECT count(*)::int AS count FROM brand_source WHERE brand_id=$1",
      [brand.id],
    );
    expect(rows.rows[0].count).toBe(2);
    const repositoryAfterReconnect = new PostgresBrands(db.pool);
    expect((await repositoryAfterReconnect.get(brand.id)).name).toBe(
      brand.name,
    );
  });
  it("concurrent duplicate POSTs commit one Brand and one identical receipt", async () => {
    const key = randomUUID(),
      name = `Concurrent ${randomUUID()}`;
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request("/brands", "POST", { name }, key),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(201));
    const values = await Promise.all(
      responses.map(async (r) => Brand.parse(await r.json())),
    );
    expect(new Set(values.map((value) => value.id)).size).toBe(1);
    expect(
      responses.filter(
        (r) => r.headers.get("Idempotency-Replayed") === "false",
      ),
    ).toHaveLength(1);
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM api_request_receipt WHERE request_id=$1 AND result IS NOT NULL",
          [key],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("rejects reused request IDs with changed input", async () => {
    const key = randomUUID();
    expect(
      (await request("/brands", "POST", { name: `First ${key}` }, key)).status,
    ).toBe(201);
    const conflict = await request(
      "/brands",
      "POST",
      { name: `Second ${key}` },
      key,
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      error: { code: "REQUEST_ID_CONFLICT" },
    });
  });
  it("competing same-name creates produce one success; failed request receipt rolls back", async () => {
    const name = `Unique ${randomUUID()}`,
      keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all(
      keys.map((key) => request("/brands", "POST", { name }, key)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const failedKey = keys[responses.findIndex((r) => r.status === 409)];
    expect(
      (
        await db.pool.query(
          "SELECT count(*)::int AS n FROM api_request_receipt WHERE request_id=$1",
          [failedKey],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("prevents lost edits with revisions and replays a lost PUT response", async () => {
    const brand = await newBrand(),
      key = randomUUID();
    const input = { name: brand.name, note: "first edit", revision: 1 };
    const first = await request(`/brands/${brand.id}`, "PUT", input, key);
    expect(first.status).toBe(200);
    const saved = Brand.parse(await first.json());
    expect(saved.revision).toBe(2);
    expect(
      await (await request(`/brands/${brand.id}`, "PUT", input, key)).json(),
    ).toEqual(saved);
    const stale = await request(`/brands/${brand.id}`, "PUT", {
      ...input,
      note: "stale",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: "REVISION_CONFLICT" },
    });
    expect(
      Brand.parse(await (await request(`/brands/${brand.id}`)).json()).note,
    ).toBe("first edit");
  });
  it("only one of two parallel version-matched edits wins", async () => {
    const brand = await newBrand();
    const responses = await Promise.all(
      ["a", "b"].map((note) =>
        request(`/brands/${brand.id}`, "PUT", {
          name: brand.name,
          note,
          revision: 1,
        }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      Brand.parse(await (await request(`/brands/${brand.id}`)).json()).revision,
    ).toBe(2);
  });
  it("normalizes source URLs, rejects duplicates and keeps sources associated with their Brand", async () => {
    const brand = await newBrand(),
      source = await newSource(
        brand.id,
        "https://BRAND.example:443/products#label",
      );
    expect(source.url).toBe("https://brand.example/products");
    expect(
      (
        await request(`/brands/${brand.id}/sources`, "POST", {
          channel: "dtc",
          url: source.url,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/brands/${randomUUID()}/sources`, "POST", {
          channel: "dtc",
          url: source.url,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/brands/${randomUUID()}/sources/${source.id}`, "PUT", {
          channel: "dtc",
          url: source.url,
          revision: 1,
        })
      ).status,
    ).toBe(404);
  });
  it("toggles a source with version protection without creating collection work", async () => {
    const brand = await newBrand(),
      source = await newSource(brand.id);
    const url = `/brands/${brand.id}/sources/${source.id}/enabled`;
    const response = await request(url, "PATCH", {
      enabled: true,
      revision: 1,
    });
    expect(response.status).toBe(200);
    expect(Source.parse(await response.json())).toMatchObject({
      enabled: true,
      revision: 2,
    });
    expect(
      (await request(url, "PATCH", { enabled: false, revision: 1 })).status,
    ).toBe(409);
    const tables = (
      await db.pool.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      )
    ).rows.map((row) => row.tablename);
    expect(tables).toEqual([
      "api_request_receipt", "brand", "brand_source", "collected_product",
      "collection_submission", "processing_result", "review_record", "source_submission_guard", "v3_local_migration",
      "workflow_delivery",
    ]);
    const work = (await db.pool.query(
      `SELECT (SELECT count(*)::int FROM collection_submission WHERE source_id=$1) AS submissions,
       (SELECT count(*)::int FROM source_submission_guard WHERE source_id=$1) AS guards`, [source.id],
    )).rows[0];
    expect(work).toEqual({ submissions: 0, guards: 0 });
  });
  it("updates source configuration without implicitly changing enabled state", async () => {
    const brand = await newBrand(),
      source = await newSource(brand.id);
    const response = await request(
      `/brands/${brand.id}/sources/${source.id}`,
      "PUT",
      {
        channel: "amazon",
        region: "ca",
        url: "https://amazon.example/brand",
        revision: 1,
      },
    );
    expect(response.status).toBe(200);
    expect(Source.parse(await response.json())).toMatchObject({
      channel: "amazon",
      region: "CA",
      enabled: false,
      revision: 2,
    });
  });
  it("paginates and treats SQL-like search text as data", async () => {
    const page = await (await request("/brands?limit=1")).json();
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const text = "' OR 1=1 --";
    expect(
      (await (await request(`/brands?q=${encodeURIComponent(text)}`)).json())
        .items,
    ).toEqual([]);
    const brand = await newBrand(text);
    expect(
      Brand.parse(await (await request(`/brands/${brand.id}`)).json()).name,
    ).toBe(text);
    expect((await request(`/brands/${randomUUID()}`)).status).toBe(404);
    expect((await request("/brands/not-a-uuid")).status).toBe(400);
    expect((await request(`/brands/${brand.id}`, "DELETE")).status).toBe(404);
  });
  it("serves real HTTP over loopback with exact database summary counts", async () => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing HTTP port");
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/v3/summary`,
        { headers },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const expected = (
        await db.pool.query(
          'SELECT (SELECT count(*)::int FROM brand) brands,(SELECT count(*)::int FROM brand_source) sources,(SELECT count(*)::int FROM brand_source WHERE enabled) "enabledSources"',
        )
      ).rows[0];
      expect(await response.json()).toEqual(expected);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
