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
import {
  isChallengeRedirect,
  landingPageListing,
  type Database,
  type Queryable,
} from "@crawl-automation/platform";
import { captureCreditCost, captureWasCalled, measureCaptureReuse } from "./html-capture-cost.js";
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
    const admission = await this.locked<HtmlCaptureAdmission>(request, async (transaction) => {
      const prior = await readCapture(transaction, request.capture.operationId);
      if (prior) {
        if (!isDeepStrictEqual(prior.request, request)) {
          throw conflict();
        }
        if (prior.state !== "done") {
          return { status: "unresolved" };
        }
        const saved = SavedHtmlOriginalSchema.parse(prior.original);
        return { status: "reuse", original: saved };
      }
      const original = await recentOriginal(transaction, request, this.reuseWindowMs);
      if (original && !landedOffProduct(original)) {
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
    if (admission.status === "reuse") {
      await measureCaptureReuse(request, admission.original);
    }
    return admission;
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
        `UPDATE html_capture SET state='done',original=$2,captured_at=$3,credit_cost=$4,reused=$5
         WHERE operation_id=$1`,
        [
          request.capture.operationId,
          original,
          original.capturedAt,
          captureCreditCost(request, original),
          original.capture.operationId !== request.capture.operationId,
        ],
      );
    });
    await this.measureCompletedReuse(request, original);
  }

  private async measureCompletedReuse(request: HtmlCaptureRequest, original: SavedHtmlOriginal) {
    if (!captureWasCalled()) {
      await measureCaptureReuse(request, original);
    }
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
        "UPDATE html_capture SET state='failed',cause_code=$2,credit_cost=$3 WHERE operation_id=$1",
        [request.capture.operationId, causeCode, captureCreditCost(request, null)],
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

/**
 * A page that landed on the site's human verification (owner 2026-10-24: Amazon's /checkpoint/ interstitial was
 * archived as `done` before) or on a landing page instead of the product page (owner 2026-10-26: Amazon `/clp/`)
 * is not a verified original, so it is never reused; a new capture downloads. Any `/clp/` page is refused, whatever
 * ASIN it shows: it is never a product page to reuse, even when it was a valid `redirected_away` sighting.
 */
function landedOffProduct(original: SavedHtmlOriginal): boolean {
  if (original.finalUrl === null) {
    return false;
  }
  const target = new URL(original.capture.url);
  return (
    isChallengeRedirect(original.finalUrl, target) ||
    landingPageListing(original.finalUrl, target) !== null
  );
}
