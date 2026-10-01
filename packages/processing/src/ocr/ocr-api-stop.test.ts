import { afterEach, describe, expect, it, vi } from "vitest";
import {
  withPermitExecution,
  type PermitExecutionIdentity,
  type PermitExecutionLedger,
} from "@crawl-automation/platform";
import { PNG, ocrTask, signal } from "../testing/ocr-fixture.js";
import { OcrApi, type OcrJobControl } from "./ocr-api.js";
import { OcrApiSettingsSchema, type OcrApiSettings } from "./ocr-api-settings.js";

const endpoint = "https://ocr.example.test";
const owner = { permitId: "ocr-permit", workflowId: "ocr-workflow", runId: "ocr-run" };

function setup(control?: OcrJobControl, overrides: Partial<OcrApiSettings> = {}) {
  const executions = new Map<string, PermitExecutionIdentity>();
  const record = vi.fn<PermitExecutionLedger["record"]>(async (_owner, identity) => {
    executions.set(identity.executionId, identity);
  });
  const prove = vi.fn<PermitExecutionLedger["prove"]>(async (_owner, identity) => {
    executions.delete(identity.executionId);
  });
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  const settings = OcrApiSettingsSchema.parse({
    baseUrl: endpoint,
    provider: "test/1",
    ...overrides,
  });
  const client = new OcrApi(settings, { fetch, ...(control ? { jobControl: control } : {}) });
  const run = (abort = signal()) =>
    withPermitExecution({ owner, ledger: { record, prove } }, () =>
      client.recognize(ocrTask().file, PNG, abort),
    );
  return { client, run, record, prove, fetch, executions };
}

function jobControl() {
  return {
    requestHeaders: vi.fn((jobId: string) => ({ "x-ocr-job-id": jobId })),
    query: vi.fn<OcrJobControl["query"]>(),
    cancel: vi.fn<OcrJobControl["cancel"]>().mockResolvedValue(undefined),
  };
}

