import type { ListingScanContext, ListingScanOutcome } from "@crawl-automation/channels-core";
import { WHOLE_FOODS_ORIGIN } from "./whole-foods-address.js";
import type { WholeFoodsHttpScanSettings } from "./whole-foods-http-settings.js";
import { wholeFoodsErrors } from "./whole-foods-errors.js";
import { WholeFoodsSearchObservations } from "./whole-foods-search-observations.js";
import { readWholeFoodsSearch, type WholeFoodsSearchRead } from "./whole-foods-search-read.js";

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
  const complete = reads.length === 2 && reads.every((read) => read.summary.succeeded);
  const code = reads.find((read) => read.summary.code)?.summary.code ?? null;
  return {
    pages,
    credits: run.observations.credits,
    complete,
    statedTotal: reads[0]?.pages[0]?.statedTotal ?? null,
    ...(pages.some((page) => page.cards > 0) ? { soldHere: true } : {}),
    cooldownRequested: run.observations.cooldownRequested,
    code: code ?? (complete ? null : wholeFoodsErrors.code("WHOLEFOODS.LISTING_UNVERIFIED")),
    metrics: {
      storeId: run.settings.store.storeId,
      attempts: run.observations.attempts,
      reads: reads.map((read) => read.summary),
      unionSize: new Set(pages.flatMap((page) => page.products.map((item) => item.listingId))).size,
    },
  };
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
    ? null
    : (canary.summary.code ?? wholeFoodsErrors.code("WHOLEFOODS.SEARCH_THROTTLED"));
  if (canary.summary.succeeded) {
    result.soldHere = false;
  }
  return result;
}
