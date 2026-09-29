import type {
  ChannelLabelInput,
  ChannelPlanInput,
  ChannelProductEvidence,
  CommerceEvidenceSchema,
} from "@crawl-automation/v3-contracts";
import type { z } from "zod";
import type { CaptureMode } from "./capture.js";

/** Price, rating, review count and availability as a product page shows them. */
export type CommerceEvidence = z.infer<typeof CommerceEvidenceSchema>;

export type ChannelId = "amazon" | "gnc" | "swanson" | "dtc" | "costco" | "wholefoods";

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

/**
 * How the formula planner (the existing channel-plan worker) reads this channel's page projection. Only channels
 * the planner knows have one; the others cannot yet run the formula step.
 */
export interface ChannelPlanning<Rendered = unknown> {
  channel: ChannelPlanInput["channel"];
  parserVersion: ChannelPlanInput["parserVersion"];
  /** Names who produced the projection, e.g. `swanson.http-projection`. */
  projectionModule: string;
  /** The part of the rendered page the planner reads. */
  projection(rendered: Rendered): unknown;
  /** The label workflow's channel-specific core step, when the channel has one. */
  corePolicy?: ChannelLabelInput["corePolicy"];
}

/**
 * Everything specific to one website. The shared pipeline asks the adapter; the adapter never talks to the
 * database, Temporal or permits, and never imports another channel.
 */
export interface ChannelAdapter<Rendered = unknown> {
  readonly id: ChannelId;
  /** The capture modes this website supports, preferred first. */
  readonly captureModes: readonly CaptureMode[];
  /** Required when `captureModes` includes `http`. */
  readonly httpPolicy?: HttpPolicy;
  /** Where product images may be downloaded from; defaults to the page origins. */
  readonly fileOrigins?: readonly string[];
  readonly planning?: ChannelPlanning<Rendered>;
  /** Normalises a product URL and returns its identity; refuses URLs of other sites. */
  productAddress(url: string): ProductAddress;
  /** Reads one archived product page. Throws a channel error code when the page is not a readable product. */
  parseProduct(page: FetchedPage): ParsedProduct<Rendered>;
}
