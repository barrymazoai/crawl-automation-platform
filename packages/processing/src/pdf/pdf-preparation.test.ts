import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PdfOcrPrepareOutcomeSchema,
  PdfPagesPrepareOutcomeSchema,
  parseOcrInput,
} from "@crawl-automation/v3-contracts";
import { hashString } from "../results/result-record.js";
import { MemoryStore } from "../testing/memory-store.js";
import { defined } from "../testing/defined.js";
import { fakePdfEngine, pdfStores, pdfTask, signal } from "../testing/pdf-fixture.js";
import { PdfPreparation } from "./pdf-preparation.js";
import { PdfStep } from "./pdf-step.js";

afterEach(() => vi.restoreAllMocks());

function preparationSetup(pages = 2) {
  const deps = pdfStores();
  const engine = fakePdfEngine({ pages });
  const inspection = pdfTask("pdf.inspect", "inspect-pdf");
  const ocr = {
    schemaVersion: 1 as const,
    module: "ocr.file" as const,
    implementationVersion: "ocr/1",
    policyVersion: "policy/1",
    resultSchemaVersion: 2 as const,
    configFingerprint: "a".repeat(64),
  };
  const plan = {
    operationId: "product-pdf",
    inspection,
    scale: 1,
    ocr,
    configFingerprint: "b".repeat(64),
  };
  return {
    deps,
    engine,
    plan,
    step: new PdfStep(deps, engine),
    preparation: new PdfPreparation(deps),
  };
}

// Cases carried over from the former PDF preparation.
describe("PDF preparation", () => {
  it("plans every page of a verified inspection, and a rendered page's OCR task is bound to its bytes", async () => {
    const setup = preparationSetup();
    const receipt = await setup.step.run(setup.plan.inspection, signal());
    const planned = PdfPagesPrepareOutcomeSchema.parse(
      await setup.preparation.pages({ plan: setup.plan, receipt }, signal()),
    );
    if (planned.status !== "planned") {
      throw new Error(JSON.stringify(planned));
    }
    expect(planned.pages).toHaveLength(2);
    const writes = setup.deps.remote.writes;
    const replacement = new PdfPreparation({ ...setup.deps, journal: new MemoryStore() });
    expect(await replacement.pages({ plan: setup.plan, receipt: null }, signal())).toEqual(planned);
    expect(setup.deps.remote.writes).toBe(writes);
    const page = defined(planned.pages[1]);
    const rendered = await setup.step.run(page.render, signal());
    const prepared = PdfOcrPrepareOutcomeSchema.parse(
      await setup.preparation.ocr({ plan: page, receipt: null }, signal()),
    );
    if (prepared.status !== "prepared") {
      throw new Error(JSON.stringify(prepared));
    }
    expect(parseOcrInput(prepared.task, hashString).file).toMatchObject({
      kind: "pdf-page",
      pageIndex: 1,
      parentArtifactId: setup.plan.inspection.pdf.artifactId,
    });
    const after = setup.deps.remote.writes;
    expect(await setup.preparation.ocr({ plan: page, receipt: rendered }, signal())).toEqual(
      prepared,
    );
    expect(setup.deps.remote.writes).toBe(after);
    expect(setup.engine.runs).toBe(2);
  });

  it("an unconfirmed inspection or more than 100 pages stops before rendering, never truncating", async () => {
    const setup = preparationSetup(101);
    expect(
      await setup.preparation.pages({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ code: "PDF.NOT_DURABLE" });
    expect(setup.engine.runs).toBe(0);
    const receipt = await setup.step.run(setup.plan.inspection, signal());
    expect(await setup.preparation.pages({ plan: setup.plan, receipt }, signal())).toMatchObject({
      code: "PDF.PRODUCT_PAGE_LIMIT",
    });
    expect(setup.engine.runs).toBe(1);
  });

  it("a verified step Review passes through; a forged operation or evidence key is refused", async () => {
    const setup = preparationSetup();
    setup.deps.remote.data.delete(setup.plan.inspection.pdf.objectKey);
    const receipt = await setup.step.run(setup.plan.inspection, signal());
    const before = setup.deps.reviews.records.size;
    expect(await setup.preparation.pages({ plan: setup.plan, receipt }, signal())).toEqual(receipt);
    expect(setup.deps.reviews.records.size).toBe(before);
    for (const forged of [{ operationId: "foreign" }, { evidenceKey: "foreign/key" }]) {
      expect(
        await setup.preparation.pages(
          { plan: setup.plan, receipt: { ...receipt, ...forged } },
          signal(),
        ),
      ).toMatchObject({
        code: "PDF.IDENTITY_CONFLICT",
      });
    }
    expect(setup.engine.runs).toBe(0);
  });

  it("a failed plan publication stays pending on replay; nothing is written or run again", async () => {
    const setup = preparationSetup();
    await setup.step.run(setup.plan.inspection, signal());
    const create = setup.deps.remote.create.bind(setup.deps.remote);
    const put = vi.spyOn(setup.deps.remote, "create").mockImplementation(async (key, bytes) => {
      if (key.endsWith("pages.json")) {
        throw new Error("offline");
      }
      return create(key, bytes);
    });
    expect(
      await setup.preparation.pages({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ status: "review" });
    expect(
      await setup.preparation.pages({ plan: setup.plan, receipt: null }, signal()),
    ).toMatchObject({ code: "PDF.HANDOFF_PENDING" });
    expect(setup.engine.runs).toBe(1);
    expect(put.mock.calls.filter(([key]) => key.endsWith("pages.json"))).toHaveLength(1);
  });
});
