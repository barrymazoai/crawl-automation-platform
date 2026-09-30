import { brandScanErrors, type ListedProduct } from "@crawl-automation/channels-core";
import type { RetainedPublication } from "@crawl-automation/platform";
import { amazonErrors } from "./errors.js";
import {
  amazonStoreAddress,
  amazonStoreNavigation,
  amazonStoreSourceUrl,
} from "./store-address.js";
import { AmazonStoreArchive } from "./store-archive.js";
import {
  amazonStoreBrandScan,
  parseAmazonStoreListing,
  type AmazonStoreListing,
} from "./store-listing.js";
import { STORE_SCROLL_POLICY, type StoreDraw } from "./store-scroll.js";

export interface AmazonStoreScanDeps {
  pages: { read(url: string, signal: AbortSignal): Promise<StoreDraw> };
  publication: RetainedPublication;
}

export interface AmazonStoreProof {
  url: string;
  scroll: StoreDraw["proof"];
}

function newProducts(products: ListedProduct[], seen: Set<string>): ListedProduct[] {
  return products.filter((product) => {
    if (seen.has(product.listingId)) {
      return false;
    }
    seen.add(product.listingId);
    return true;
  });
}

function listingOf(draw: StoreDraw, url: string): AmazonStoreListing {
  const products = new Map<string, ListedProduct>();
  const navigation = new Set<string>();
  for (const snapshot of draw.snapshots) {
    if (amazonStoreSourceUrl(snapshot.url) !== url) {
      throw amazonErrors.create("AMAZON.STORE_REDIRECT");
    }
    if (snapshot.status !== null && snapshot.status !== 200) {
      throw brandScanErrors.create("BRAND_SCAN.HTTP_STATUS", {
        details: { status: snapshot.status },
      });
    }
    const listing = parseAmazonStoreListing(snapshot.html, url);
    listing.products.forEach((product) => products.set(product.listingId, product));
    listing.navigation.forEach((link) => navigation.add(link));
  }
  const proof = draw.proof;
  const complete =
    proof.ended === "stable" &&
    proof.noMore &&
    proof.bottom &&
    proof.stableRounds >= STORE_SCROLL_POLICY.stableRounds;
  return {
    sourceUrl: url,
    products: [...products.values()],
    cards: products.size,
    nextPage: null,
    statedTotal: null,
    navigation: [...navigation],
    capped: !complete,
  };
}

/** Walk the Store's own navigation. A page/scroll limit always yields a partial scan. */
export class AmazonStoreBrandScan {
  readonly sourceUrl = amazonStoreSourceUrl;
  readonly capture = "browser" as const;
  constructor(private readonly deps: AmazonStoreScanDeps) {}

  async scan(request: { scanId: string; sourceUrl: string }, signal: AbortSignal) {
    const source = amazonStoreAddress(request.sourceUrl);
    const pending = new Set([source.url]);
    const pages: AmazonStoreListing[] = [];
    const archiveKeys: string[] = [];
    const proofs: AmazonStoreProof[] = [];
    const seen = new Set<string>();
    for (const url of pending) {
      signal.throwIfAborted();
      if (pages.length >= amazonStoreBrandScan.maxPages) {
        break;
      }
      const archive = new AmazonStoreArchive(this.deps.publication, {
        scanId: request.scanId,
        url,
      });
      const draw =
        (await archive.inspect(signal)) ??
        (await archive.save(await this.deps.pages.read(url, signal), signal));
      const listing = listingOf(draw, url);
      for (const link of listing.navigation) {
        const next = amazonStoreNavigation(link, source.storeKey);
        if (next) {
          pending.add(next);
        }
      }
      pages.push({ ...listing, products: newProducts(listing.products, seen) });
      archiveKeys.push(archive.key);
      proofs.push({ url, scroll: draw.proof });
    }
    return {
      sourceUrl: source.url,
      pages,
      archiveKeys,
      proofs,
      soldHere: seen.size > 0,
      complete: pages.length === pending.size && pages.every((page) => !page.capped),
    };
  }
}
