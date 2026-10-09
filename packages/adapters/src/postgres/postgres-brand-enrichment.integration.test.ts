import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { expect, it } from "vitest";
import type { Database, Queryable } from "@crawl-automation/platform";
import { PostgresBrandEnrichmentReviews } from "./postgres-brand-enrichment-reviews.js";
import { PostgresBrandEnrichmentRuns } from "./postgres-brand-enrichment-runs.js";

// Run on a Mini or a throwaway cluster. Migration 058 is applied in a private schema and rolled back.
const connectionString = process.env["CRAWL_TEST_DATABASE_URL"];
const migration = new URL("../../../../database/v3/058_brand_enrichment.sql", import.meta.url);

it.skipIf(!connectionString)(
  "keeps one live run per request, caps Apollo at three tries and answers a question once",
  async () => {
    const client = new Client({ connectionString });
    await client.connect();
    const schema = `brand_enrichment_test_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path = ${schema}`);
      const ddl = (await readFile(migration, "utf8"))
        .replace(/^(BEGIN|COMMIT);$/gm, "")
        .replace(/^SET LOCAL search_path = public;$/m, "");
      await client.query(ddl);
      const query: Queryable["query"] = async (sql, values) =>
        (await client.query(sql, values as unknown[])).rows;
      const database = { query, transaction: (work) => work({ query }) } as Database;
      const store = new PostgresBrandEnrichmentRuns(database);
      const reviews = new PostgresBrandEnrichmentReviews(database);

      const requestId = randomUUID();
      const first = await store.create({
        runId: randomUUID(),
        requestId,
        parentRunId: null,
        role: "request",
        brandName: "Kate Farms",
        brandUrl: "https://katefarms.com/",
        workflowId: `brand-enrichment-${requestId}`,
      });
      const again = await store.create({
        runId: randomUUID(),
        requestId,
        parentRunId: null,
        role: "request",
        brandName: "Kate Farms",
        brandUrl: "https://katefarms.com/",
        workflowId: `brand-enrichment-${requestId}-again`,
      });
      expect(first.created).toBe(true);
      expect(again).toEqual({ run: first.run, created: false });

      const runId = first.run.runId;
      expect(
        await store.saveStep({ runId, step: "research", output: { a: 1 }, archiveKeys: [] }),
      ).toEqual({ a: 1 });
      expect(
        await store.saveStep({ runId, step: "research", output: { a: 2 }, archiveKeys: [] }),
      ).toEqual({ a: 1 });

      for (const attempt of [1, 2, 3]) {
        await store.recordApolloTry(runId, {
          attempt,
          query: { by: "name", name: "Kate Farms" },
          organizationIds: [],
        });
      }
      await client.query("SAVEPOINT fourth");
      await expect(
        store.recordApolloTry(runId, {
          attempt: 4,
          query: { by: "name", name: "x" },
          organizationIds: [],
        }),
      ).rejects.toThrow(/brand_enrichment_apollo_try_attempt_check/);
      await client.query("ROLLBACK TO SAVEPOINT fourth");
      expect(await store.apolloTries(runId)).toBe(3);

      await store.addClues(runId, [
        {
          signal: "website_footer",
          ownerName: "Kate Farms Inc.",
          ownerDomain: null,
          ownerCompanyId: null,
          quote: "© 2026 Kate Farms Inc.",
          url: "https://katefarms.com/",
          archiveKey: null,
        },
      ]);
      expect(await store.clues(runId)).toHaveLength(1);

      const question = await reviews.addQuestion(runId, "ownership", { brand: "Kate Farms" });
      await reviews.answerQuestion(question.questionId, "answered", { owner: null });
      await client.query("SAVEPOINT twice");
      await expect(
        reviews.answerQuestion(question.questionId, "dismissed", {}),
      ).rejects.toMatchObject({ code: "STORE.UNEXPECTED_ROW" });
      await client.query("ROLLBACK TO SAVEPOINT twice");

      const done = await store.update(runId, {
        state: "completed",
        summary: { profile: "filled" },
      });
      expect(done).toMatchObject({ state: "completed", summary: { profile: "filled" } });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  },
);
