import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewRecordSchema, type LabelProductJoin } from "@crawl-automation/v3-contracts";
import { assemblySetup, labelCandidate, visionFingerprint } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { assemblyFailure } from "./assembly-errors.js";
import { labelAssemblyKey } from "./assembly-files.js";

const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());

type Setup = ReturnType<typeof assemblySetup>;
type ImageSource = Extract<LabelProductJoin["manifest"]["sources"][number], { kind: "image" }>;

function sourceReview(setup: Setup, at: { source: ImageSource; reviewId: string; code: string }) {
  const { observation } = setup.join.manifest;
  return ReviewRecordSchema.parse({
    schemaVersion: 1,
    reviewId: at.reviewId,
    occurredAt: "2026-09-07T00:00:00Z",
    observation,
    failure: {
      schemaVersion: 1,
      requestId: observation.requestId,
      observationId: observation.observationId,
      operationId: at.source.task.input.operationId,
      inputFingerprint: visionFingerprint(at.source.task),
      stage: "codex.vision",
      category: "PROCESSING",
      code: at.code,
      executionFact: "executed",
      evidenceKey: "retained/response.json",
      blockedBy: null,
      automaticRetry: false,
    },
    rawError: { name: "Synthetic", message: "Synthetic", stack: null, details: null },
    candidate: null,
    inspection: { kind: "none" },
  });
}

const imageSource = (setup: Setup, index: number) =>
  defined(setup.join.manifest.sources[index]) as ImageSource;

