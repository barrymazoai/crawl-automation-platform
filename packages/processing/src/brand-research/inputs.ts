import type {
  ApolloBrandFacts,
  ApolloOrganization,
  ApolloStep,
  BrandEnrichmentRun,
  OwnershipClue,
  PositionTaxonomy,
} from "@crawl-automation/v3-contracts";

// Structural adapters implement the application's task ports without importing the upper application layer.
export type BrandSubject = Pick<BrandEnrichmentRun, "runId" | "brandName" | "brandUrl">;
export type ApolloQuery = Extract<ApolloStep, { action: "search" }>["query"];
export interface ApolloInput {
  brand: ApolloBrandFacts;
  rounds: { query: ApolloQuery; organizations: ApolloOrganization[] }[];
  searchesLeft: number;
}
export interface ReviewerInput {
  brand: ApolloBrandFacts;
  clues: OwnershipClue[];
  checkedUrls: string[];
}
export interface TitlesInput {
  titles: string[];
  taxonomy: PositionTaxonomy;
}
