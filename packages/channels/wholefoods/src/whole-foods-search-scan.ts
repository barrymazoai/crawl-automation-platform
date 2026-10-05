import type { ListingScanContext, ListingScanOutcome } from "@crawl-automation/channels-core";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import type { WholeFoodsHttpScanSettings } from "./whole-foods-http-settings.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { WholeFoodsSearchObservations } from "./whole-foods-search-observations.js";
import { readWholeFoodsSearch, type WholeFoodsSearchRead } from "./whole-foods-search-read.js";
import { wholeFoodsSearchComplete, wholeFoodsSearchTotal } from "./whole-foods-search-page.js";

/** Two independent observations; failures retain products and their real error codes. */
export async function scanWholeFoodsSearch(
  context: ListingScanContext,
  settings: WholeFoodsHttpScanSettings,
): Promise<ListingScanOutcome> {
  const observations = new WholeFoodsSearchObservations(context, settings);
  const read = (name: string) =>
    readWholeFoodsSearch(
      observations,
      {
        sourceUrl: context.sourceUrl,
        read: name,
        maxPages: settings.maxPages,
      },
      context.signal,
    );
  const first = await read("read-1");
  if (first.pages.length === 0 && observations.cooldownRequested) {
    return canaryOutcome({ context, settings, observations }, first);
  }
  const reads = [first];
  if (!first.summary.code) {
    await context.pause(settings.readPauseMs);
    reads.push(await read("read-2"));
  }
  return outcome({ settings, observations }, reads);
}

function outcome(
  run: { settings: WholeFoodsHttpScanSettings; observations: WholeFoodsSearchObservations },
  reads: WholeFoodsSearchRead[],
): ListingScanOutcome {
  const pages = reads.flatMap((read) => read.pages);
  const readsFinished = reads.length === 2 && reads.every((read) => read.summary.code === null);
  const agreement = readsFinished && catalogueAgreement(reads);
  const stable = agreement && new Set(reads.map((read) => read.summary.products)).size === 1;
  // The search API restates a different total on each call (owner 2026-10-05): two reads that are each
  // complete against their own total prove the brand list; their union is kept and catalogueStable records drift.
  const complete =
    readsFinished &&
    (wholeFoodsSearchComplete(pages) || reads.every((read) => read.summary.succeeded));
  const code = reads.find((read) => read.summary.code)?.summary.code ?? null;
  return {
    pages,
    credits: run.observations.credits,
    complete,
    statedTotal: wholeFoodsSearchTotal(pages) ?? largestReadTotal(reads),
    ...(pages.some((page) => page.cards > 0) ? { soldHere: true } : {}),
    cooldownRequested: run.observations.cooldownRequested,
    code: scanCode(code, complete),
    metrics: {
      storeId: run.settings.store.storeId,
      readsFinished,
      catalogueAgreement: agreement,
      catalogueStable: stable,
      attempts: run.observations.attempts,
      reads: reads.map((read) => read.summary),
      unionSize: new Set(pages.flatMap((page) => page.products.map((item) => item.listingId))).size,
    },
  };
}

function largestReadTotal(reads: WholeFoodsSearchRead[]): number | null {
  const totals = reads.flatMap((read) => read.summary.availableCounts);
  return totals.length ? Math.max(...totals) : null;
}

/** Agreement is diagnostic only: completeness is proved by the deduplicated union and API total. */
function catalogueAgreement(reads: WholeFoodsSearchRead[]): boolean {
  const sets = reads.map((read) => new Set(read.pages.flatMap((page) => page.cardIds ?? [])));
  const first = sets[0];
  const second = sets[1];
  return (
    !!first &&
    !!second &&
    ([...first].every((asin) => second.has(asin)) || [...second].every((asin) => first.has(asin)))
  );
}

function scanCode(code: string | null, complete: boolean) {
  return code ?? (complete ? null : wholeFoodsErrors.code("WHOLEFOODS.LISTING_UNVERIFIED"));
}

async function canaryOutcome(
  run: {
    context: ListingScanContext;
    settings: WholeFoodsHttpScanSettings;
    observations: WholeFoodsSearchObservations;
  },
  first: WholeFoodsSearchRead,
): Promise<ListingScanOutcome> {
  const query = new URLSearchParams({ k: run.settings.canaryText });
  const canary = await readWholeFoodsSearch(
    run.observations,
    {
      sourceUrl: `${WHOLE_FOODS_ORIGIN}/grocery/search?${query}`,
      read: "canary",
      maxPages: 1,
      canary: true,
    },
    run.context.signal,
  );
  const result = outcome(run, [first]);
  result.metrics.reads.push(canary.summary);
  result.code = canary.summary.succeeded
    ? wholeFoodsErrors.code("WHOLEFOODS.BRAND_NOT_LISTED")
    : canaryFailureCode(canary.summary.code);
  if (canary.summary.succeeded) {
    result.soldHere = false;
    result.cooldownRequested = false;
  }
  return result;
}

function canaryFailureCode(code: string | null): string {
  return code && code !== wholeFoodsErrors.code("WHOLEFOODS.EMPTY_EXHAUSTED")
    ? code
    : wholeFoodsErrors.code("WHOLEFOODS.SEARCH_THROTTLED");
}
