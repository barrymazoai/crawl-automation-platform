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
 * Identity-based exhaustion, including equal-count replacements and virtualized tiles. Keep raw
 * HTML whenever a new ASIN/navigation link appears, so every emitted product has retained evidence.
 * This function is self-contained: its compiled body also runs inside Ego's Node runtime.
 */
export async function scrollStorePage(driver: StorePageDriver, policy: StoreScrollPolicy) {
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
    if ([changed, snapshots.length === 0, invalid].some(Boolean)) {
      bytes += new TextEncoder().encode(state.html).byteLength;
      snapshots.push(state);
    }
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
