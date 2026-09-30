import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { HtmlCaptureRequest, SavedHtmlOriginal } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresHtmlCaptureRecords } from "./html-capture-records.js";

interface TemporaryPostgres {
  database: Database;
  stop(): Promise<void>;
}

const hasPostgres = (() => {
  try {
    for (const executable of ["initdb", "pg_ctl"]) {
      execFileSync(executable, ["--version"], { stdio: "ignore" });
    }
    return true;
  } catch {
    return false;
  }
})();
const hour = 60 * 60 * 1000;

function request(overrides: Partial<HtmlCaptureRequest["capture"]> = {}): HtmlCaptureRequest {
  return {
    channel: "gnc",
    capture: {
      operationId: randomUUID(),
      sessionId: "session",
      sourceId: "source",
      listingId: randomUUID(),
      variantId: null,
      url: "https://example.com/product",
      ...overrides,
    },
  };
}

function next(producer: HtmlCaptureRequest): HtmlCaptureRequest {
  return { ...producer, capture: { ...producer.capture, operationId: randomUUID() } };
}

function original(
  request: HtmlCaptureRequest,
  capturedAt = new Date().toISOString(),
): SavedHtmlOriginal {
  const { channel, capture } = request;
  const { operationId, sourceId, listingId, variantId } = capture;
  return {
    ...request,
    capturedAt,
    finalUrl: null,
    source: {
      schemaVersion: 1,
      artifactId: `html-${operationId}`,
      observationId: `html-${operationId}`,
      sourceId,
      listingId,
      variantId,
      kind: "source-html",
      mediaType: "text/html",
      objectKey: `v3/${channel}-html/${operationId}/original.html`,
      byteSize: 10,
      sha256: "a".repeat(64),
      producer: {
        operationId,
        module: `${channel}.http-original`,
        implementationVersion: "html/1",
      },
    },
  };
}