// Cases carried over from the former label product assembly and collection.
describe("label assembly and collection", () => {
  it("an optional source's identity mismatch is never downgraded to a warning", async () => {
    const setup = assemblySetup();
    imageSource(setup, 0).required = false;
    const original = defined(setup.deps.readSource.getMockImplementation());
    setup.deps.readSource.mockImplementation(async (source) => ({
      ...(await original(source)),
      id: "foreign",
    }));
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: ["LABEL_PRODUCT.IDENTITY_CONFLICT"],
    });
    expect(setup.registry.append).not.toHaveBeenCalled();
  });

  it("keeps duplicate group names, row positions, component doses and all provenance (/3)", async () => {
    const setup = assemblySetup();
    const out = await setup.assembly.run(setup.join, signal());
    expect(out.status).toBe("ready");
    const result = await setup.collector.run(
      { join: setup.join, evidenceKey: out.evidenceKey },
      signal(),
    );
    expect(result.status).toBe("collected");
    const record = defined([...setup.collected.values()][0]);
    expect(record.codec).toBe("collected-product/3");
    expect(defined(record.formula.columns[0]).rows).toHaveLength(18);
    expect(record.ingredients.filter((item) => item.role === "blend_component")).toHaveLength(11);
    expect(record.ingredients.filter((item) => item.role === "other")).toHaveLength(7);
    expect(record.ingredients.find((item) => item.name.text === "Sodium")).toMatchObject({
      parentRowIndex: 4,
      amount: { text: "200 mg" },
    });
    const caffeine = record.ingredients.find((item) =>
      item.name.text.startsWith("Natural Caffeine"),
    );
    expect(caffeine).toMatchObject({ parentRowIndex: 13, amount: { text: "100 mg" } });
    expect(defined(record.provenance[0]).candidate).toEqual(labelCandidate());
    const writes = setup.remote.writes;
    expect(
      await setup
        .cold()
        .collector.run({ join: setup.join, evidenceKey: out.evidenceKey }, signal()),
    ).toEqual(result);
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
    expect(setup.remote.writes).toBe(writes);
  });

  it("formula-only and ingredients-only sources complement each other, in a fixed order", async () => {
    const formula = labelCandidate();
    formula.otherIngredients = null;
    const ingredients = labelCandidate();
    ingredients.formula = null;
    ingredients.formulaComplete = false;
    const setup = assemblySetup([formula, ingredients]);
    const out = await setup.assembly.run(setup.join, signal());
    expect(out.status).toBe("ready");
    const reversed = {
      manifest: { ...setup.join.manifest, sources: [...setup.join.manifest.sources].reverse() },
      states: [...setup.join.states].reverse(),
    };
    const writes = setup.remote.writes;
    expect(await setup.cold().assembly.run(reversed, signal())).toEqual(out);
    expect(setup.remote.writes).toBe(writes);
    expect(
      (await setup.collector.run({ join: reversed, evidenceKey: out.evidenceKey }, signal()))
        .status,
    ).toBe("collected");
  });

  it.each(["amount", "ingredients", "container"])(
    "a real %s disagreement is a Review, even for an optional source",
    async (kind) => {
      const other = labelCandidate();
      const rows = defined(other.formula?.columns[0]).rows;
      if (kind === "amount") {
        defined(defined(rows[5]).amount).text = "201 mg";
      }
      if (kind === "ingredients") {
        defined(other.otherIngredients?.items[0]).text = "Different syrup";
      }
      if (kind === "container") {
        defined(other.formula?.servingsPerContainer).text = "12";
      }
      const setup = assemblySetup([labelCandidate(), other]);
      imageSource(setup, 1).required = false;
      const out = await setup.assembly.run(setup.join, signal());
      expect(out.status).toBe("review");
      expect(
        (await setup.collector.run({ join: setup.join, evidenceKey: out.evidenceKey }, signal()))
          .status,
      ).toBe("review");
      expect(setup.collected.size).toBe(0);
    },
  );

  it("a required source's Review blocks; an optional one only warns, without rerunning the source", async () => {
    const setup = assemblySetup([labelCandidate(), labelCandidate()]);
    const source = imageSource(setup, 1);
    const review = sourceReview(setup, {
      source,
      reviewId: "source-review",
      code: "VISION.UNCERTAIN",
    });
    setup.records.set(review.reviewId, review);
    setup.join.states[1] = { id: source.id, status: "review", reviewId: review.reviewId };
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: ["VISION.UNCERTAIN"],
    });
    const optional = structuredClone(setup.join);
    optional.manifest.operationId = "optional-product";
    defined(optional.manifest.sources[1]).required = false;
    const out = await setup.assembly.run(optional, signal());
    expect(out.status).toBe("ready");
    expect(
      await setup.collector.run({ join: optional, evidenceKey: out.evidenceKey }, signal()),
    ).toMatchObject({ status: "collected" });
    expect(defined([...setup.collected.values()][0]).warnings).toEqual([
      { id: source.id, code: "VISION.UNCERTAIN" },
    ]);
  });

  it.each(["missing", "duplicate", "foreign"])(
    "a %s source state is a Review and nothing is collected",
    async (kind) => {
      const setup = assemblySetup();
      if (kind === "missing") {
        setup.join.states = [];
      }
      if (kind === "duplicate") {
        setup.join.states.push(defined(setup.join.states[0]));
      }
      if (kind === "foreign") {
        defined(setup.join.states[0]).id = "foreign";
      }
      expect((await setup.assembly.run(setup.join, signal())).status).toBe("review");
      expect(setup.registry.append).not.toHaveBeenCalled();
    },
  );

  it("damaged source evidence blocks collection without repairing it", async () => {
    const setup = assemblySetup();
    const out = await setup.assembly.run(setup.join, signal());
    setup.deps.readSource.mockRejectedValue(assemblyFailure("LABEL_PRODUCT.EVIDENCE_UNRESOLVED"));
    expect(
      (await setup.collector.run({ join: setup.join, evidenceKey: out.evidenceKey }, signal()))
        .status,
    ).toBe("review");
    expect(setup.registry.append).not.toHaveBeenCalled();
  });

  it("an unknown assembly upload stays a Review on an empty-cache worker, with no second write", async () => {
    const setup = assemblySetup();
    const key = labelAssemblyKey(setup.join);
    const create = setup.remote.create.bind(setup.remote);
    const writes = vi.spyOn(setup.remote, "create").mockImplementation(async (objectKey, bytes) => {
      if (objectKey === key) {
        throw new Error("secret");
      }
      return create(objectKey, bytes);
    });
    expect((await setup.assembly.run(setup.join, signal())).status).toBe("review");
    const count = writes.mock.calls.length;
    expect(await setup.cold().assembly.run(setup.join, signal())).toMatchObject({
      codes: ["LABEL_PRODUCT.HANDOFF_PENDING"],
    });
    expect(writes).toHaveBeenCalledTimes(count);
    expect(JSON.stringify([...setup.records.values()])).not.toContain("secret");
  });

  it("lost assembly and collection acknowledgements are settled by reading back", async () => {
    const setup = assemblySetup();
    const key = labelAssemblyKey(setup.join);
    const create = setup.remote.create.bind(setup.remote);
    vi.spyOn(setup.remote, "create").mockImplementation(async (objectKey, bytes) => {
      const created = await create(objectKey, bytes);
      if (objectKey === key) {
        throw new Error("lost");
      }
      return created;
    });
    expect((await setup.assembly.run(setup.join, signal())).status).toBe("ready");
    setup.registry.append.mockImplementation(async (record) => {
      setup.collected.set(record.operationId, record);
      throw new Error("lost");
    });
    expect(
      (await setup.collector.run({ join: setup.join, evidenceKey: key }, signal())).status,
    ).toBe("collected");
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
  });

  it("an unknown insert is never repeated by a replacement", async () => {
    const setup = assemblySetup();
    const out = await setup.assembly.run(setup.join, signal());
    setup.registry.append.mockRejectedValue(new Error("unavailable"));
    const input = { join: setup.join, evidenceKey: out.evidenceKey };
    expect((await setup.collector.run(input, signal())).status).toBe("review");
    const writes = setup.remote.writes;
    expect(await setup.cold().collector.run(input, signal())).toMatchObject({
      codes: ["LABEL_PRODUCT.HANDOFF_PENDING"],
    });
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
    expect(setup.remote.writes).toBe(writes);
  });

  it("two concurrent collectors insert at most once", async () => {
    const setup = assemblySetup();
    const out = await setup.assembly.run(setup.join, signal());
    const input = { join: setup.join, evidenceKey: out.evidenceKey };
    const results = await Promise.all([
      setup.collector.run(input, signal()),
      setup.cold().collector.run(input, signal()),
    ]);
    expect(results.some((result) => result.status === "collected")).toBe(true);
    expect(setup.registry.append).toHaveBeenCalledTimes(1);
  });

  it("a cancelled assembly writes nothing and records no Review", async () => {
    const setup = assemblySetup();
    await expect(
      setup.assembly.run(setup.join, AbortSignal.abort(new Error("cancelled"))),
    ).rejects.toThrow("cancelled");
    expect([setup.remote.writes, setup.records.size]).toEqual([0, 0]);
  });

  it("a source Review found only through the reader's fallback copy is still accounted for", async () => {
    const setup = assemblySetup();
    const source = imageSource(setup, 0);
    const review = sourceReview(setup, {
      source,
      reviewId: "vision-only-retained",
      code: "VISION.LABEL_CORE_MISSING",
    });
    const retained = new Map([[review.reviewId, review]]);
    const ledger = defined(setup.deps.reviews.read.getMockImplementation());
    setup.deps.reviews.read.mockImplementation(
      async (id: string) => (await ledger(id)) ?? retained.get(id) ?? null,
    );
    setup.join.states = [{ id: source.id, status: "review", reviewId: review.reviewId }];
    const out = await setup.assembly.run(setup.join, signal());
    expect(out.status).toBe("review");
    expect(JSON.stringify(out)).not.toContain("LABEL_PRODUCT.REVIEW_UNVERIFIED");
  });

  it("a Review the ledger does not confirm is never reported as recorded", async () => {
    const setup = assemblySetup();
    setup.join.states = [];
    setup.deps.reviews.append.mockResolvedValue(undefined);
    await expect(setup.assembly.run(setup.join, signal())).rejects.toMatchObject({
      code: "LABEL_PRODUCT.REVIEW_UNVERIFIED",
    });
  });
});
