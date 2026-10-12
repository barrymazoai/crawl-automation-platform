import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { setTimeout as delay } from "node:timers/promises";
import pRetry, { AbortError } from "p-retry";
import pThrottle from "p-throttle";
import { defineErrors } from "@crawl-automation/platform";
import { z } from "zod";

export const supplySmartErrors = defineErrors({
  "SUPPLY_SMART.REQUEST_FAILED": {
    category: "INGEST",
    message: "Supply Smart refused or failed the call.",
  },
  "SUPPLY_SMART.UNEXPECTED_ANSWER": {
    category: "INGEST",
    message: "Supply Smart answered with a shape the crawler does not know.",
  },
});

export const SupplySmartSettingsSchema = z.strictObject({
  /** Biz API oRPC root, e.g. `https://host/api/rpc` (test server: `http://192.168.0.34:8001/rpc`). */
  bizRpcUrl: z.url(),
  /** Product database gateway oRPC root, e.g. `https://host/api/database/rpc`. */
  databaseRpcUrl: z.url(),
  /** Service API key from the admin app; sent as `x-api-key`. Private config only, never git. */
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /**
   * Calls per minute from this client. Supply Smart limits each service key (test key: 600 per 60 s since
   * 2026-10-12) and the gateway quota defaults to 600/min; brand enrichment shares the key, so stay below.
   */
  requestsPerMinute: z.number().int().min(1).max(600).default(300),
  /** Retries after a 429 (rate limited); other failures are never retried. */
  rateLimitRetries: z.number().int().min(0).max(10).default(6),
  /**
   * After a 429 every call of this client waits this long. The key limit (better-auth api-key `isRateLimited`,
   * jakarta better-auth 1.3.32) keeps counting until a whole window (60 s) passes with no accepted call, so a
   * shorter wait is refused again (smoke 2026-10-12: 5 s…60 s backoff gave up mid-batch). A window plus margin.
   */
  rateLimitBackoffMs: z.number().int().min(1).max(300_000).default(65_000),
});
export type SupplySmartSettings = z.infer<typeof SupplySmartSettingsSchema>;

type Procedure = (input: unknown, options: { signal: AbortSignal }) => Promise<unknown>;
/** The oRPC client proxy: any `router.procedure` path is callable. */
type Client = Record<string, Record<string, Procedure>>;

/** `router.procedure` on one of the two Supply Smart APIs. */
export interface SupplySmartCall<Schema extends z.ZodType> {
  api: "biz" | "database";
  path: `${string}.${string}`;
  input: unknown;
  answer: Schema;
}

/**
 * Supply Smart's oRPC API (`{"json": …}` protocol) through `@orpc/client` with a service key: the biz API for brand
 * requests, the product database gateway for companies and contacts. Every answer is checked against its schema.
 */
export class SupplySmartRpc {
  private readonly clients: Record<"biz" | "database", Client>;
  /** Smooth pacing: a share of the per-minute allowance every second, so a long run never bursts into a 429. */
  private readonly paced: <T>(run: () => Promise<T>) => Promise<T>;
  /** No call starts before this time (epoch ms): set by a 429, shared by every caller of this client. */
  private resumeAt = 0;

  constructor(
    private readonly settings: SupplySmartSettings,
    fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {
    const client = (url: string) =>
      createORPCClient(
        new RPCLink({
          url,
          headers: { "x-api-key": settings.apiKey },
          fetch: (request: Request, init: RequestInit) => fetch(request, init),
        }),
      ) as unknown as Client;
    this.clients = { biz: client(settings.bizRpcUrl), database: client(settings.databaseRpcUrl) };
    const throttle = pThrottle({
      limit: Math.max(1, Math.floor((settings.requestsPerMinute ?? 300) / 60)),
      interval: 1_000,
    });
    this.paced = throttle(<T>(run: () => Promise<T>) => run()) as <T>(
      run: () => Promise<T>,
    ) => Promise<T>;
  }

  async call<Schema extends z.ZodType>(
    call: SupplySmartCall<Schema>,
    signal: AbortSignal,
  ): Promise<z.infer<Schema>> {
    const [router, name] = call.path.split(".") as [string, string];
    // The proxy answers every path; a wrong name fails only when Supply Smart answers 404.
    const procedure = (this.clients[call.api][router] as Record<string, Procedure>)[
      name
    ] as Procedure;
    const answer = await pRetry(
      async () => {
        await this.held(signal);
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]);
        try {
          return await this.paced(() => procedure(call.input, { signal: bounded }));
        } catch (error) {
          const failure = requestFailure(call.path, error);
          // Only a rate limit is safe and useful to repeat: the call was refused before Supply Smart did anything.
          if (supplySmartStatus(failure) !== 429) {
            throw new AbortError(failure);
          }
          this.resumeAt = Math.max(
            this.resumeAt,
            Date.now() + (this.settings.rateLimitBackoffMs ?? 65_000),
          );
          throw failure;
        }
      },
      // The shared hold above is the wait; p-retry only counts attempts.
      { retries: this.settings.rateLimitRetries ?? 6, minTimeout: 0, maxTimeout: 0, signal },
    );
    const parsed = call.answer.safeParse(answer);
    if (!parsed.success) {
      throw supplySmartErrors.create("SUPPLY_SMART.UNEXPECTED_ANSWER", {
        details: { path: call.path, issues: parsed.error.issues.slice(0, 10) },
      });
    }
    return parsed.data;
  }

  private async held(signal: AbortSignal) {
    const wait = this.resumeAt - Date.now();
    if (wait > 0) {
      await delay(wait, undefined, { signal });
    }
  }
}

function requestFailure(path: string, error: unknown): Error {
  if (error instanceof ORPCError) {
    return supplySmartErrors.create("SUPPLY_SMART.REQUEST_FAILED", {
      cause: error,
      details: { path, status: error.status, code: error.code, data: error.data },
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** The HTTP status Supply Smart answered, when the call failed with one. */
export function supplySmartStatus(error: unknown): number | undefined {
  const status = (error as { details?: { status?: unknown } } | null)?.details?.status;
  return typeof status === "number" ? status : undefined;
}
