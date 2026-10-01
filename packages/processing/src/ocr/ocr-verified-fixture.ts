import { vi } from "vitest";
import { withPermitExecution, type PermitExecutionLedger } from "@crawl-automation/platform";
import { MemoryStore } from "../testing/memory-store.js";
import { ocrStepSetup, resigned, signal } from "../testing/ocr-fixture.js";
import { OcrApi } from "./ocr-api.js";
import { OcrApiSettingsSchema } from "./ocr-api-settings.js";
import { OcrHttpJobControl } from "./ocr-job-control.js";
import { OcrReceipt } from "./ocr-receipt.js";
import { OcrStep } from "./ocr-step.js";

export function jobStatus(state: string) {
  return {
    state,
    worker_pid: 42,
    started_at: "2026-10-01T09:42:00Z",
    finished_at: ["done", "failed", "cancelled"].includes(state) ? "2026-10-01T09:43:30Z" : null,
    cancel_requested: state === "cancelled",
  };
}

/** The real HTTP adapter, processing step and receipt with in-memory durable stores. */
export function verifiedFixture(options: { timeout?: boolean; legacy?: boolean } = {}) {
  const fixture = ocrStepSetup();
  const query = vi.fn(async () => Response.json(jobStatus("failed")));
  const cancel = vi.fn(async () => Response.json(jobStatus("running")));
  const fetch = vi.fn(async (request: Request) => {
    if (request.url.endsWith("/ocr")) {
      return failRequest(request, options.timeout === true);
    }
    return request.method === "GET" ? query() : cancel();
  });
  const settings = OcrApiSettingsSchema.parse({
    baseUrl: "https://ocr.example.test",
    provider: "test/1",
    jobControl: true,
    timeoutMs: 100,
    stopVerificationTimeoutMs: 100,
    stopVerificationPollMs: 10,
  });
  const control = new OcrHttpJobControl({ baseUrl: settings.baseUrl, fetch });
  const api = new OcrApi(settings, {
    fetch,
    jobControl: control,
    verifiedFailures: !options.legacy,
  });
  return { ...fixture, api, query, cancel, fetch, ...runningStep(fixture, api) };
}

function runningStep(fixture: ReturnType<typeof ocrStepSetup>, api: OcrApi) {
  const input = resigned(fixture.input, { configFingerprint: api.supported.configFingerprint });
  const step = new OcrStep({ ...fixture.deps, api });
  const receipt = new OcrReceipt({ ...fixture, local: new MemoryStore() });
  const owner = { permitId: "permit", workflowId: "workflow", runId: "run" };
  const ledger = {
    record: vi.fn<PermitExecutionLedger["record"]>().mockResolvedValue(undefined),
    prove: vi.fn<PermitExecutionLedger["prove"]>().mockResolvedValue(undefined),
  };
  const run = () => withPermitExecution({ owner, ledger }, () => step.run(input, signal()));
  return { input, step, receipt, ledger, run };
}

async function failRequest(request: Request, timeout: boolean): Promise<Response> {
  if (timeout) {
    return new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
  }
  throw new TypeError("connection closed");
}
