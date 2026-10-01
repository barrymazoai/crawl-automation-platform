import { isDeepStrictEqual } from "node:util";
import {
  HTML_REUSE_WINDOW_MS,
  HtmlCaptureRequestSchema,
  SavedHtmlOriginalSchema,
  htmlCaptureErrors,
  type HtmlCaptureRecords,
  type HtmlCaptureAdmission,
  type HtmlCaptureRequest,
  type SavedHtmlOriginal,
} from "@crawl-automation/app";
import type { Database, Queryable } from "@crawl-automation/platform";
import {
  inFlight,
  insertCapture,
  readCapture,
  recentOriginal,
  unfinishedCaptures,
} from "./html-capture-queries.js";

const conflict = () => htmlCaptureErrors.create("CAPTURE.RECORD_CONFLICT");

/** Atomic cross-worker admission; every terminal record and original reference stays immutable. */
export class PostgresHtmlCaptureRecords implements HtmlCaptureRecords {
  constructor(
    private readonly database: Database,
    readonly reuseWindowMs: number = HTML_REUSE_WINDOW_MS,
  ) {}

  async admit(raw: HtmlCaptureRequest): Promise<HtmlCaptureAdmission> {
    const request = HtmlCaptureRequestSchema.parse(raw);
    return this.locked(request, async (transaction) => {
      const prior = await readCapture(transaction, request.capture.operationId);
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request)) {
          throw conflict();
        }
        return prior.state === "done"
          ? { status: "reuse", original: SavedHtmlOriginalSchema.parse(prior.original) }
          : { status: "unresolved" };
      }
      const original = await recentOriginal(transaction, request, this.reuseWindowMs);
      if (original) {
        await insertCapture(transaction, request, original);
        return { status: "reuse", original };
      }
      const owner = await inFlight(transaction, request);
      if (owner) {
        return { status: "in_flight", operationId: owner };
      }
      const previous = await unfinishedCaptures(transaction, request);
      await insertCapture(transaction, request, null);
      return previous.length ? { status: "download", previous } : { status: "download" };
    });
  }

  async complete(raw: HtmlCaptureRequest, saved: SavedHtmlOriginal): Promise<void> {
    const request = HtmlCaptureRequestSchema.parse(raw);
    const original = SavedHtmlOriginalSchema.parse(saved);
    // May also bind a reserved operation to an original recovered from an unfinished archive.
    if (
      original.channel !== request.channel ||
      original.capture.listingId !== request.capture.listingId ||
      original.capture.variantId !== request.capture.variantId
    ) {
      throw conflict();
    }
    await this.locked(request, async (transaction) => {
      const prior = await readCapture(transaction, request.capture.operationId);
      if (!prior) {
        // Allows a verified pre-migration archive to enter the shared index without fetching.
        await insertCapture(transaction, request, original);
        return;
      }
      if (!isDeepStrictEqual(prior.request, request) || prior.state === "failed") {
        throw conflict();
      }
      if (prior.state === "done") {
        if (!isDeepStrictEqual(prior.original, original)) {
          throw conflict();
        }
        return;
      }
      await transaction.query(
        "UPDATE html_capture SET state='done',original=$2,captured_at=$3 WHERE operation_id=$1",
        [request.capture.operationId, original, original.capturedAt],
      );
    });
  }

  async fail(raw: HtmlCaptureRequest, causeCode: string | null): Promise<void> {
    const request = HtmlCaptureRequestSchema.parse(raw);
    await this.locked(request, async (transaction) => {
      const prior = await readCapture(transaction, request.capture.operationId);
      if (!prior || !isDeepStrictEqual(prior.request, request)) {
        throw conflict();
      }
      // A lost completion acknowledgement must not replace a verified original with failure.
      if (prior.state === "done") {
        return;
      }
      if (prior.state === "failed") {
        if (prior.cause_code !== causeCode) {
          throw conflict();
        }
        return;
      }
      await transaction.query(
        "UPDATE html_capture SET state='failed',cause_code=$2 WHERE operation_id=$1",
        [request.capture.operationId, causeCode],
      );
    });
  }

  private locked<Result>(
    request: HtmlCaptureRequest,
    work: (transaction: Queryable) => Promise<Result>,
  ): Promise<Result> {
    return this.database.transaction(async (transaction) => {
      await transaction.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
      // Lock operation first, then listing: conflicting operation IDs cannot cross identities.
      const keys = [
        ["html-capture-operation", request.capture.operationId],
        [
          "html-capture-listing",
          request.channel,
          request.capture.listingId,
          request.capture.variantId,
        ],
      ];
      for (const key of keys) {
        await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify(key),
        ]);
      }
      return work(transaction);
    });
  }
}
