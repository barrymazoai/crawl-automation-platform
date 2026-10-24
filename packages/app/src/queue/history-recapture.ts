import { z } from "zod";
import { appErrors } from "../errors.js";
import { listIdFrom } from "./list-id.js";
import type { QueuedProduct } from "./queue-model.js";
import {
  pageBrandName,
  sourceIndex,
  type HistoryRecaptureStore,
  type RecaptureCandidate,
  type RecaptureSource,
  type ResolvedVia,
  type Unresolved,
} from "./history-recapture-sources.js";

export * from "./history-recapture-sources.js";

/**
 * Owner 2026-10-24 (KAN-226): Amazon products captured before a round but never queued in it are queued again,
 * under the enabled brand source their own page names. Brand scans only queue what they list and only revisit
 * what the same source queued before, so products captured from the pre-round ASIN list (owned by the disabled
 * amazon.com placeholder sources) were never captured again. Preview is the default; queueing names the preview's
 * batch ID, so a retried or changed request cannot queue a different selection.
 */
export const RecaptureHistorySchema = z
  .strictObject({
    channel: z.literal("amazon"),
    /** Products whose latest capture is older than this, and that no queue item since has asked for. */
    lastObservedBefore: z.iso
      .datetime({ offset: true })
      .refine((value) => Date.parse(value) <= Date.now(), {
        message: "lastObservedBefore must be in the past",
      }),
    /** Only these ASINs among the candidates (a pilot, or a targeted recapture). */
    listingIds: z
      .array(z.string().regex(/^[A-Z0-9]{10}$/u))
      .min(1)
      .max(200)
      .optional(),
    limit: z.number().int().min(1).max(2_000),
    dryRun: z.boolean().default(true),
    /** Required to queue: the batch ID the preview of the same request returned. */
    expectBatchId: z.uuid().optional(),
  })
  .refine((input) => input.dryRun || input.expectBatchId, {
    message: "Queueing needs expectBatchId from the preview of the same request.",
  });
export type RecaptureHistory = z.infer<typeof RecaptureHistorySchema>;

export interface RecaptureHistoryResult {
  dryRun: boolean;
  candidates: number;
  /** Named ASINs that are not candidates (captured since the cutoff, queued, unlisted or unknown). */
  notCandidates: string[];
  resolved: number;
  unresolved: Record<Unresolved, number>;
  /** Resolved listings whose source belongs to another brand than their capture (Supply Smart sees the new one). */
  brandChanges: number;
  selected: number;
  batchId: string | null;
  added?: number;
  following?: number;
  bySource: { sourceId: string; brandName: string; count: number }[];
  unresolvedBrands: { pageBrand: string; reason: Unresolved; count: number }[];
  sample: { listingId: string; sourceId: string; brandName: string; via: ResolvedVia }[];
}

/** The largest counts first, ties by name. */
function largest(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit);
}

const increment = (counts: Map<string, number>, key: string) =>
  counts.set(key, (counts.get(key) ?? 0) + 1);

interface Resolved {
  candidate: RecaptureCandidate;
  source: RecaptureSource;
  via: ResolvedVia;
}

/** Each candidate on its source, or counted with its page brand as unresolved. */
function resolveAll(
  candidates: readonly RecaptureCandidate[],
  sources: readonly RecaptureSource[],
) {
  const resolve = sourceIndex(sources);
  const unresolved: Record<Unresolved, number> = {
    no_page_brand: 0,
    no_enabled_source: 0,
    ambiguous_source: 0,
    queued_source_conflict: 0,
  };
  const unresolvedBrands = new Map<string, number>();
  const resolved: Resolved[] = [];
  for (const candidate of candidates) {
    const resolution = resolve(candidate);
    if ("unresolved" in resolution) {
      unresolved[resolution.unresolved] += 1;
      const name = candidate.pageBrand ? pageBrandName(candidate.pageBrand) : "";
      increment(unresolvedBrands, JSON.stringify([name, resolution.unresolved]));
    } else {
      resolved.push({ candidate, ...resolution });
    }
  }
  return { resolved, unresolved, unresolvedBrands };
}

