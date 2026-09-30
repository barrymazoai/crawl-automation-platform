import type { AppRouter } from "@crawl-automation/api";
import { createTRPCClient, httpLink } from "@trpc/client";

export type ApiClient = ReturnType<typeof createTRPCClient<AppRouter>>;

/** A typed client of the collection API. No login: the API is private to its machine. */
export function createApiClient(apiUrl: string): ApiClient {
  return createTRPCClient<AppRouter>({ links: [httpLink({ url: `${apiUrl}/trpc` })] });
}
