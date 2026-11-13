/** Values observed after each settled scroll, before any business parsing. */
export interface StoreObservation {
  url: string;
  html: string;
  capturedAt: string;
  status: number | null;
  tileCount: number;
  asins: string[];
  navigation: string[];
  ready: boolean;
  blocked: boolean;
  invalidTiles: boolean;
  more: boolean;
  loading: boolean;
  bottom: boolean;
}

export interface StoreScrollPolicy {
  stableRounds: number;
  maxRounds: number;
  maxBytes: number;
}

export const STORE_SCROLL_POLICY: StoreScrollPolicy = {
  stableRounds: 3,
  maxRounds: 60,
  maxBytes: 6 * 1024 * 1024,
};

export interface StorePageDriver {
  snapshot(): Promise<StoreObservation>;
  advance(more: boolean): Promise<void>;
}

/**
 * Keeps a snapshot and returns the change in retained bytes. Show more appends: a snapshot holding every ASIN and
 * link of the previous valid one on the same page supersedes it, so a Store keeps about one page of HTML instead of
 * one per press (Nature's Bounty, 2026-11-13: 7 presses filled 6 MiB at 132 of 188 products). A list that drops
 * tiles keeps both. Self-contained: Ego receives it as the third argument of `scrollStorePage`.
 */
export function retainStoreSnapshot(
  snapshots: StoreObservation[],
  state: StoreObservation,
  invalid: boolean,
): number {
  const size = (snapshot: StoreObservation) => new TextEncoder().encode(snapshot.html).byteLength;
  const last = snapshots.at(-1);
  const same = !!last && [last.url === state.url, last.status === state.status].every(Boolean);
  const valid =
    !!last && !invalid && [last.ready, !last.blocked, !last.invalidTiles].every(Boolean);
  const keys = new Set([...state.asins, ...state.navigation]);
  const contained = !!last && [...last.asins, ...last.navigation].every((key) => keys.has(key));
  const freed = [same, valid, contained].every(Boolean)
    ? size(snapshots.pop() as StoreObservation)
    : 0;
  snapshots.push(state);
  return size(state) - freed;
}

/**
 * Identity-based exhaustion, including equal-count replacements and virtualized tiles. Keep raw
 * HTML whenever a new ASIN/navigation link appears, so every emitted product has retained evidence.
 * This function is self-contained: its compiled body also runs inside Ego's Node runtime, where `retain`
 * (`retainStoreSnapshot`) is passed in: a bundled name of it would not exist there.
 */
export async function scrollStorePage(
  driver: StorePageDriver,
  policy: StoreScrollPolicy,
  retain: typeof retainStoreSnapshot,
) {
  const seen = new Set<string>();
  const snapshots: StoreObservation[] = [];
  let stable = 0;
  let bytes = 0;
  for (let rounds = 0; rounds <= policy.maxRounds; rounds++) {
    const state = await driver.snapshot();
    const keys = [...state.asins, ...state.navigation, `page:${state.url}:${state.status}`];
    const countChanged = snapshots.at(-1)?.tileCount !== state.tileCount;
    const changed = countChanged || keys.some((key) => !seen.has(key));
    const invalid = [!state.ready, state.blocked, state.invalidTiles].some(Boolean);
    const keep = [changed, !snapshots.length, invalid].some(Boolean);
    bytes += keep ? retain(snapshots, state, invalid) : 0;
    keys.forEach((key) => seen.add(key));
    const exhausted = [!state.more, !state.loading, state.bottom].every(Boolean);
    stable = [rounds > 0, !changed, exhausted].every(Boolean) ? stable + 1 : 0;
    const proof = { rounds, stableRounds: stable, noMore: !state.more, bottom: state.bottom };
    const finish = (ended: StoreDraw["proof"]["ended"]): StoreDraw => {
      if (snapshots.at(-1)?.html !== state.html) {
        snapshots.push(state);
      }
      return { snapshots, proof: { ...proof, ended } };
    };
    if (invalid) {
      return finish("unverified");
    }
    if (bytes > policy.maxBytes || rounds === policy.maxRounds) {
      return finish("capped");
    }
    if (stable >= policy.stableRounds) {
      return finish("stable");
    }
    await driver.advance(state.more);
  }
  throw new RangeError("Store scroll policy must allow an initial observation");
}

export interface StoreDraw {
  snapshots: StoreObservation[];
  proof: {
    rounds: number;
    stableRounds: number;
    noMore: boolean;
    bottom: boolean;
    ended: "stable" | "capped" | "unverified";
  };
}
