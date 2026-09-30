import type {
  ChannelId,
  ChannelPlanInput,
  ChannelProductEvidence,
  CommerceEvidenceSchema,
  TextDocument,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import type { CaptureMode } from "./capture.js";
import type { ProductFamily } from "./product-family.js";
import type { BrandScanReader } from "./listing/brand-scan.js";

/** Price, rating, review count and availability as a product page shows them. */
export type CommerceEvidence = z.infer<typeof CommerceEvidenceSchema>;

/** Every channel the system knows; the list itself lives in the contracts. */
export { CHANNEL_IDS, type ChannelId } from "@crawl-automation/v3-contracts";

/** A product's address on its channel, known before the page is fetched. */
export interface ProductAddress {
  url: string;
  /** The channel's own product key in the URL (Swanson: the page handle; Amazon: the ASIN). */
  listingId: string;
  /** The selected size or option, when the URL names one. */
  variantId: string | null;
}

/** One fetched product page, exactly as it was archived. */
export interface FetchedPage {
  url: string;
  html: string;
  capturedAt: string;
}

/** The supplement facts as plain text, and whether that text alone is enough to read the formula. */
export interface FactsText {
  text: string | null;
  complete: boolean;
  /** Why the text is not enough, e.g. `FACTS.SERVING_SIZE_MISSING`. */
  missing: string[];
}

/** The product's identity as the page itself states it (Swanson: product ID and selected variant ID). */
export interface ProductIdentity {
  listingId: string;
  variantId: string | null;
}

/** What a channel adapter reads from one product page. */
export interface ParsedProduct<Rendered = unknown> {
  channel: ChannelId;
  identity: ProductIdentity;
  /** The channel's own page projection; archived as-is and used again by the formula planner. */
  rendered: Rendered;
  /** Channel-independent product evidence: identity, title, facts candidates, images. */
  evidence: ChannelProductEvidence;
  /** Price, rating, review count and availability as the page shows them; null when absent. */
  commerce: CommerceEvidence | null;
  /** The product's sizes or options, each as its own address. */
  variants: ProductAddress[];
  facts: FactsText;
}

/** How a channel's pages may be fetched over HTTP: only from these origins, within these limits. */
export interface HttpPolicy {
  origins: readonly string[];
  maxBytes: number;
  timeoutMs: number;
}

/** What a channel's planning hook reads back from its own page projection. */
export interface PlannedProduct {
  evidence: ChannelProductEvidence;
  /** The adapter's facts judgement: complete facts text makes the page the only formula source. */
  facts: FactsText;
}

/**
 * How the formula planner reads this channel's page projection. Only channels with this hook can run the formula
 * step.
 */
export interface ChannelPlanning<Rendered = unknown> {
  channel: ChannelPlanInput["channel"];
  parserVersion: ChannelPlanInput["parserVersion"];
  /** Names who produced the projection, e.g. `swanson.http-projection`. */
  projectionModule: string;
  /** The part of the rendered page the planner reads. */
  projection(rendered: Rendered): unknown;
  /**
   * Reads a retained projection back for the planner, checked against the expected URL and the observation's own
   * identity: the product evidence and the adapter's facts judgement.
   */
  read(projection: unknown, expectedUrl: string, owner: ProductIdentity): PlannedProduct;
  /** The label workflow's channel-specific core step, when the channel has one. */
  corePolicy?: TextDocument["corePolicy"];
  /** How that core step reads the label facts text from the product page (supplied to processing by name). */
  labelCore?: LabelCoreReader;
}

/** A channel's label-core reader: which page producer it reads, and how it picks out the label facts text. */
export interface LabelCoreReader {
  sourceModule: string;
  sourceVersion?: string;
  extract(html: string): string;
}

/**
 * Everything specific to one website. The shared pipeline asks the adapter; the adapter never talks to the
 * database, Temporal or permits, and never imports another channel.
 */
export interface ChannelAdapter<Rendered = unknown> {
  readonly id: ChannelId;
  /** Allowed product capture strategies; browser-only channels never use ScraperAPI. */
  readonly captureModes: readonly CaptureMode[];
  /** Shared listing-ID namespace for formula reuse; absent means formulas stay on this channel. */
  readonly formulaFamily?: string;
  /** Which sites the product pages may come from, and their size and time limits. */
  readonly httpPolicy: HttpPolicy;
  /** Where product images may be downloaded from; defaults to the page origins. */
  readonly fileOrigins?: readonly string[];
  readonly planning?: ChannelPlanning<Rendered>;
  /** How this channel lists one brand's products, for brand scans (through ScraperAPI). */
  readonly brandScan?: BrandScanReader;
  /** Capture for this brand-source URL; absent means HTTP. Independent of product captureModes. */
  scanCapture?(url: string): CaptureMode;
  /** Normalises a product URL and returns its identity; refuses URLs of other sites. */
  productAddress(url: string): ProductAddress;
  /**
   * The page's own listing key, in the same namespace as productAddress (Swanson: canonical handle, not Shopify
   * product ID). Read before product parsing so another product is an unlisted sighting, even if its facts fail.
   * Null means the page identity is unknown; never infer it from the requested URL or parsed identity.
   * Adapters without this hook are compared after parsing, using ParsedProduct.identity.
   */
  pageIdentity?(page: FetchedPage): ProductIdentity | null;
  /** Reads one archived product page. Throws a channel error code when the page is not a readable product. */
  parseProduct(page: FetchedPage): ParsedProduct<Rendered>;
  /** The product's family as its page shows it (other sizes, flavours…); null when the page shows none. */
  productFamily?(parsed: ParsedProduct<Rendered>): ProductFamily | null;
  /** The product ID the metrics history keys this listing by; the address's listing ID when absent. */
  externalId?(parsed: ParsedProduct<Rendered>): string;
}
