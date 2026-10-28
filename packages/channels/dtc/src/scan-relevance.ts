import { z } from "zod";
import { recordRecovery, sha256, type RetainedPublication } from "@crawl-automation/platform";
import type { ListingExclusion } from "@crawl-automation/channels-core";
import { neverCollectPath } from "./adapter.js";
import type { DtcBrandScanResult, DtcListedProduct } from "./brand-scan.js";
import { dtcAgentErrors } from "./agent/errors.js";

export type DtcRelevanceModel = (
  call: { prompt: string; outputSchema: object },
  signal: AbortSignal,
) => Promise<string>;

/** Products per model call; a 136-product store (DMoose) is two calls. */
const BATCH = 100;
const POLICY = "dtc-scan-relevance/1";

const AnswerSchema = z.strictObject({
  products: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        verdict: z.enum(["supplement", "not_supplement", "unsure"]),
        reason: z.string().min(1).max(300),
      }),
    )
    .max(BATCH),
});

interface Candidate {
  id: string;
  title: string;
  productType: string | null;
  tags: string[];
}

/**
 * Owner 2026-10-28: a store's apparel, gym equipment and gift cards are judged before they are queued, not after a
 * full capture and label Review (DMoose: 923 of 1,027 scanned variants). A store product type on the never-collect
 * list ends the product here; the rest go to one model call per batch. Anything unsure, unanswered or failed is
 * queued as before: the judgement only ever removes clear non-supplements.
 */
export class DtcScanRelevance {
  constructor(
    private readonly deps: {
      publication: RetainedPublication;
      model: DtcRelevanceModel;
      onJudged?: (judged: { sourceUrl: string; products: number; excluded: number }) => void;
    },
  ) {}

  async judge(result: DtcBrandScanResult, signal: AbortSignal): Promise<DtcBrandScanResult> {
    const all = candidates(result);
    const excluded = new Map<string, ListingExclusion>();
    const open: Candidate[] = [];
    for (const candidate of all) {
      const filing = neverCollectPath([], candidate.productType ?? undefined);
      if (filing) {
        excluded.set(candidate.id, {
          basis: "store-category",
          reason: `Store product type "${candidate.productType}"`,
        });
      } else {
        open.push(candidate);
      }
    }
    for (let start = 0; start < open.length; start += BATCH) {
      try {
        for (const [id, exclusion] of await this.ask(open.slice(start, start + BATCH), signal)) {
          excluded.set(id, exclusion);
        }
      } catch (error) {
        signal.throwIfAborted();
        recordRecovery(error, { operation: "dtc/scan-relevance", sourceUrl: result.sourceUrl });
      }
    }
    this.deps.onJudged?.({
      sourceUrl: result.sourceUrl,
      products: all.length,
      excluded: excluded.size,
    });
    return withExclusions(result, excluded);
  }

  private async ask(batch: Candidate[], signal: AbortSignal) {
    const input = { policy: POLICY, products: batch };
    const bytes = Buffer.from(JSON.stringify(input));
    const root = `v3/dtc-scan-relevance/${sha256(bytes)}`;
    const prior = await this.deps.publication.remote.read(`${root}/answer.json`, 1_000_000, signal);
    let answer: string;
    if (prior) {
      answer = z
        .object({ answer: z.string() })
        .parse(JSON.parse(Buffer.from(prior).toString())).answer;
    } else {
      await this.deps.publication.publish(`${root}/input.json`, bytes, "application/json", signal);
      answer = await this.deps.model(
        { prompt: relevancePrompt(batch), outputSchema: z.toJSONSchema(AnswerSchema) },
        signal,
      );
      await this.deps.publication.publish(
        `${root}/answer.json`,
        Buffer.from(JSON.stringify({ answer })),
        "application/json",
        signal,
      );
    }
    return exclusions(answer, batch, `${root}/answer.json`);
  }
}

/** One entry per product: its variants share the listing ID and the judgement. */
function candidates(result: DtcBrandScanResult): Candidate[] {
  const byListing = new Map<string, Candidate>();
  for (const product of result.pages.flatMap((page) => page.products)) {
    if (!byListing.has(product.listingId)) {
      byListing.set(product.listingId, candidate(product));
    }
  }
  return [...byListing.values()];
}

function candidate(product: DtcListedProduct): Candidate {
  return {
    id: product.listingId,
    title: (product.productTitle ?? product.title ?? product.url).slice(0, 300),
    productType: product.productType ?? null,
    tags: product.tags ?? [],
  };
}

/** Only an exact, complete answer counts; a product it names twice or not at all stays queued. */
function exclusions(answer: string, batch: Candidate[], evidenceKey: string) {
  const parsed = AnswerSchema.parse(JSON.parse(answer));
  const ids = new Set(batch.map((item) => item.id));
  const named = parsed.products.map((item) => item.id);
  if (named.some((id) => !ids.has(id)) || new Set(named).size !== named.length) {
    throw dtcAgentErrors.create("DTC.SCAN_RELEVANCE_UNRESOLVED", { details: { evidenceKey } });
  }
  return parsed.products
    .filter((item) => item.verdict === "not_supplement")
    .map((item): [string, ListingExclusion] => [
      item.id,
      { basis: "model", reason: item.reason, evidenceKey },
    ]);
}

function withExclusions(
  result: DtcBrandScanResult,
  excluded: ReadonlyMap<string, ListingExclusion>,
): DtcBrandScanResult {
  if (excluded.size === 0) {
    return result;
  }
  return {
    ...result,
    pages: result.pages.map((page) => ({
      ...page,
      products: page.products.map((product) => {
        const exclusion = excluded.get(product.listingId);
        return exclusion ? { ...product, excluded: exclusion } : product;
      }),
    })),
  };
}

function relevancePrompt(batch: Candidate[]): string {
  return `You sort one online store's catalog before a dietary-supplement crawler queues it.
For every product below decide from its title, the store's product type and its tags (do not browse):
- "supplement": something people swallow or drink for nutrition or health, sold with a Supplement Facts or Nutrition Facts label: vitamins, minerals, herbs, probiotics, protein powders, shakes and bars, pre- and post-workout, amino acids, creatine, electrolyte and hydration mixes, meal replacements, functional drinks and gummies, pet supplements, and bundles or stacks of these.
- "not_supplement": anything else: clothing, hats, bags, gym equipment and accessories (belts, straps, wraps, sleeves, bands, bars, plates, bottles, shakers), devices, books, programs, memberships, gift cards, skin, hair and body care, essential oils, candles, teas, merchandise, and bundles made only of such items.
- "unsure": the title and filing do not tell. Products you are not sure about are still crawled, so answer "not_supplement" only when it is clear.
Return every id exactly once, with a short reason quoting what decided it.

Products (JSON):
${JSON.stringify(batch)}`;
}
