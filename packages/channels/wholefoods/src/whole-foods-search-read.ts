import {
  brandScanErrors,
  type ListingPage,
  type ListingScanMetrics,
} from "@crawl-automation/channels-core";
import { errorCodeOf } from "@crawl-automation/platform";
import { wholeFoodsSearchComplete } from "./whole-foods-search-page.js";
import type { WholeFoodsSearchObservations } from "./whole-foods-search-observations.js";

export interface WholeFoodsSearchRead {
  pages: ListingPage[];
  summary: ListingScanMetrics["reads"][number];
}

/** A canary is one logical page; a brand read follows offsets until covered or bounded. */
export async function readWholeFoodsSearch(
  observations: WholeFoodsSearchObservations,
  target: { sourceUrl: string; read: string; maxPages: number; canary?: boolean },
  signal: AbortSignal,
): Promise<WholeFoodsSearchRead> {
  const pages: ListingPage[] = [];
  let code: string | null = null;
  try {
    for (let page = 1; ; page++) {
      if (page > target.maxPages) {
        throw brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT");
      }
      const listed = await observations.page({ ...target, page });
      pages.push(listed);
      if (target.canary || listed.nextPage === null || listed.cards === 0) {
        break;
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    code = errorCodeOf(error);
    if (!code) {
      throw error;
    }
  }
  return summarizeRead(pages, { ...target, code });
}

function summarizeRead(
  pages: ListingPage[],
  target: { read: string; canary?: boolean; code: string | null },
): WholeFoodsSearchRead {
  const succeeded =
    !target.code &&
    (target.canary ? pages.some((page) => page.cards > 0) : wholeFoodsSearchComplete(pages));
  return {
    pages,
    summary: {
      read: target.read,
      pages: pages.length,
      cards: pages.reduce((sum, page) => sum + page.cards, 0),
      products: new Set(pages.flatMap((page) => page.products.map((item) => item.listingId))).size,
      availableCounts: pages.flatMap((page) =>
        page.statedTotal === null ? [] : [page.statedTotal],
      ),
      succeeded,
      code: target.code,
    },
  };
}