describe.skipIf(!hasPostgres || process.env.V3_TEST_SKIP_POSTGRES === "1")(
  "HTML capture admission on isolated Unix-socket PostgreSQL",
  () => {
    let postgres: TemporaryPostgres;
    let records: PostgresHtmlCaptureRecords;
    beforeAll(async () => {
      const { startTemporaryPostgres } = await vi.importActual<{
        startTemporaryPostgres(): Promise<TemporaryPostgres>;
      }>("../../integration/temporary-postgres.js");
      postgres = await startTemporaryPostgres();
      records = new PostgresHtmlCaptureRecords(postgres.database);
    }, 120_000);
    afterAll(async () => {
      await postgres?.stop();
    }, 60_000);

    async function seedOriginal(producer: HtmlCaptureRequest, age: number) {
      const saved = original(producer, new Date(Date.now() - age).toISOString());
      // This also covers importing a verified archive produced before this table existed.
      await records.complete(producer, saved);
      return saved;
    }

    async function seedInFlight(producer: HtmlCaptureRequest, age: number) {
      await postgres.database.query(
        `INSERT INTO html_capture (operation_id,channel,listing_id,variant_id,request,requested_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          producer.capture.operationId,
          producer.channel,
          producer.capture.listingId,
          producer.capture.variantId,
          producer,
          new Date(Date.now() - age),
        ],
      );
    }

    it("reuses a verified original within 24 hours across source IDs and operations", async () => {
      const producer = request();
      const saved = await seedOriginal(producer, 23 * hour);
      const consumer = next(producer);
      consumer.capture.sourceId = "another-source";
      expect(await records.admit(consumer)).toEqual({ status: "reuse", original: saved });
      const rows = await postgres.database.query<{ original: unknown; captured_at: Date }>(
        "SELECT original,captured_at FROM html_capture WHERE operation_id=$1",
        [consumer.capture.operationId],
      );
      expect(rows[0]?.original).toEqual(saved);
      expect(rows[0]?.captured_at.toISOString()).toBe(saved.capturedAt);
    });

    it("downloads when the original is at least 24 hours old", async () => {
      const producer = request();
      await seedOriginal(producer, 24 * hour);
      expect(await records.admit(next(producer))).toEqual({ status: "download" });
    });

    it("ignores request age for a recent original captured after a long request", async () => {
      const producer = request();
      await seedInFlight(producer, 25 * hour);
      const saved = original(producer);
      await records.complete(producer, saved);
      expect(await records.admit(next(producer))).toEqual({ status: "reuse", original: saved });
    });

    it("downloads immediately after a failed attempt, but never retries that operation", async () => {
      const producer = request();
      expect(await records.admit(producer)).toEqual({ status: "download" });
      await records.fail(producer, "SCRAPERAPI.PROVIDER_FAILURE");
      await records.fail(producer, "SCRAPERAPI.PROVIDER_FAILURE");
      expect(await records.admit(producer)).toEqual({ status: "unresolved" });
      expect(await records.admit(next(producer))).toEqual({ status: "download" });
    });

    it("blocks a potentially running request for ten minutes", async () => {
      const producer = request();
      await seedInFlight(producer, 9 * 60 * 1000);
      expect(await records.admit(next(producer))).toEqual({
        status: "in_flight",
        operationId: producer.capture.operationId,
      });
    });

    it("admits a new operation at ten minutes while permanently refusing the old one", async () => {
      const producer = request();
      await seedInFlight(producer, 10 * 60 * 1000);
      expect(await records.admit(producer)).toEqual({ status: "unresolved" });
      expect(await records.admit(next(producer))).toEqual({
        status: "download",
        previous: [producer],
      });
    });

    it("binds a new reservation to an original recovered from an expired unfinished operation", async () => {
      const producer = request();
      await seedInFlight(producer, 11 * 60 * 1000);
      const consumer = next(producer);
      expect(await records.admit(consumer)).toEqual({ status: "download", previous: [producer] });
      const saved = original(producer);
      await records.complete(producer, saved);
      await records.complete(consumer, saved);
      expect(await records.admit(consumer)).toEqual({ status: "reuse", original: saved });
      expect(await records.admit(next(producer))).toEqual({ status: "reuse", original: saved });
    });

    it("uses a recent original even while another operation is in flight", async () => {
      const producer = request();
      const saved = await seedOriginal(producer, hour);
      await seedInFlight(next(producer), 0);
      expect(await records.admit(next(producer))).toEqual({ status: "reuse", original: saved });
    });

    it("does not renew the window when an operation recently reused older HTML", async () => {
      const producer = request();
      const saved = await seedOriginal(producer, 25 * hour);
      const consumer = next(producer);
      // Model a reuse admitted yesterday; its recorded original has now expired.
      await postgres.database.query(
        `INSERT INTO html_capture
         (operation_id,channel,listing_id,variant_id,request,state,original,captured_at)
         VALUES ($1,$2,$3,$4,$5,'done',$6,$7)`,
        [
          consumer.capture.operationId,
          consumer.channel,
          consumer.capture.listingId,
          consumer.capture.variantId,
          consumer,
          saved,
          saved.capturedAt,
        ],
      );
      expect(await records.admit(next(producer))).toEqual({ status: "download" });
      // Replaying a successful operation keeps its own result even after the shared window ends.
      expect(await records.admit(consumer)).toEqual({ status: "reuse", original: saved });
    });

    it.each([null, "small"])(
      "separates variants from %s for both originals and in-flight markers",
      async (variantId) => {
        const producer = request({ variantId });
        const otherVariant = next(producer);
        otherVariant.capture.variantId = "large";
        await records.admit(producer);
        expect(await records.admit(otherVariant)).toEqual({ status: "download" });
        await records.complete(producer, original(producer));
        expect(await records.admit(next(otherVariant))).toMatchObject({ status: "in_flight" });
        await records.fail(otherVariant, "CAPTURE.NOT_FOUND");
        expect(await records.admit(next(otherVariant))).toEqual({ status: "download" });
      },
    );

    it("separates channels and listing IDs", async () => {
      const producer = request();
      await seedOriginal(producer, hour);
      expect(await records.admit({ ...next(producer), channel: "amazon" })).toEqual({
        status: "download",
      });
      expect(await records.admit(request())).toEqual({ status: "download" });
    });

    it("serializes concurrent workers so only one can pay for the same identity", async () => {
      const producer = request();
      const decisions = await Promise.all(
        Array.from({ length: 8 }, () => records.admit(next(producer))),
      );
      expect(decisions.filter((decision) => decision.status === "download")).toHaveLength(1);
      expect(decisions.filter((decision) => decision.status === "in_flight")).toHaveLength(7);
    });

    it("serializes the same operation and rejects a conflicting identity", async () => {
      const producer = request();
      const decisions = await Promise.all([records.admit(producer), records.admit(producer)]);
      expect(decisions.map((decision) => decision.status).sort()).toEqual([
        "download",
        "unresolved",
      ]);
      await expect(
        records.admit(request({ operationId: producer.capture.operationId })),
      ).rejects.toMatchObject({ code: "CAPTURE.RECORD_CONFLICT" });
    });

    it("makes completion idempotent and rejects rewriting saved provenance or outcomes", async () => {
      const producer = request();
      await records.admit(producer);
      const saved = original(producer);
      await records.complete(producer, saved);
      await records.complete(producer, saved);
      await expect(
        records.complete(producer, { ...saved, finalUrl: "https://example.com/elsewhere" }),
      ).rejects.toMatchObject({ code: "CAPTURE.RECORD_CONFLICT" });
      await expect(records.fail(producer, "CAPTURE.NOT_FOUND")).rejects.toMatchObject({
        code: "CAPTURE.RECORD_CONFLICT",
      });
    });

    it.each([
      "DELETE FROM html_capture WHERE operation_id=$1",
      "UPDATE html_capture SET captured_at=clock_timestamp() WHERE operation_id=$1",
      "UPDATE html_capture SET original='{}'::jsonb WHERE operation_id=$1",
      "UPDATE html_capture SET requested_at=clock_timestamp() WHERE operation_id=$1",
    ])("the trigger refuses terminal record mutation: %s", async (sql) => {
      const producer = request();
      await seedOriginal(producer, hour);
      await expect(
        postgres.database.query(sql, [producer.capture.operationId]),
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("the trigger preserves in-flight identity and failed outcomes", async () => {
      const producer = request();
      await records.admit(producer);
      await expect(
        postgres.database.query(
          "UPDATE html_capture SET listing_id='changed' WHERE operation_id=$1",
          [producer.capture.operationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await records.fail(producer, "CAPTURE.NOT_FOUND");
      await expect(
        postgres.database.query(
          "UPDATE html_capture SET state='in_flight',cause_code=NULL WHERE operation_id=$1",
          [producer.capture.operationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(records.complete(producer, original(producer))).rejects.toMatchObject({
        code: "CAPTURE.RECORD_CONFLICT",
      });
    });
  },
);
