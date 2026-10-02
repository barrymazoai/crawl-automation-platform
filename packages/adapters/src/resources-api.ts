import { z } from "zod";
import { defineErrors } from "@crawl-automation/platform";

const errors = defineErrors({
  "PERMIT.SWEEP_API_FAILED": { category: "RUNTIME", message: "Permit stop sweep API failed." },
});
const answer = z.object({
  result: z.object({
    data: z.object({ results: z.array(z.unknown()), released: z.array(z.string()) }),
  }),
});

/** The resources process uses the same mutation as operators; no second repair path. */
export class ResourcesApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async verifyStops(signal: AbortSignal) {
    const response = await this.fetch(`${this.baseUrl.replace(/\/$/, "")}/resources.verifyStops`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
    });
    if (!response.ok) {
      throw errors.create("PERMIT.SWEEP_API_FAILED", { details: { status: response.status } });
    }
    return answer.parse(await response.json()).result.data;
  }
}
