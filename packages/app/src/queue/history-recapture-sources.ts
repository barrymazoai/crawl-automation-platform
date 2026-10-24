/** Which enabled brand source a previously captured Amazon listing belongs to (owner 2026-10-24, KAN-226). */

/** One listing whose latest capture is older than the cutoff, with what names its brand. */
export interface RecaptureCandidate {
  listingId: string;
  observedAt: string;
  /**
   * The brand line of the captured page ("Visit the X Store", "Brand: X"). Only the 09-13…09-29 captures kept their
   * projection in history; later captures have none here (they were queued under a brand source already).
   */
  pageBrand: string | null;
  /** The brand the capture was recorded under (for the ASIN-list captures, the placeholder source's brand). */
  ownerBrandId: string | null;
  /** The enabled source that last queued this listing, if any. */
  queuedSourceId: string | null;
}

/** An enabled source of the channel and its brand. */
export interface RecaptureSource {
  sourceId: string;
  brandId: string;
  brandName: string;
  url: string;
}

export interface HistoryRecaptureStore {
  recaptureCandidates(channel: "amazon", before: string): Promise<RecaptureCandidate[]>;
  enabledSources(channel: "amazon"): Promise<RecaptureSource[]>;
}

export type Unresolved =
  "no_page_brand" | "no_enabled_source" | "ambiguous_source" | "queued_source_conflict";
export type ResolvedVia = "queued_source" | "page_brand" | "owner_brand";
export type Resolution = { source: RecaptureSource; via: ResolvedVia } | { unresolved: Unresolved };

/** Brand text as a comparable key: accents, marks, case, spacing and punctuation removed. */
export function brandKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
}

/** The brand an Amazon page names on its byline (same wording the Amazon reader accepts, any case). */
export function pageBrandName(raw: string): string {
  return raw
    .trim()
    .replace(/^Visit the (.*) Store$/iu, "$1")
    .replace(/^Brand:\s*/iu, "")
    .trim();
}

const isSearch = (url: string) => /\/s\?/u.test(url);

/** Keys a source answers to: its brand name, its search keyword and its store's path name. */
function sourceKeys(source: RecaptureSource): string[] {
  const keys = [source.brandName];
  try {
    const url = new URL(source.url);
    keys.push(url.searchParams.get("k") ?? "");
    const store = /\/stores\/([^/]+)\/page\//u.exec(url.pathname)?.[1];
    keys.push(store ? decodeURIComponent(store.replace(/\+/gu, " ")) : "");
  } catch {
    // A malformed address still answers to its brand name.
  }
  return [...new Set(keys.map(brandKey).filter(Boolean))];
}

/**
 * Several sources for one page brand (the same search list is registered under more than one brand, e.g. Horbäach
 * under "Horbaach Manufacturing LLC" and "Healthy Natural Solutions"): the brand named exactly, then search lists,
 * then the one brand whose name contains it. Anything still tied is left alone, never guessed.
 */
function narrow(matches: readonly RecaptureSource[], key: string): readonly RecaptureSource[] {
  const steps = [
    (source: RecaptureSource) => brandKey(source.brandName) === key,
    (source: RecaptureSource) => isSearch(source.url),
    (source: RecaptureSource) => brandKey(source.brandName).includes(key),
  ];
  let left = matches;
  for (const keep of steps) {
    if (left.length <= 1) {
      break;
    }
    const kept = left.filter(keep);
    left = kept.length ? kept : left;
  }
  return left;
}

const only = (sources: readonly RecaptureSource[]) =>
  sources.length === 1 ? sources[0] : undefined;

/** Keys of the brand names that name the same brand as a page key (one contains the other). */
const sameBrand = (key: string, brandName: string) => {
  const name = brandKey(brandName);
  return name.length > 0 && (name.includes(key) || key.includes(name));
};

function grouped(sources: readonly RecaptureSource[]) {
  const byKey = new Map<string, RecaptureSource[]>();
  const byBrand = new Map<string, RecaptureSource[]>();
  for (const source of sources) {
    for (const key of sourceKeys(source)) {
      byKey.set(key, [...(byKey.get(key) ?? []), source]);
    }
    byBrand.set(source.brandId, [...(byBrand.get(source.brandId) ?? []), source]);
  }
  return { byKey, byBrand, byId: new Map(sources.map((source) => [source.sourceId, source])) };
}

/**
 * The page names the brand. In order: the enabled source that last queued the listing, if the page agrees; the
 * source matching the page brand exactly; the capture's own brand, when the page names no brand or names that same
 * brand. Otherwise unresolved.
 */
export function sourceIndex(sources: readonly RecaptureSource[]) {
  const { byKey, byBrand, byId } = grouped(sources);
  const queuedSource = (candidate: RecaptureCandidate, key: string): Resolution | null => {
    const queued = candidate.queuedSourceId ? byId.get(candidate.queuedSourceId) : undefined;
    if (!queued) {
      return null;
    }
    const agrees = !key || sourceKeys(queued).includes(key) || sameBrand(key, queued.brandName);
    return agrees
      ? { source: queued, via: "queued_source" }
      : { unresolved: "queued_source_conflict" };
  };
  const ownerSource = (candidate: RecaptureCandidate, key: string) => {
    const owned = candidate.ownerBrandId ? (byBrand.get(candidate.ownerBrandId) ?? []) : [];
    const agrees = owned.filter((source) => !key || sameBrand(key, source.brandName));
    return only(narrow(agrees, key));
  };
  return (candidate: RecaptureCandidate): Resolution => {
    const key = candidate.pageBrand ? brandKey(pageBrandName(candidate.pageBrand)) : "";
    const queued = queuedSource(candidate, key);
    if (queued) {
      return queued;
    }
    const matches = key ? narrow(byKey.get(key) ?? [], key) : [];
    const exact = only(matches);
    if (exact) {
      return { source: exact, via: "page_brand" };
    }
    const owner = ownerSource(candidate, key);
    if (owner) {
      return { source: owner, via: "owner_brand" };
    }
    if (!key) {
      return { unresolved: "no_page_brand" };
    }
    return { unresolved: matches.length ? "ambiguous_source" : "no_enabled_source" };
  };
}
