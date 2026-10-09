import {
  ApolloStepSchema,
  type ApolloBrandFacts,
  type ApolloOrganization,
  type ApolloTie,
} from "@crawl-automation/v3-contracts";
import { checkedAnswer } from "./answer.js";
import { invalidAnswer } from "./errors.js";
import { domainOf, linkedinOf, sameText } from "./identity.js";
import type { ApolloInput, ApolloQuery } from "./inputs.js";

export function checkApolloAnswer(raw: unknown, input: ApolloInput) {
  const answer = checkedAnswer(ApolloStepSchema, raw, "apollo");
  if (answer.action === "search") {
    checkSearch(answer.query, input);
  }
  if (answer.action === "accept" || answer.action === "parent_only") {
    const organizations = input.rounds
      .flatMap((round) => round.organizations)
      .filter((organization) => organization.id === answer.organizationId);
    if (!organizations.length) {
      invalidAnswer("apollo", "organization_not_returned");
    }
    if (
      answer.action === "accept" &&
      !organizations.some((organization) =>
        hardTie({ brand: input.brand, organization, tie: answer.tie }),
      )
    ) {
      invalidAnswer("apollo", "hard_tie_missing");
    }
  }
  return answer;
}

function checkSearch(query: ApolloQuery, input: ApolloInput) {
  const allowed =
    query.by === "domain"
      ? [...input.brand.domains, ...input.brand.formerDomains].some(
          (domain) => domainOf(domain) && domainOf(domain) === domainOf(query.domain),
        )
      : [input.brand.name, input.brand.legalName].some((name) => sameText(name, query.name));
  const repeated = input.rounds.some(({ query: previous }) => sameQuery(previous, query));
  if (input.searchesLeft <= 0 || !allowed || repeated) {
    invalidAnswer("apollo", "unsupported_or_exhausted_search");
  }
}

function sameQuery(left: ApolloQuery, right: ApolloQuery) {
  if (left.by === "domain" && right.by === "domain") {
    return domainOf(left.domain) === domainOf(right.domain);
  }
  return left.by === "name" && right.by === "name" && sameText(left.name, right.name);
}

function hardTie(input: {
  brand: ApolloBrandFacts;
  organization: ApolloOrganization;
  tie: ApolloTie;
}): boolean {
  const { brand, organization, tie } = input;
  if (tie === "domain" || tie === "former_domain") {
    const expected = tie === "domain" ? brand.domains : brand.formerDomains;
    return [organization.primary_domain, organization.website_url].some(
      (value) =>
        value && domainOf(value) && expected.some((domain) => domainOf(domain) === domainOf(value)),
    );
  }
  if (tie === "linkedin") {
    return Boolean(
      brand.linkedinUrl &&
      organization.linkedin_url &&
      linkedinOf(brand.linkedinUrl) &&
      linkedinOf(brand.linkedinUrl) === linkedinOf(organization.linkedin_url),
    );
  }
  // City/state alone is never a street-address tie. Missing raw_address must remain unresolved.
  return (
    sameText(brand.legalName, organization.name) &&
    sameText(brand.address, organization.raw_address)
  );
}
