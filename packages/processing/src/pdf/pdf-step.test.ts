import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../testing/memory-store.js";
import { decodeJson } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { fakePdfEngine, pdfStores, pdfTask, signal } from "../testing/pdf-fixture.js";
import { pdfFailure } from "./pdf-errors.js";
import { pdfAttemptKey, pdfCompletionKey } from "./pdf-input.js";
import { PdfStep } from "./pdf-step.js";

afterEach(() => vi.restoreAllMocks());

function stepSetup(
  module: "pdf.inspect" | "pdf.render" | "pdf.text" = "pdf.render",
  engineOptions = {},
) {
  const deps = pdfStores();
  const engine = fakePdfEngine(engineOptions);
  return { deps, engine, input: pdfTask(module), step: new PdfStep(deps, engine) };
}

function failWrites(store: MemoryStore, matches: (key: string) => boolean, stored = false) {
  const create = store.create.bind(store);
  const counter = { writes: 0 };
  vi.spyOn(store, "create").mockImplementation(async (key, bytes) => {
    if (!matches(key)) {
      return create(key, bytes);
    }
    counter.writes++;
    if (stored) {
      await create(key, bytes);
    }
    throw new Error("offline");
  });
  return counter;
}

// Cases carried over from the former PDF module (the engine is a stand-in here; the Python worker is unchanged).
describe("PDF step", () => {
  it.each(["pdf.inspect", "pdf.text", "pdf.render"] as const)(
    "%s publishes the output, then a node without the engine replays it",
    async (module) => {
      const setup = stepSetup(module);
      const result = await setup.step.run(setup.input, signal());
      expect(result.status).toBe("durable");
      const writes = setup.deps.remote.writes;
      const disabled = { run: vi.fn(async () => Promise.reject(new Error("must not execute"))) };
      const other = new PdfStep({ ...setup.deps, journal: new MemoryStore() }, disabled);
      expect(await other.run(setup.input, signal())).toEqual(result);
      expect(disabled.run).not.toHaveBeenCalled();
      expect(setup.deps.remote.writes).toBe(writes);
      const attempt = decodeJson(defined(setup.deps.journal.data.get(pdfAttemptKey(setup.input))));
      expect(attempt).toMatchObject({ input: setup.input, attemptId: "pdf-attempt1" });
      expect(setup.engine.runs).toBe(1);
    },
  );

  it("two deliveries of the same task run the engine once", async () => {
    const setup = stepSetup();
    const outcomes = await Promise.all([
      setup.step.run(setup.input, signal()),
      setup.step.run(setup.input, signal()),
    ]);
    expect(outcomes.some((outcome) => outcome.status === "durable")).toBe(true);
    expect(setup.engine.runs).toBe(1);
  });

  it("an unconfirmed intent never lets the engine run", async () => {
    const setup = stepSetup();
    setup.deps.remote.loseAcknowledgements = true;
    expect(await setup.step.run(setup.input, signal())).toMatchObject({
      status: "review",
      code: "PDF.INTENT_UNKNOWN",
    });
    expect(setup.engine.runs).toBe(0);
  });

  it("a lost completion acknowledgement is settled without another run", async () => {
    const setup = stepSetup();
    failWrites(setup.deps.remote, (key) => key === pdfCompletionKey(setup.input), true);
    expect(await setup.step.run(setup.input, signal())).toMatchObject({ status: "durable" });
    expect(setup.engine.runs).toBe(1);
  });

  it("a failed output upload keeps the candidate; redelivery neither renders nor uploads again", async () => {
    const setup = stepSetup();
    const uploads = failWrites(setup.deps.remote, (key) => key.endsWith("output.png"));
    expect(await setup.step.run(setup.input, signal())).toMatchObject({ status: "review" });
    const review = defined([...setup.deps.reviews.records.values()][0]);
    expect(review.candidate).not.toBeNull();
    expect(await setup.step.run(setup.input, signal())).toMatchObject({
      code: "PDF.EXECUTION_UNKNOWN",
    });
    expect([setup.engine.runs, uploads.writes]).toEqual([1, 1]);
  });

  it("an attempt that cannot be recorded stops before the engine works", async () => {
    const setup = stepSetup();
    failWrites(setup.deps.journal, (key) => key.startsWith("pdf-attempts/"));
    expect(await setup.step.run(setup.input, signal())).toMatchObject({ status: "review" });
    expect(setup.deps.remote.data.has(pdfCompletionKey(setup.input))).toBe(false);
  });

  it("an engine failure keeps its code, and redelivery never starts another attempt", async () => {
    const setup = stepSetup("pdf.render", { failure: pdfFailure("PDF.RESULT_INTEGRITY") });
    expect(await setup.step.run(setup.input, signal())).toMatchObject({
      code: "PDF.RESULT_INTEGRITY",
    });
    expect(await setup.step.run(setup.input, signal())).toMatchObject({
      code: "PDF.EXECUTION_UNKNOWN",
    });
    expect(setup.engine.runs).toBe(1);
  });

  it("a wrong engine setup, a damaged output or a damaged original is never accepted", async () => {
    const setup = stepSetup();
    await expect(
      setup.step.run({ ...setup.input, configFingerprint: "0".repeat(64) }, signal()),
    ).rejects.toMatchObject({
      code: "PDF.ENGINE_MISMATCH",
    });
    const result = await setup.step.run(setup.input, signal());
    if (result.status !== "durable") {
      throw new Error(JSON.stringify(result));
    }
    setup.deps.remote.data.set(result.artifact.objectKey, Buffer.from("corrupt"));
    expect(await setup.step.run(setup.input, signal())).toMatchObject({ status: "review" });
    setup.deps.remote.data.set(setup.input.pdf.objectKey, Buffer.from("bad source"));
    await expect(setup.step.inspect(setup.input, signal())).rejects.toThrow();
    expect(setup.engine.runs).toBe(1);
  });

  it("an unreachable Review ledger is never acknowledged; the local Review stays", async () => {
    const setup = stepSetup();
    setup.deps.reviews.unavailable = true;
    setup.deps.remote.loseAcknowledgements = true;
    await expect(setup.step.run(setup.input, signal())).rejects.toThrow();
    expect([...setup.deps.journal.data.keys()].some((key) => key.startsWith("pdf-reviews/"))).toBe(
      true,
    );
    expect(setup.engine.runs).toBe(0);
  });

  it("a completion naming another page, parent, operation or engine is refused", async () => {
    const setup = stepSetup();
    expect(await setup.step.run(setup.input, signal())).toMatchObject({ status: "durable" });
    const key = pdfCompletionKey(setup.input);
    const original = decodeJson(defined(setup.deps.remote.data.get(key))) as Record<
      string,
      Record<string, unknown>
    >;
    const { artifact = {}, manifest = {} } = original;
    const changes = [
      { ...original, artifact: { ...artifact, parentArtifactId: "foreign-pdf" } },
      { ...original, artifact: { ...artifact, pageIndex: 1 } },
      { ...original, manifest: { ...manifest, operationId: "foreign-operation" } },
      {
        ...original,
        manifest: {
          ...manifest,
          engine: { ...(manifest["engine"] as object), pdfium: "different" },
        },
      },
    ];
    for (const changed of changes) {
      setup.deps.remote.data.set(key, Buffer.from(JSON.stringify(changed)));
      await expect(setup.step.inspect(setup.input, signal())).rejects.toThrow();
    }
    expect(setup.engine.runs).toBe(1);
  });
});
