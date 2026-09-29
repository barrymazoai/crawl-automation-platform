import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/v3-artifacts";
import {
  PdfTextPrepareOutcomeSchema,
  TextDocumentSchema,
  parseTextInput,
} from "@crawl-automation/v3-contracts";
import { decodeJson, hashString } from "../results/result-record.js";
import { MemoryStore } from "../testing/memory-store.js";
import { defined } from "../testing/defined.js";
import { fakePdfEngine, pdfStores, pdfTask, pdfTextPlan, signal } from "../testing/pdf-fixture.js";
import { PdfEvidence } from "./pdf-evidence.js";
import { pdfCompletionKey } from "./pdf-input.js";
import { PdfStep } from "./pdf-step.js";
import { PdfTextEvidence, PdfTextPreparation, pdfTextInputKey } from "./pdf-text.js";

afterEach(() => vi.restoreAllMocks());

function textSetup(text?: string) {
  const deps = pdfStores();
  const engine = fakePdfEngine(text === undefined ? {} : { text });
  const plan = pdfTextPlan(pdfTask("pdf.text", "extract", 1));
  return {
    deps,
    engine,
    plan,
    step: new PdfStep(deps, engine),
    preparation: new PdfTextPreparation(deps),
  };
}

const replacement = (setup: ReturnType<typeof textSetup>) =>
  new PdfTextPreparation({ ...setup.deps, journal: new MemoryStore() });
const inspector = (setup: ReturnType<typeof textSetup>) =>
  new PdfTextEvidence(setup.deps.remote, new PdfEvidence(setup.deps));

