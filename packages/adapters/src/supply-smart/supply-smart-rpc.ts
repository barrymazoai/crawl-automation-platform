import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
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
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.settings.timeoutMs)]);
    let answer: unknown;
    try {
      answer = await procedure(call.input, { signal: bounded });
    } catch (error) {
      if (error instanceof ORPCError) {
        throw supplySmartErrors.create("SUPPLY_SMART.REQUEST_FAILED", {
          cause: error,
          details: { path: call.path, status: error.status, code: error.code, data: error.data },
        });
      }
      throw error;
    }
    const parsed = call.answer.safeParse(answer);
    if (!parsed.success) {
      throw supplySmartErrors.create("SUPPLY_SMART.UNEXPECTED_ANSWER", {
        details: { path: call.path, issues: parsed.error.issues.slice(0, 10) },
      });
    }
    return parsed.data;
  }
}

/** The HTTP status Supply Smart answered, when the call failed with one. */
export function supplySmartStatus(error: unknown): number | undefined {
  const status = (error as { details?: { status?: unknown } } | null)?.details?.status;
  return typeof status === "number" ? status : undefined;
}