function fakeDeadline() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("timed out", "TimeoutError")), duration);
    return controller.signal;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("OCR execution stop proof", () => {
  it("persists the task-owned job before sending it and proves a synchronous completion", async () => {
    const control = jobControl();
    const fixture = setup(control);
    fixture.fetch.mockImplementation(async (request) => {
      const jobId = request.headers.get("x-ocr-job-id");
      expect(jobId).toBeTruthy();
      expect([...fixture.executions.keys()]).toEqual([jobId]);
      return Response.json({ text: "Vitamin C", lines: [] });
    });
    await expect(fixture.run()).resolves.toMatchObject({ text: "Vitamin C" });
    expect(fixture.prove).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ kind: "ocr", endpoint }),
      expect.objectContaining({ kind: "ocr-synchronous-response", observedAt: expect.any(String) }),
    );
    expect(fixture.executions.size).toBe(0);
    expect(control.query).not.toHaveBeenCalled();
  });

  it("keeps an unknown outcome unproved when the deployed provider has no job control", async () => {
    const fixture = setup();
    fixture.fetch.mockRejectedValue(new TypeError("connection closed"));
    await expect(fixture.run()).rejects.toMatchObject({
      code: "OCR.RESPONSE_UNKNOWN",
      details: {
        executionFact: "unknown",
        cleanup: { stopped: false, attempts: 0, reason: "job_control_unavailable" },
      },
    });
    expect(fixture.executions.size).toBe(1);
    expect(fixture.prove).not.toHaveBeenCalled();
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.record).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({ metadata: { jobControlSupported: false } }),
    );
  });

  it("keeps the execution unproved until an exact-job terminal query follows cancellation", async () => {
    const control = jobControl();
    let confirmStopped: ((state: "stopped") => void) | undefined;
    control.query.mockResolvedValueOnce("running").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirmStopped = resolve;
        }),
    );
    const fixture = setup(control);
    const abort = new AbortController();
    fixture.fetch.mockImplementation(async () => {
      abort.abort();
      throw abort.signal.reason;
    });
    const outcome = fixture.run(abort.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(control.query).toHaveBeenCalledTimes(2));
    expect(fixture.executions.size).toBe(1);
    expect(fixture.prove).not.toHaveBeenCalled();
    const [identity] = fixture.executions.values();
    expect(control.cancel).toHaveBeenCalledWith(identity?.executionId, expect.any(AbortSignal));
    expect(control.query.mock.calls.every((call) => !call[1].aborted)).toBe(true);
    confirmStopped?.("stopped");
    expect(await outcome).toMatchObject({
      code: "OCR.CANCELLED",
      details: { executionFact: "unknown", cleanup: { stopped: true, attempts: 2 } },
    });
    expect(fixture.executions.size).toBe(0);
    expect(fixture.prove).toHaveBeenCalledWith(
      owner,
      identity,
      expect.objectContaining({ kind: "ocr-job-stopped", attempts: 2 }),
    );
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "unknown"] as const)(
    "bounds %s verification without accepting a cancel receipt",
    async (state) => {
      fakeDeadline();
      const control = jobControl();
      control.query.mockResolvedValue(state);
      const fixture = setup(control);
      fixture.fetch.mockRejectedValue(new TypeError("connection closed"));
      const outcome = fixture.run().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(await outcome).toMatchObject({
        details: {
          cleanup: { stopped: false, attempts: 121, reason: "job_control_failed" },
        },
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(control.query).toHaveBeenCalledTimes(121);
      expect(control.cancel).toHaveBeenCalledTimes(1);
      expect(fixture.prove).not.toHaveBeenCalled();
      expect(fixture.executions.size).toBe(1);
    },
  );

  it("observes a terminal job after the 90 s hard limit using the fresh cleanup signal", async () => {
    fakeDeadline();
    const control = jobControl();
    const started = Date.now();
    control.query.mockImplementation(async () =>
      Date.now() - started >= 95_000 ? "stopped" : "running",
    );
    const fixture = setup(control);
    const abort = new AbortController();
    fixture.fetch.mockImplementation(async () => {
      abort.abort();
      throw abort.signal.reason;
    });
    const outcome = fixture.run(abort.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(fixture.prove).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await outcome).toMatchObject({
      code: "OCR.CANCELLED",
      details: { cleanup: { stopped: true } },
    });
    expect(fixture.executions.size).toBe(0);
    expect(control.query.mock.calls.every((call) => !call[1].aborted)).toBe(true);
    expect(control.cancel).toHaveBeenCalledTimes(1);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses the configured total verification deadline and poll interval", async () => {
    fakeDeadline();
    const control = jobControl();
    control.query.mockResolvedValue("running");
    const fixture = setup(control, {
      stopVerificationTimeoutMs: 2_000,
      stopVerificationPollMs: 250,
    });
    fixture.fetch.mockRejectedValue(new TypeError("connection closed"));
    const outcome = fixture.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await outcome).toMatchObject({ details: { cleanup: { stopped: false, attempts: 9 } } });
    expect(control.query).toHaveBeenCalledTimes(9);
    expect(fixture.prove).not.toHaveBeenCalled();
  });

  it("bounds a control adapter that never answers or honors its abort signal", async () => {
    fakeDeadline();
    const control = jobControl();
    control.query.mockImplementation(() => new Promise(() => {}));
    const fixture = setup(control);
    fixture.fetch.mockRejectedValue(new TypeError("connection closed"));
    const outcome = fixture.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await outcome).toMatchObject({
      details: {
        cleanup: {
          stopped: false,
          attempts: 1,
          reason: "job_control_failed",
          cause: "TimeoutError: timed out",
        },
      },
    });
    expect(fixture.executions.size).toBe(1);
    expect(fixture.prove).not.toHaveBeenCalled();
  });

  it("keeps the permit execution unproved when job cancellation fails", async () => {
    const control = jobControl();
    control.query.mockResolvedValue("running");
    control.cancel.mockRejectedValue(new TypeError("control disconnected"));
    const fixture = setup(control);
    fixture.fetch.mockRejectedValue(new TypeError("connection closed"));
    await expect(fixture.run()).rejects.toMatchObject({
      details: {
        cleanup: {
          stopped: false,
          reason: "job_control_failed",
          cause: "TypeError: control disconnected",
        },
      },
    });
    expect(fixture.prove).not.toHaveBeenCalled();
    expect(control.query).toHaveBeenCalledTimes(1);
  });

  it("does not submit OCR when its execution identity cannot be made durable", async () => {
    const fixture = setup();
    const failure = new Error("journal unavailable");
    fixture.record.mockRejectedValue(failure);
    await expect(fixture.run()).rejects.toBe(failure);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("does not create execution or submit an already cancelled call", async () => {
    const fixture = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(fixture.run(abort.signal)).rejects.toMatchObject({
      code: "OCR.CANCELLED",
      details: { executionFact: "not_executed" },
    });
    expect(fixture.record).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("does not treat an old unbound correlation ID as a controllable provider job", async () => {
    const control = jobControl();
    const fixture = setup(control);
    await expect(
      fixture.client.stopAndVerify({
        kind: "ocr",
        executionId: "client-correlation-only",
        endpoint,
        metadata: { jobControlSupported: false },
      }),
    ).resolves.toMatchObject({ stopped: false, attempts: 0, reason: "job_control_unavailable" });
    expect(control.query).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  });

  it("refuses to operate on a stored job belonging to another endpoint", async () => {
    const control = jobControl();
    const fixture = setup(control);
    await expect(
      fixture.client.stopAndVerify({
        kind: "ocr",
        executionId: "other-job",
        endpoint: "https://other.example.test",
      }),
    ).resolves.toMatchObject({ stopped: false, attempts: 0 });
    expect(control.query).not.toHaveBeenCalled();
    expect(control.cancel).not.toHaveBeenCalled();
  });
});
