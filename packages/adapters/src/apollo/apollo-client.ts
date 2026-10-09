import { request, type Dispatcher } from "undici";
import type { Apollo, ApolloQuery } from "@crawl-automation/app";
import { defineErrors } from "@crawl-automation/platform";
import { ApolloOrganizationSchema, ApolloPersonSchema } from "@crawl-automation/v3-contracts";
import { z } from "zod";

export const apolloErrors = defineErrors({
  "APOLLO.REQUEST_FAILED": { category: "SOURCE", message: "Apollo refused or failed the call." },
  "APOLLO.UNEXPECTED_ANSWER": {
    category: "SOURCE",
    message: "Apollo answered with a shape the crawler does not know.",
  },
});

export const ApolloSettingsSchema = z.strictObject({
  apiKey: z.string().min(1),
  baseUrl: z.url().default("https://api.apollo.io/api/v1"),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type ApolloSettings = z.infer<typeof ApolloSettingsSchema>;

const Organizations = z.looseObject({
  organizations: z.array(ApolloOrganizationSchema).default([]),
  accounts: z.array(ApolloOrganizationSchema).default([]),
});
const People = z.looseObject({
  people: z.array(ApolloPersonSchema).default([]),
  contacts: z.array(ApolloPersonSchema).default([]),
});

/**
 * The Apollo calls Supply Smart's own import used (jakarta `import-brand-companies.ts`): organization search and the
 * free people search. The key stays on this server; Codex never sees it.
 */
export class ApolloClient implements Apollo {
  constructor(
    private readonly settings: ApolloSettings,
    private readonly dispatcher?: Dispatcher,
  ) {}

  async searchOrganizations(query: ApolloQuery, signal: AbortSignal) {
    const url = new URL(`${this.settings.baseUrl}/organizations/search`);
    if (query.by === "domain") {
      url.searchParams.append("q_organization_domains_list[]", query.domain);
    } else {
      url.searchParams.append("q_organization_name", query.name);
    }
    url.searchParams.append("per_page", "10");
    const answer = Organizations.safeParse(await this.post(url, signal));
    if (!answer.success) {
      throw apolloErrors.create("APOLLO.UNEXPECTED_ANSWER", {
        details: { call: "organizations/search", issues: answer.error.issues.slice(0, 5) },
      });
    }
    return [...answer.data.organizations, ...answer.data.accounts];
  }

  async people(organizationId: string, signal: AbortSignal) {
    const url = new URL(`${this.settings.baseUrl}/mixed_people/api_search`);
    url.searchParams.append("organization_ids[]", organizationId);
    url.searchParams.append("page", "1");
    url.searchParams.append("per_page", "100");
    const answer = People.safeParse(await this.post(url, signal));
    if (!answer.success) {
      throw apolloErrors.create("APOLLO.UNEXPECTED_ANSWER", {
        details: { call: "mixed_people/api_search", issues: answer.error.issues.slice(0, 5) },
      });
    }
    return [...answer.data.people, ...answer.data.contacts];
  }

  private async post(url: URL, signal: AbortSignal): Promise<unknown> {
    const response = await request(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "cache-control": "no-cache",
        "x-api-key": this.settings.apiKey,
      },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]),
      ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
    });
    const body: unknown = await response.body.json().catch(() => null);
    if (response.statusCode >= 400) {
      throw apolloErrors.create("APOLLO.REQUEST_FAILED", {
        details: { status: response.statusCode, path: url.pathname },
      });
    }
    return body;
  }
}
