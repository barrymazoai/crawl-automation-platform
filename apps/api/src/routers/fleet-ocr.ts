import { fleetIssue, type OcrHealth } from "@crawl-automation/app";
import type { OcrApiSettings } from "@crawl-automation/processing";
import { z } from "zod";

const healthSchema = z.looseObject({
  status: z.string(),
  healthy_backends: z.number().int().nonnegative(),
  total_backends: z.number().int().positive(),
});

/** A read-only GET using the workers' validated OCR address and timeout, without an OCR operation. */
export class FleetOcrHealth {
  constructor(
    private readonly settings: OcrApiSettings | undefined,
    private readonly transport: typeof fetch = fetch,
  ) {}

  async health(): Promise<OcrHealth> {
    const result: OcrHealth = {
      configured: this.settings !== undefined,
      healthy: false,
      statusCode: null,
      body: null,
      error: null,
    };
    if (!this.settings) {
      return result;
    }
    try {
      const url = `${this.settings.baseUrl.replace(/\/$/, "")}/health`;
      const response = await this.transport(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(this.settings.timeoutMs, 5_000)),
        redirect: "error",
      });
      result.statusCode = response.status;
      result.body = z.record(z.string(), z.unknown()).parse(await response.json());
      const body = healthSchema.parse(result.body);
      result.healthy =
        response.ok && body.status === "ok" && body.healthy_backends === body.total_backends;
    } catch (error) {
      result.error = fleetIssue(error);
    }
    return result;
  }
}
