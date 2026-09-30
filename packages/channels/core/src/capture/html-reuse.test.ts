import { artifactErrors, RetainedPublication, type ObjectStore } from "@crawl-automation/platform";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelAdapter, ChannelId, ParsedProduct } from "../adapter.js";
import { channelErrors } from "../errors.js";
import { HttpCapture } from "./http-capture.js";
import type { HtmlCaptureRecords } from "./html-capture-records.js";
import type { HtmlCapture, FetchedVia } from "./html-capture-model.js";
import { OriginalHtmlArchive } from "./original-html-archive.js";

class Memory implements ObjectStore {
  data = new Map<string, Uint8Array>();
  read = vi.fn(async (key: string) => this.data.get(key) ?? null);
  create = vi.fn(async (key: string, bytes: Uint8Array) => {
    if (this.data.has(key)) {
      return "exists" as const;
    }
    this.data.set(key, Buffer.from(bytes));
    return "created" as const;
  });
}

const body = Buffer.from("<html><body>original product</body></html>");
const via: FetchedVia = {
  mode: "http",
  routeId: "test-route",
  egressId: "test-egress",
  provider: "test-provider",
  creditCost: 5,
};
const signal = () => new AbortController().signal;
const hour = 60 * 60 * 1000;

function setup(channel: ChannelId = "gnc") {
  const remote = new Memory();
  const publication = new RetainedPublication(new Memory(), remote);
  const records = {
    admit: vi.fn<HtmlCaptureRecords["admit"]>().mockResolvedValue({ status: "download" }),
    complete: vi.fn<HtmlCaptureRecords["complete"]>().mockResolvedValue(undefined),
    fail: vi.fn<HtmlCaptureRecords["fail"]>().mockResolvedValue(undefined),
  };
  const fetchPage = vi.fn(async () => ({ bytes: body, fetchedVia: via }));
  const parseProduct = vi.fn(
    () => ({ identity: { listingId: "product", variantId: null } }) as ParsedProduct,
  );
  const adapter = {
    id: channel,
    captureModes: ["http"],
    httpPolicy: { origins: ["https://example.com"], maxBytes: 10000, timeoutMs: 5000 },
    parseProduct,
  } as unknown as ChannelAdapter;
  const archive = (operationId: string, overrides: Partial<HtmlCapture> = {}) =>
    new OriginalHtmlArchive(publication, {
      channel,
      maxBytes: 10000,
      capture: {
        operationId,
        sessionId: operationId,
        sourceId: "source",
        listingId: "product",
        variantId: null,
        url: "https://example.com/product",
        ...overrides,
      },
    });
  const http = new HttpCapture({ mode: "http", fetchPage }, records);
  const capture = (target: OriginalHtmlArchive) => http.capture(adapter, target, signal());
  return { remote, records, fetchPage, parseProduct, archive, capture };
}

afterEach(() => vi.useRealTimers());

