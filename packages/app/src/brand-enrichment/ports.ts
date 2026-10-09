import type {
  ApolloOrganization,
  ApolloPerson,
  BrandEnrichmentQuestion,
  BrandEnrichmentRole,
  BrandEnrichmentRun,
  BrandEnrichmentSummary,
  BrandRequest,
  BrandRequestUpdate,
  Company,
  CompanyEnrichment,
  CompanyEnrichmentResult,
  CompanyFacts,
  CompanyLink,
  CompanyLinkResult,
  CompanyResolution,
  CompanyUnlink,
  Contact,
  DomainAddition,
  DomainAdditionResult,
  DomainResolution,
  KnownPosition,
  NewCompany,
  OwnershipCheck,
  OwnershipClue,
  OwnershipStatus,
  PositionClassification,
  PositionTaxonomy,
  StoredDecision,
} from "@crawl-automation/v3-contracts";

// Supply Smart is reached only through its API with a service key (owner 2026-10-08), and receives only decided
// results. Three ports, one per area of its API.

/** Brand requests on the biz API. */
export interface BrandRequests {
  pending(limit: number, signal: AbortSignal): Promise<BrandRequest[]>;
  /** `claimed: false` when another worker moved it to in_progress first (409). */
  update(update: BrandRequestUpdate, signal: AbortSignal): Promise<{ claimed: boolean }>;
}

export type LinkOutcome =
  | { status: "linked"; result: CompanyLinkResult }
  /** 409: the brand already has an owner of that kind. Kept as a question for a person, never overwritten. */
  | { status: "conflict"; detail: unknown };

/** Companies on the product database API. */
export interface SupplySmartCompanies {
  resolveDomain(domain: string, signal: AbortSignal): Promise<DomainResolution>;
  resolve(facts: CompanyFacts, signal: AbortSignal): Promise<CompanyResolution>;
  get(companyId: string, signal: AbortSignal): Promise<Company>;
  /** A normal, visible company (owner 2026-10-08). */
  create(company: NewCompany, signal: AbortSignal): Promise<Company>;
  addDomains(addition: DomainAddition, signal: AbortSignal): Promise<DomainAdditionResult>;
  enrich(enrichment: CompanyEnrichment, signal: AbortSignal): Promise<CompanyEnrichmentResult>;
  link(link: CompanyLink, signal: AbortSignal): Promise<LinkOutcome>;
  unlink(unlink: CompanyUnlink, signal: AbortSignal): Promise<{ status: "removed" | "missing" }>;
  recordOwnershipCheck(check: OwnershipCheck, signal: AbortSignal): Promise<void>;
  ownershipStatus(companyId: string, signal: AbortSignal): Promise<OwnershipStatus>;
}

/** Contacts and their position classification on the product database API. */
export interface SupplySmartContacts {
  ofCompany(companyId: string, signal: AbortSignal): Promise<Contact[]>;
  positionTaxonomy(signal: AbortSignal): Promise<PositionTaxonomy>;
  knownPositions(titles: string[], signal: AbortSignal): Promise<KnownPosition[]>;
  classifyPositions(
    items: PositionClassification[],
    signal: AbortSignal,
  ): Promise<{ updated: number; skipped: number }>;
}

/** One Apollo search the Apollo-match task asked for. */
export type ApolloQuery = { by: "domain"; domain: string } | { by: "name"; name: string };

/** Apollo, reached only from the crawler's server, which holds the key. */
export interface Apollo {
  searchOrganizations(query: ApolloQuery, signal: AbortSignal): Promise<ApolloOrganization[]>;
  /** First page of people (up to 100) at one organization; Apollo's free people search. */
  people(organizationId: string, signal: AbortSignal): Promise<ApolloPerson[]>;
}

export interface NewBrandEnrichmentRun {
  runId: string;
  requestId: string | null;
  parentRunId: string | null;
  role: BrandEnrichmentRole;
  brandName: string;
  brandUrl: string | null;
  workflowId: string;
}

export interface BrandEnrichmentRunChange {
  state?: BrandEnrichmentRun["state"];
  stage?: string;
  companyId?: string;
  summary?: BrandEnrichmentSummary;
  failureReason?: string;
}

export interface StepOutput {
  runId: string;
  step: string;
  output: unknown;
  archiveKeys: string[];
}

export interface ApolloTry {
  attempt: number;
  query: ApolloQuery;
  organizationIds: string[];
}

/** The crawler's record of each run: its steps, ownership clues and Apollo tries. */
export interface BrandEnrichmentRuns {
  /** A request that already has a live run returns that run (`created: false`). */
  create(run: NewBrandEnrichmentRun): Promise<{ run: BrandEnrichmentRun; created: boolean }>;
  get(runId: string): Promise<BrandEnrichmentRun | null>;
  list(filter: {
    state?: BrandEnrichmentRun["state"];
    parentRunId?: string;
    limit: number;
  }): Promise<BrandEnrichmentRun[]>;
  update(runId: string, change: BrandEnrichmentRunChange): Promise<BrandEnrichmentRun>;

  /** A step's checked output, saved once; the first saved output wins and is returned. */
  saveStep(step: StepOutput): Promise<unknown>;
  step(runId: string, step: string): Promise<unknown>;

  addClues(runId: string, clues: OwnershipClue[]): Promise<void>;
  clues(runId: string): Promise<OwnershipClue[]>;

  /** Refuses a fourth try (database check as well as code). */
  recordApolloTry(runId: string, attempt: ApolloTry): Promise<void>;
  apolloTries(runId: string): Promise<number>;
}

export type NewDecision = Omit<StoredDecision, "decisionId" | "sent" | "spotCheck" | "createdAt">;

/** Reviewer decisions and the questions that wait for a person. Never sent to Supply Smart. */
export interface BrandEnrichmentReviews {
  addDecision(decision: NewDecision): Promise<StoredDecision>;
  markDecisionSent(decisionId: string, sent: Record<string, unknown>): Promise<void>;
  decisions(runId: string): Promise<StoredDecision[]>;
  recordSpotCheck(decisionId: string, check: Record<string, unknown>): Promise<StoredDecision>;

  addQuestion(
    runId: string,
    kind: BrandEnrichmentQuestion["kind"],
    question: Record<string, unknown>,
  ): Promise<BrandEnrichmentQuestion>;
  questions(filter: {
    state?: BrandEnrichmentQuestion["state"];
    runId?: string;
    limit: number;
  }): Promise<BrandEnrichmentQuestion[]>;
  answerQuestion(
    questionId: string,
    state: "answered" | "dismissed",
    answer: Record<string, unknown>,
  ): Promise<BrandEnrichmentQuestion>;
}
