import { z } from "zod";
import {
  ApolloStepSchema,
  CompanyEnrichmentSchema,
  type ApolloBrandFacts,
  type ApolloStep,
  type ApolloOrganization,
} from "@crawl-automation/v3-contracts";
import type { Apollo, BrandEnrichmentRuns } from "./ports.js";
import type { ApolloJudge, ApolloRound } from "./task-ports.js";
import { brandFacts } from "./brand-facts.js";
import { domainOf, saveOutput } from "./run-records.js";

export const BrandApolloResultSchema = z.object({
  status: z.enum(["matched", "parent_only", "no_match"]),
  attempts: z.number().int().min(0).max(3),
  apollo: CompanyEnrichmentSchema.shape.apollo,
  note: z.string(),
});
export type BrandApolloResult = z.infer<typeof BrandApolloResultSchema>;

/** Bounded strategy loop: Codex proposes a search; application code owns the Apollo calls and acceptance. */
export class BrandApolloService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      apollo: Apollo;
      judge: ApolloJudge;
      searchLimit: number;
    },
  ) {}
  async match(runId: string, signal: AbortSignal): Promise<BrandApolloResult> {
    const brand = await brandFacts(this.deps.runs, runId);
    const rounds: ApolloRound[] = [];
    let attempts = await this.deps.runs.apolloTries(runId);
    const limit = Math.min(3, this.deps.searchLimit);
    let result: BrandApolloResult = { status: "no_match", attempts, note: "Search limit reached" };
    for (let turn = 0; turn <= limit; turn++) {
      const step = ApolloStepSchema.parse(
        await this.deps.judge.next(
          { brand, rounds, searchesLeft: Math.max(0, limit - attempts) },
          signal,
        ),
      );
      await saveOutput(this.deps.runs, { runId, step: `apollo-judgment-${turn}`, output: step });
      if (step.action !== "search") {
        result = await this.accept({ runId, brand, rounds, step, attempts }, signal);
        break;
      }
      if (attempts >= limit) {
        break;
      }
      const organizations = await this.deps.apollo.searchOrganizations(step.query, signal);
      attempts++;
      await this.deps.runs.recordApolloTry(runId, {
        attempt: attempts,
        query: step.query,
        organizationIds: organizations.map((org) => org.id),
      });
      rounds.push({ query: step.query, organizations });
      await saveOutput(this.deps.runs, {
        runId,
        step: `apollo-round-${attempts}`,
        output: rounds.at(-1),
      });
      result = { status: "no_match", attempts, note: "Search limit reached" };
    }
    await saveOutput(this.deps.runs, { runId, step: "apollo", output: result });
    return result;
  }
  private async accept(
    input: {
      runId: string;
      brand: ApolloBrandFacts;
      rounds: ApolloRound[];
      step: Exclude<ApolloStep, { action: "search" }>;
      attempts: number;
    },
    signal: AbortSignal,
  ): Promise<BrandApolloResult> {
    const { step, attempts } = input;
    const noMatch = (note: string): BrandApolloResult => ({ status: "no_match", attempts, note });
    if (step.action === "give_up") {
      return noMatch(step.note);
    }
    const organization = input.rounds
      .flatMap((round) => round.organizations)
      .find((org) => org.id === step.organizationId);
    if (!organization) {
      return noMatch("Judge selected an organization Apollo did not return");
    }
    if (step.action === "parent_only") {
      await this.parentClue({ runId: input.runId, organization, note: step.note });
    } else if (!verifiedTie({ step, brand: input.brand, organization })) {
      return noMatch("The proposed domain tie is not present on the returned organization");
    }
    const people = await this.people(organization.id, signal);
    return {
      status: step.action === "parent_only" ? "parent_only" : "matched",
      attempts,
      note: step.note,
      apollo: { organization, match: { by: step.tie, attempts, note: step.note }, people },
    };
  }
  private async people(organizationId: string, signal: AbortSignal) {
    return (await this.deps.apollo.people(organizationId, signal)).filter(
      // Apollo's free people search omits organization_id (seen 2026-10-09); the search is already scoped to this
      // organization, so only a person who names a different organization is dropped.
      (person) => !person.organization_id || person.organization_id === organizationId,
    );
  }
  private parentClue(input: { runId: string; organization: ApolloOrganization; note: string }) {
    const { organization, runId, note } = input;
    return this.deps.runs.addClues(runId, [
      {
        signal: "apollo_parent",
        ownerName: organization.name ?? organization.id,
        ownerDomain: domainOf(organization.primary_domain ?? organization.website_url),
        ownerCompanyId: null,
        quote: note,
        url: organization.website_url ?? null,
        archiveKey: null,
      },
    ]);
  }
}
function verifiedTie(input: {
  step: Extract<ApolloStep, { action: "accept" }>;
  brand: ApolloBrandFacts;
  organization: ApolloOrganization;
}) {
  const { step, brand, organization } = input;
  if (step.tie !== "domain" && step.tie !== "former_domain") {
    return true;
  }
  const domains = (step.tie === "domain" ? brand.domains : brand.formerDomains).map(domainOf);
  return [domainOf(organization.primary_domain), domainOf(organization.website_url)].some(
    (domain) => !!domain && domains.includes(domain),
  );
}