// Cases carried over from the former PDF text preparation.
describe("PDF text", () => {
  it("turns a page's text into a full-range document with its PDF and page; reuse is read-only", async () => {
    const setup = textSetup();
    const receipt = await setup.step.run(setup.plan.extraction, signal());
    const prepared = PdfTextPrepareOutcomeSchema.parse(
      await setup.preparation.run({ plan: setup.plan, receipt }, signal()),
    );
    if (prepared.status !== "prepared" || prepared.task.source.kind !== "prepared") {
      throw new Error(JSON.stringify(prepared));
    }
    expect(parseTextInput(prepared.task, hashString)).toEqual(prepared.task);
    const stored = defined(setup.deps.remote.data.get(prepared.task.source.document.objectKey));
    const document = TextDocumentSchema.parse(decodeJson(stored));
    expect(document).toMatchObject({
      text: "Supplement Facts\nVitamin C 100 mg",
      pageIndex: 1,
      source: setup.plan.extraction.pdf,
    });
    expect(prepared.task.range).toEqual({ start: 0, end: document.text.length });
    const writes = setup.deps.remote.writes;
    expect(await inspector(setup).inspect(setup.plan, signal())).toEqual(prepared.task);
    expect(await replacement(setup).run({ plan: setup.plan, receipt: null }, signal())).toEqual(
      prepared,
    );
    expect([setup.deps.remote.writes, setup.engine.runs]).toEqual([writes, 1]);
  });

  it("a missing extraction or an empty page stops, with no OCR or second extraction", async () => {
    const setup = textSetup("");
    expect(
      await setup.preparation.run({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ code: "PDF.NOT_DURABLE" });
    const receipt = await setup.step.run(setup.plan.extraction, signal());
    expect(await setup.preparation.run({ plan: setup.plan, receipt }, signal())).toMatchObject({
      code: "PDF.TEXT_EMPTY",
    });
    const review = defined([...setup.deps.reviews.records.values()].at(-1));
    expect(review.failure.stage).toBe("pdf.text-input");
    expect(review.rawError.details).toMatchObject({ plan: setup.plan });
    expect(setup.engine.runs).toBe(1);
    expect(setup.deps.remote.data.has(pdfTextInputKey(setup.plan))).toBe(false);
  });

  it("an extraction Review stays a Review; a forged operation, key or code is refused", async () => {
    const setup = textSetup();
    setup.deps.remote.data.delete(setup.plan.extraction.pdf.objectKey);
    const receipt = await setup.step.run(setup.plan.extraction, signal());
    const size = setup.deps.reviews.records.size;
    expect(await setup.preparation.run({ plan: setup.plan, receipt }, signal())).toEqual(receipt);
    expect(setup.deps.reviews.records.size).toBe(size);
    for (const forged of [
      { operationId: "foreign" },
      { evidenceKey: "foreign/key" },
      { code: "PDF.TEXT_EMPTY" },
    ]) {
      expect(
        await setup.preparation.run(
          { plan: setup.plan, receipt: { ...receipt, ...forged } },
          signal(),
        ),
      ).toMatchObject({
        code: "PDF.IDENTITY_CONFLICT",
      });
    }
    expect(setup.engine.runs).toBe(0);
  });

  it.each(["source", "output", "completion", "document", "plan"])(
    "damaged %s evidence is never accepted by a replacement",
    async (part) => {
      const setup = textSetup();
      const receipt = await setup.step.run(setup.plan.extraction, signal());
      const prepared = await setup.preparation.run({ plan: setup.plan, receipt }, signal());
      if (
        prepared.status !== "prepared" ||
        prepared.task.source.kind !== "prepared" ||
        receipt.status !== "durable"
      ) {
        throw new Error(JSON.stringify(prepared));
      }
      const keys: Record<string, string> = {
        source: setup.plan.extraction.pdf.objectKey,
        output: receipt.artifact.objectKey,
        completion: pdfCompletionKey(setup.plan.extraction),
        document: prepared.task.source.document.objectKey,
        plan: prepared.evidenceKey,
      };
      setup.deps.remote.data.set(defined(keys[part]), Buffer.from("corrupt"));
      const writes = setup.deps.remote.writes;
      await expect(inspector(setup).inspect(setup.plan, signal())).rejects.toThrow();
      expect(
        await replacement(setup).run({ plan: setup.plan, receipt: null }, signal()),
      ).toMatchObject({ status: "review" });
      expect([setup.deps.remote.writes, setup.engine.runs]).toEqual([writes, 1]);
    },
  );

  it("the inspector refuses a replaced page, range, setup or extraction in the stored task", async () => {
    const setup = textSetup();
    await setup.step.run(setup.plan.extraction, signal());
    await setup.preparation.run({ plan: setup.plan, receipt: null }, signal());
    const key = pdfTextInputKey(setup.plan);
    const original = decodeJson(defined(setup.deps.remote.data.get(key))) as Record<
      string,
      Record<string, unknown>
    >;
    const { plan = {}, task = {}, extraction = {} } = original;
    const changes = [
      {
        ...original,
        plan: { ...plan, extraction: { ...(plan["extraction"] as object), pageIndex: 0 } },
      },
      { ...original, task: { ...task, range: { start: 0, end: 1 } } },
      { ...original, task: { ...task, configFingerprint: "f".repeat(64) } },
      {
        ...original,
        extraction: {
          ...extraction,
          manifest: { ...(extraction["manifest"] as object), pageIndex: 0 },
        },
      },
    ];
    for (const change of changes) {
      setup.deps.remote.data.set(key, Buffer.from(JSON.stringify(change)));
      await expect(inspector(setup).inspect(setup.plan, signal())).rejects.toMatchObject({
        code: "PDF.TEXT_INPUT_UNVERIFIED",
      });
    }
  });

  it.each(["/document.json", "/input.json"])(
    "an unknown publication of %s is never repeated from an empty cache",
    async (suffix) => {
      const setup = textSetup();
      await setup.step.run(setup.plan.extraction, signal());
      const create = setup.deps.remote.create.bind(setup.deps.remote);
      const put = vi.spyOn(setup.deps.remote, "create").mockImplementation(async (key, bytes) => {
        if (key.endsWith(suffix)) {
          throw new Error("offline");
        }
        return create(key, bytes);
      });
      expect(
        await setup.preparation.run({ plan: setup.plan, receipt: null }, signal()),
      ).toMatchObject({ code: "PDF.HANDOFF_UNVERIFIED" });
      expect(
        await replacement(setup).run({ plan: setup.plan, receipt: null }, signal()),
      ).toMatchObject({ code: "PDF.HANDOFF_PENDING" });
      expect(put.mock.calls.filter(([key]) => key.endsWith(suffix))).toHaveLength(1);
    },
  );

  it("a lost publication acknowledgement is settled by reading it back", async () => {
    const setup = textSetup();
    await setup.step.run(setup.plan.extraction, signal());
    const create = setup.deps.remote.create.bind(setup.deps.remote);
    vi.spyOn(setup.deps.remote, "create").mockImplementation(async (key, bytes) => {
      const created = await create(key, bytes);
      if (key.endsWith("/input.json")) {
        throw new Error("lost ack");
      }
      return created;
    });
    expect(
      await setup.preparation.run({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ status: "prepared" });
  });

  it("an oversized page text is refused, never truncated", async () => {
    const setup = textSetup();
    const receipt = await setup.step.run(setup.plan.extraction, signal());
    if (receipt.status !== "durable") {
      throw new Error(JSON.stringify(receipt));
    }
    const key = pdfCompletionKey(setup.plan.extraction);
    const record = decodeJson(defined(setup.deps.remote.data.get(key))) as {
      manifest: { sha256: string; byteSize: number };
      artifact: { sha256: string; byteSize: number; objectKey: string };
    };
    const bytes = Buffer.from(
      JSON.stringify({ kind: "text", pageIndex: 1, text: "x".repeat(200_001), hasText: true }),
    );
    record.manifest.sha256 = record.artifact.sha256 = sha256(bytes);
    record.manifest.byteSize = record.artifact.byteSize = bytes.length;
    setup.deps.remote.data.set(record.artifact.objectKey, bytes);
    setup.deps.remote.data.set(key, Buffer.from(JSON.stringify(record)));
    expect(
      await setup.preparation.run({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ code: "PDF.TEXT_LIMIT" });
  });
});
