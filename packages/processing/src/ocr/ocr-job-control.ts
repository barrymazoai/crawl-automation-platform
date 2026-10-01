import { z } from "zod";
import type { OcrJobControl } from "./ocr-api.js";

const jobIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const terminalStates = new Set(["done", "failed", "cancelled"]);
const jobStatus = z.object({
  state: z.enum(["unknown", "queued", "running", "done", "failed", "cancelled"]),
  worker_pid: z.number().int().positive().nullable(),
  started_at: z.string().datetime({ offset: true }).nullable(),
  finished_at: z.string().datetime({ offset: true }).nullable(),
  cancel_requested: z.boolean(),
});

export interface OcrHttpJobControlOptions {
  baseUrl: string;
  /** Use the same transport as OcrApi so routing and authentication match. */
  fetch?: (request: Request) => Promise<Response>;
}

/** Opt in only after every backend at this endpoint supports durable job IDs. */
export class OcrHttpJobControl implements OcrJobControl {
  private readonly baseUrl: string;
  private readonly fetch: (request: Request) => Promise<Response>;

  constructor(options: OcrHttpJobControlOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  requestHeaders(jobId: string): Record<string, string> {
    validateJobId(jobId);
    return { "x-ocr-job-id": jobId };
  }

  async query(jobId: string, signal: AbortSignal): ReturnType<OcrJobControl["query"]> {
    const status = await this.request(jobId, { method: "GET", signal });
    if (terminalStates.has(status.state)) {
      if (status.finished_at === null) {
        throw new Error("OCR terminal state has no completion timestamp");
      }
      return "stopped";
    }
    return status.state === "unknown" ? "unknown" : "running";
  }

  async cancel(jobId: string, signal: AbortSignal): Promise<void> {
    // Acceptance is deliberately not returned as stop proof. Query again.
    await this.request(jobId, { method: "POST", signal });
  }

  private async request(jobId: string, options: { method: "GET" | "POST"; signal: AbortSignal }) {
    validateJobId(jobId);
    options.signal.throwIfAborted();
    const suffix = options.method === "POST" ? "/cancel" : "";
    const request = new Request(`${this.baseUrl}/jobs/${encodeURIComponent(jobId)}${suffix}`, {
      ...options,
      headers: { accept: "application/json" },
      redirect: "error",
      cache: "no-store",
    });
    const response = await this.fetch(request);
    if (
      !response.ok ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    ) {
      throw new Error(`OCR job control returned an invalid response (HTTP ${response.status})`);
    }
    return jobStatus.parse(await response.json());
  }
}

function validateJobId(jobId: string): void {
  if (jobIdPattern.exec(jobId)?.[0] !== jobId) {
    throw new Error("Invalid OCR job ID");
  }
}