describe("shared original HTML reuse", () => {
  it.each(["amazon", "gnc", "swanson", "dtc", "costco", "wholefoods"] as const)(
    "reuses a recent %s original across operations without any provider or archive writes",
    async (channel) => {
      vi.useFakeTimers();
      const test = setup(channel);
      const producer = test.archive("producer");
      const saved = await producer.save(body, via, signal());
      const original = producer.reference(saved);
      const receipt = test.remote.data.get(`${producer.prefix}/original.json`);
      vi.advanceTimersByTime(23 * hour);
      test.records.admit.mockResolvedValue({ status: "reuse", original });
      test.remote.create.mockClear();
      const result = await test.capture(
        test.archive("consumer", {
          sourceId: "another-source",
          url: "https://example.com/product?tracking=new",
        }),
      );
      expect(result).toMatchObject({
        status: "page",
        archiveKey: original.source.objectKey,
        archiveSha256: original.source.sha256,
        capturedAt: original.capturedAt,
      });
      expect(test.parseProduct).toHaveBeenCalledWith({
        url: producer.capture.url,
        html: body.toString(),
        capturedAt: original.capturedAt,
      });
      expect(test.remote.read).toHaveBeenCalledWith(
        original.source.objectKey,
        body.length,
        expect.anything(),
      );
      expect(test.remote.data.get(`${producer.prefix}/original.json`)).toEqual(receipt);
      expect(test.fetchPage).not.toHaveBeenCalled();
      expect(test.remote.create).not.toHaveBeenCalled();
      expect(test.records.complete).not.toHaveBeenCalled();
    },
  );

  it("downloads after admission finds no original inside 24 hours", async () => {
    vi.useFakeTimers();
    const test = setup();
    const producer = test.archive("expired");
    const old = await producer.save(body, via, signal());
    vi.advanceTimersByTime(24 * hour);
    const next = test.archive("new");
    const result = await test.capture(next);
    expect(result).toMatchObject({ status: "page", archiveKey: `${next.prefix}/original.html` });
    expect(test.fetchPage).toHaveBeenCalledOnce();
    expect(test.records.complete.mock.calls[0]?.[1].capturedAt).not.toBe(old.capturedAt);
    expect(test.records.admit.mock.invocationCallOrder[0]).toBeLessThan(
      test.fetchPage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(test.records.complete.mock.invocationCallOrder[0]).toBeLessThan(
      test.parseProduct.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("records failure once, refuses the same operation, and permits a new operation immediately", async () => {
    const test = setup();
    const failed = test.archive("failed");
    test.fetchPage.mockRejectedValueOnce(channelErrors.create("CAPTURE.ACCESS_CHALLENGE"));
    await expect(test.capture(failed)).rejects.toMatchObject({ code: "CAPTURE.ACCESS_CHALLENGE" });
    expect(test.records.fail).toHaveBeenCalledWith(
      { channel: "gnc", capture: failed.capture },
      "CAPTURE.ACCESS_CHALLENGE",
    );
    test.records.admit.mockResolvedValueOnce({ status: "unresolved" });
    await expect(test.capture(failed)).rejects.toMatchObject({
      code: "CAPTURE.DOWNLOAD_UNRESOLVED",
    });
    expect((await test.capture(test.archive("new-operation"))).status).toBe("page");
    expect(test.fetchPage).toHaveBeenCalledTimes(2);
  });

  it("blocks an in-flight capture with the registered code before request intent or payment", async () => {
    const test = setup();
    test.records.admit.mockResolvedValue({ status: "in_flight", operationId: "owner" });
    await expect(test.capture(test.archive("other"))).rejects.toMatchObject({
      code: "CAPTURE.IN_FLIGHT",
      details: { operationId: "owner" },
    });
    expect(test.fetchPage).not.toHaveBeenCalled();
    expect(test.remote.create).not.toHaveBeenCalled();
    expect(test.parseProduct).not.toHaveBeenCalled();
  });

  it.each(["hash", "missing", "timestamp", "variant", "channel"])(
    "stops on %s damage to a reusable original without a replacement download",
    async (damage) => {
      const test = setup();
      const producer = test.archive("producer");
      const original = producer.reference(await producer.save(body, via, signal()));
      if (damage === "hash") {
        test.remote.data.set(original.source.objectKey, Buffer.alloc(body.length, "x"));
      }
      if (damage === "missing") {
        test.remote.read.mockImplementation(async (key) =>
          key === original.source.objectKey ? null : (test.remote.data.get(key) ?? null),
        );
      }
      if (damage === "timestamp") {
        original.capturedAt = "2020-01-01T00:00:00.000Z";
      }
      if (damage === "variant") {
        original.capture.variantId = "different";
      }
      if (damage === "channel") {
        original.channel = "amazon";
      }
      test.records.admit.mockResolvedValue({ status: "reuse", original });
      const code =
        damage === "hash"
          ? "ARTIFACT.INTEGRITY"
          : damage === "missing"
            ? "CAPTURE.ARCHIVE_MISSING"
            : "CAPTURE.ARCHIVE_IDENTITY";
      await expect(test.capture(test.archive("consumer"))).rejects.toMatchObject({ code });
      expect(test.fetchPage).not.toHaveBeenCalled();
      expect(test.parseProduct).not.toHaveBeenCalled();
    },
  );

  it("retains the original and its done record when parsing fails", async () => {
    const test = setup();
    test.parseProduct.mockImplementation(() => {
      throw new Error("parse failure");
    });
    const target = test.archive("producer");
    await expect(test.capture(target)).rejects.toThrow("parse failure");
    expect(test.records.complete).toHaveBeenCalledOnce();
    expect(test.records.fail).not.toHaveBeenCalled();
    expect(await target.inspect(signal())).toMatchObject({ bytes: body });
  });

  it("does not fetch or parse when the admission ledger is unavailable", async () => {
    const test = setup();
    test.records.admit.mockRejectedValue(new Error("ledger unavailable"));
    await expect(test.capture(test.archive("producer"))).rejects.toThrow("ledger unavailable");
    expect(test.fetchPage).not.toHaveBeenCalled();
    expect(test.parseProduct).not.toHaveBeenCalled();
  });

  it("recovers a lost done-record response from verified original bytes without another download", async () => {
    const test = setup();
    test.records.complete.mockRejectedValueOnce(new Error("write unknown"));
    const target = test.archive("producer");
    await expect(test.capture(target)).rejects.toThrow("write unknown");
    expect(test.parseProduct).not.toHaveBeenCalled();
    expect((await test.capture(target)).status).toBe("page");
    expect(test.fetchPage).toHaveBeenCalledOnce();
    expect(test.records.complete).toHaveBeenCalledTimes(2);
  });

  it("recovers another operation's published original after its in-flight marker expires", async () => {
    const test = setup();
    const producer = test.archive("unfinished");
    const original = producer.reference(await producer.save(body, via, signal()));
    const previous = { channel: "gnc" as const, capture: producer.capture };
    test.records.admit.mockResolvedValue({ status: "download", previous: [previous] });
    const consumer = test.archive("new-operation");
    expect(await test.capture(consumer)).toMatchObject({
      status: "page",
      archiveKey: original.source.objectKey,
      capturedAt: original.capturedAt,
    });
    expect(test.records.complete.mock.calls).toEqual([
      [previous, original],
      [{ channel: "gnc", capture: consumer.capture }, original],
    ]);
    expect(test.fetchPage).not.toHaveBeenCalled();
  });

  it.each(["missing", "expired"])(
    "downloads when an unfinished operation's original is %s",
    async (state) => {
      vi.useFakeTimers();
      const test = setup();
      const producer = test.archive("unfinished");
      if (state === "expired") {
        await producer.save(body, via, signal());
        vi.advanceTimersByTime(24 * hour);
      }
      test.records.admit.mockResolvedValue({
        status: "download",
        previous: [{ channel: "gnc", capture: producer.capture }],
      });
      expect(await test.capture(test.archive("new-operation"))).toMatchObject({
        status: "page",
        archiveKey: "v3/gnc-html/new-operation/original.html",
      });
      expect(test.fetchPage).toHaveBeenCalledOnce();
    },
  );

  it("stops if an unfinished operation's original cannot be verified", async () => {
    const test = setup();
    const producer = test.archive("unfinished");
    const saved = await producer.save(body, via, signal());
    test.remote.data.set(saved.source.objectKey, Buffer.alloc(body.length, "x"));
    test.records.admit.mockResolvedValue({
      status: "download",
      previous: [{ channel: "gnc", capture: producer.capture }],
    });
    await expect(test.capture(test.archive("new-operation"))).rejects.toMatchObject({
      code: "ARTIFACT.INTEGRITY",
    });
    expect(test.fetchPage).not.toHaveBeenCalled();
    expect(test.records.complete).not.toHaveBeenCalled();
    expect(test.records.fail).toHaveBeenCalledExactlyOnceWith(
      { channel: "gnc", capture: test.archive("new-operation").capture },
      "ARTIFACT.INTEGRITY",
    );
  });

  it("marks unknown publication failed and never repeats its paid request", async () => {
    const test = setup();
    test.remote.read.mockImplementation(async (key) =>
      key.endsWith("original.html") ? null : (test.remote.data.get(key) ?? null),
    );
    const target = test.archive("producer");
    await expect(test.capture(target)).rejects.toMatchObject({ code: "ARTIFACT.UPLOAD_UNKNOWN" });
    test.records.admit.mockResolvedValueOnce({ status: "unresolved" });
    await expect(test.capture(target)).rejects.toMatchObject({
      code: "CAPTURE.DOWNLOAD_UNRESOLVED",
    });
    expect(test.fetchPage).toHaveBeenCalledOnce();
    expect(test.records.complete).not.toHaveBeenCalled();
    expect(test.records.fail).toHaveBeenCalledExactlyOnceWith(
      { channel: "gnc", capture: target.capture },
      "ARTIFACT.UPLOAD_UNKNOWN",
    );
    expect(test.parseProduct).not.toHaveBeenCalled();
  });

  it.each(["intent", "publication", "read-back", "completion"])(
    "ends the in-flight Swanson record on ARTIFACT.UNAVAILABLE during %s",
    async (phase) => {
      const test = setup("swanson");
      const target = test.archive("producer");
      const row = { state: "absent", causeCode: null as string | null };
      const failure = artifactErrors.create("ARTIFACT.UNAVAILABLE");
      test.records.admit.mockImplementation(async () => {
        row.state = "in_flight";
        return { status: "download" };
      });
      test.records.fail.mockImplementation(async (_request, code) => {
        expect(row.state).toBe("in_flight");
        row.state = "failed";
        row.causeCode = code;
      });
      if (phase === "intent") {
        vi.spyOn(target, "beginDownload").mockRejectedValue(failure);
      }
      if (phase === "publication") {
        vi.spyOn(target, "save").mockRejectedValue(failure);
      }
      if (phase === "completion") {
        test.records.complete.mockRejectedValue(failure);
      }
      if (phase === "read-back") {
        test.remote.read.mockImplementation(async (key) => {
          if (key.endsWith("original.html") && test.remote.data.has(key)) {
            throw failure;
          }
          return test.remote.data.get(key) ?? null;
        });
      }
      await expect(test.capture(target)).rejects.toBe(failure);
      expect(row).toEqual({ state: "failed", causeCode: "ARTIFACT.UNAVAILABLE" });
      expect(test.records.fail).toHaveBeenCalledExactlyOnceWith(
        { channel: "swanson", capture: target.capture },
        "ARTIFACT.UNAVAILABLE",
      );
      expect(test.fetchPage).toHaveBeenCalledTimes(phase === "intent" ? 0 : 1);
      expect(test.parseProduct).not.toHaveBeenCalled();
    },
  );

  it("retains a not-found sighting after ending its reservation as failed", async () => {
    const test = setup();
    test.fetchPage.mockRejectedValue(channelErrors.create("CAPTURE.NOT_FOUND"));
    expect(await test.capture(test.archive("gone"))).toMatchObject({ status: "sighting" });
    expect(test.records.fail).toHaveBeenCalledExactlyOnceWith(
      { channel: "gnc", capture: test.archive("gone").capture },
      "CAPTURE.NOT_FOUND",
    );
    expect(test.records.complete).not.toHaveBeenCalled();
  });
});
