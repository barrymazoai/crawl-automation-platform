import { describe, expect, it, vi } from "vitest";
import { OcrHttpJobControl } from "./ocr-job-control.js";

const baseUrl = "https://ocr.example.test/prefix/";
const jobId = "7f9a0580-b6f4-426d-b404-32302ee6f282";
const timestamp = "2026-10-01T08:00:00+00:00";

function status(state: string) {
  return {
    state,
    worker_pid: state === "unknown" ? null : 123,
    started_at: ["unknown", "queued", "cancelled"].includes(state) ? null : timestamp,
    finished_at: ["done", "failed", "cancelled"].includes(state) ? timestamp : null,
    cancel_requested: state === "cancelled",
  };
}

function setup(state = "running") {
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  fetch.mockResolvedValue(Response.json(status(state)));
  return { fetch, control: new OcrHttpJobControl({ baseUrl, fetch }) };
}

describe("OCR HTTP job control", () => {
  it("supplies the exact job ID as the OCR transport header", () => {
    expect(setup().control.requestHeaders(jobId)).toEqual({ "x-ocr-job-id": jobId });
  });

  it.each(["unknown", "queued", "running", "done", "failed", "cancelled"])(
    "maps %s conservatively",
    async (state) => {
      const { fetch, control } = setup(state);
      const signal = new AbortController().signal;
      const expected = ["done", "failed", "cancelled"].includes(state)
        ? "stopped"
        : state === "unknown"
          ? "unknown"
          : "running";
      await expect(control.query(jobId, signal)).resolves.toBe(expected);
      const request = fetch.mock.calls[0]?.[0];
      expect(request?.url).toBe(`${baseUrl}jobs/${jobId}`);
      expect(request?.method).toBe("GET");
      expect(request?.redirect).toBe("error");
      expect(request?.cache).toBe("no-store");
    },
  );

  it("never turns a running cancellation receipt into stop proof", async () => {
    const { fetch, control } = setup();
    fetch.mockResolvedValueOnce(Response.json({ ...status("running"), cancel_requested: true }));
    const signal = new AbortController().signal;
    await expect(control.cancel(jobId, signal)).resolves.toBeUndefined();
    expect(fetch.mock.calls[0]?.[0].method).toBe("POST");
    expect(fetch.mock.calls[0]?.[0].url).toBe(`${baseUrl}jobs/${jobId}/cancel`);
    await expect(control.query(jobId, signal)).resolves.toBe("running");
  });

  it("proves a pre-start tombstone only through a later query", async () => {
    const { fetch, control } = setup("cancelled");
    const signal = new AbortController().signal;
    await expect(control.cancel(jobId, signal)).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(Response.json({ ...status("cancelled"), worker_pid: null }));
    await expect(control.query(jobId, signal)).resolves.toBe("stopped");
  });

  it.each(["", "../escape", "a/b", "bad id", "a\n", "x".repeat(129)])(
    "rejects invalid ID %j",
    async (invalid) => {
      const { fetch, control } = setup();
      expect(() => control.requestHeaders(invalid)).toThrow("Invalid OCR job ID");
      await expect(control.query(invalid, new AbortController().signal)).rejects.toThrow();
      await expect(control.cancel(invalid, new AbortController().signal)).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([404, 409, 500, 503])("does not accept HTTP %i as stop proof", async (code) => {
    const { fetch, control } = setup();
    fetch.mockResolvedValue(Response.json(status("failed"), { status: code }));
    await expect(control.query(jobId, new AbortController().signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { state: "done" },
    status("cancel_requested"),
    { ...status("done"), finished_at: null },
    { ...status("done"), finished_at: "invalid" },
  ])("rejects malformed or incomplete receipts", async (body) => {
    const { fetch, control } = setup();
    fetch.mockResolvedValue(Response.json(body));
    await expect(control.query(jobId, new AbortController().signal)).rejects.toThrow();
  });

  it("rejects non-JSON and malformed JSON responses", async () => {
    const { fetch, control } = setup();
    fetch.mockResolvedValueOnce(new Response("done"));
    fetch.mockResolvedValueOnce(
      new Response("{", { headers: { "content-type": "application/json" } }),
    );
    await expect(control.query(jobId, new AbortController().signal)).rejects.toThrow();
    await expect(control.query(jobId, new AbortController().signal)).rejects.toThrow();
  });

  it("propagates transport failures without retrying", async () => {
    const { fetch, control } = setup();
    fetch.mockRejectedValue(new TypeError("connection closed"));
    await expect(control.cancel(jobId, new AbortController().signal)).rejects.toThrow(
      "connection closed",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not send an already-aborted operation", async () => {
    const { fetch, control } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(control.query(jobId, abort.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("passes later cancellation through to the shared HTTP transport", async () => {
    const { fetch, control } = setup();
    const abort = new AbortController();
    fetch.mockImplementation(async (request) => {
      abort.abort();
      request.signal.throwIfAborted();
      return Response.json(status("done"));
    });
    await expect(control.query(jobId, abort.signal)).rejects.toThrow();
    expect(fetch.mock.calls[0]?.[0].signal.aborted).toBe(true);
  });
});
