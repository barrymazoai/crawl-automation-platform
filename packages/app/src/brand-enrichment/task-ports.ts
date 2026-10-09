import type {
  ApolloBrandFacts,
  ApolloOrganization,
  ApolloStep,
  BrandResearch,
  FamilyFinding,
  OwnershipClue,
  PositionTaxonomy,
  ReviewerVerdict,
  TitleClassification,
} from "@crawl-automation/v3-contracts";
import type { ApolloQuery } from "./ports.js";

/** The brand a Codex task works on. `runId` names its workspace and saved pages. */
export interface BrandSubject {
  runId: string;
  brandName: string;
  brandUrl: string | null;
}

// Codex tasks (implemented in `packages/processing/src/brand-research`). Each answer is checked against its schema
// before it is returned; code, not Codex, enforces limits and makes every Supply Smart and Apollo call.

/** Stage 2, in its own Ego page: where the URL lands, one brand or a group, and the sub-brands with evidence. */
export interface FamilyCheck {
  check(subject: BrandSubject, signal: AbortSignal): Promise<FamilyFinding>;
}

/** Stage 3b, in its own Ego page plus Codex's web search: profile and ownership clues, each with a quote and URL. */
export interface BrandResearcher {
  research(subject: BrandSubject, signal: AbortSignal): Promise<BrandResearch>;
}

export interface ApolloRound {
  query: ApolloQuery;
  organizations: ApolloOrganization[];
}

/** Stage 3c, a text turn per round: the next Apollo search, or the answer. Never sees the Apollo key. */
export interface ApolloJudge {
  next(
    input: { brand: ApolloBrandFacts; rounds: ApolloRound[]; searchesLeft: number },
    signal: AbortSignal,
  ): Promise<ApolloStep>;
}

/** Stage 5, a separate text turn that did not find the clues: owner, independent, or can't tell. */
export interface OwnershipReviewer {
  review(
    input: { brand: ApolloBrandFacts; clues: OwnershipClue[]; checkedUrls: string[] },
    signal: AbortSignal,
  ): Promise<ReviewerVerdict>;
}

/** Stage 4, a text turn: function and level for titles nobody classified before; values from the taxonomy only. */
export interface TitleClassifier {
  classify(
    input: { titles: string[]; taxonomy: PositionTaxonomy },
    signal: AbortSignal,
  ): Promise<TitleClassification[]>;
}

// Products (stage 3a): the existing DTC brand run, then the settled products sent to Supply Smart's v2 ingest.

export interface ProductDeliveryRequest {
  /** The Supply Smart company the brand's products belong to. */
  companyId: string;
  /** The brand's site, e.g. `katefarms.com`; the ingest's `siteKey` and `companyDomain`. */
  siteKey: string;
  /** Crawler brand sources whose settled DTC products are sent. */
  sourceIds: string[];
  /** Idempotency key of the ingest run, e.g. `brand-enrichment-<runId>`. */
  ingestRunId: string;
}

export interface ProductDeliveryResult {
  captured: number;
  review: number;
  delivered: number;
  /** Items Supply Smart refused, with its reason; they never fail the brand. */
  refused: { externalId: string; reason: string }[];
}

/** Sends a brand's settled DTC products to Supply Smart (`ingestObservationBatch` → verify → complete, labels). */
export interface ProductDelivery {
  deliver(request: ProductDeliveryRequest, signal: AbortSignal): Promise<ProductDeliveryResult>;
}