const productOf = ({ candidate, source }: Resolved): QueuedProduct => ({
  sourceId: source.sourceId,
  url: `https://www.amazon.com/dp/${candidate.listingId}`,
  listingId: candidate.listingId,
  variantId: null,
});

/** The selection's own list ID: the same products under the same sources always name the same list. */
const selectionBatchId = (products: readonly QueuedProduct[]) =>
  listIdFrom(
    JSON.stringify([
      "history-recapture/1",
      products.map((product) => [product.listingId, product.sourceId]),
    ]),
  );

/** The sources the selection goes to, largest first. */
function bySource(selected: readonly Resolved[]) {
  const counts = new Map<string, number>();
  const brandOf = new Map<string, string>();
  for (const { source } of selected) {
    increment(counts, source.sourceId);
    brandOf.set(source.sourceId, source.brandName);
  }
  return largest(counts, 30).map(([sourceId, count]) => ({
    sourceId,
    brandName: brandOf.get(sourceId) ?? "",
    count,
  }));
}

function summary(at: {
  input: RecaptureHistory;
  named: readonly RecaptureCandidate[];
  resolution: ReturnType<typeof resolveAll>;
  selected: readonly Resolved[];
  batchId: string | null;
}): RecaptureHistoryResult {
  const { input, named, resolution, selected } = at;
  const found = new Set(named.map((candidate) => candidate.listingId));
  return {
    dryRun: input.dryRun,
    candidates: named.length,
    notCandidates: (input.listingIds ?? []).filter((listingId) => !found.has(listingId)),
    resolved: resolution.resolved.length,
    unresolved: resolution.unresolved,
    brandChanges: resolution.resolved.filter(
      ({ candidate, source }) =>
        candidate.ownerBrandId && candidate.ownerBrandId !== source.brandId,
    ).length,
    selected: selected.length,
    batchId: at.batchId,
    bySource: bySource(selected),
    unresolvedBrands: largest(resolution.unresolvedBrands, 50).map(([key, count]) => {
      const [pageBrand, reason] = JSON.parse(key) as [string, Unresolved];
      return { pageBrand, reason, count };
    }),
    sample: selected.slice(0, 10).map(({ candidate, source, via }) => ({
      listingId: candidate.listingId,
      sourceId: source.sourceId,
      brandName: source.brandName,
      via,
    })),
  };
}

export interface RecaptureHistoryDeps {
  store: HistoryRecaptureStore;
  add: (input: {
    channel: "amazon";
    batchId: string;
    label: string;
    products: QueuedProduct[];
  }) => Promise<{ added: number; following?: number }>;
}

/** Selects, resolves and (unless previewing) queues; the queue's own admission decides what runs. */
export async function recaptureHistory(
  deps: RecaptureHistoryDeps,
  input: RecaptureHistory,
): Promise<RecaptureHistoryResult> {
  const [candidates, sources] = await Promise.all([
    deps.store.recaptureCandidates(input.channel, input.lastObservedBefore),
    deps.store.enabledSources(input.channel),
  ]);
  const wanted = input.listingIds && new Set(input.listingIds);
  const named = wanted ? candidates.filter((entry) => wanted.has(entry.listingId)) : candidates;
  const resolution = resolveAll(named, sources);
  const selected = resolution.resolved.slice(0, input.limit);
  const products = selected.map(productOf);
  const batchId = products.length ? selectionBatchId(products) : null;
  const result = summary({ input, named, resolution, selected, batchId });
  if (input.dryRun || !batchId) {
    return result;
  }
  if (input.expectBatchId !== batchId) {
    throw appErrors.create("QUEUE.RECAPTURE_SELECTION_CHANGED", {
      details: { expected: input.expectBatchId, selected: batchId },
    });
  }
  const added = await deps.add({
    channel: input.channel,
    batchId,
    label: `history recapture: last captured before ${input.lastObservedBefore.slice(0, 10)}`,
    products,
  });
  return { ...result, added: added.added, following: added.following ?? 0 };
}
