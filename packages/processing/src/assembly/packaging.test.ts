import { describe, expect, it } from "vitest";
import {
  ArtifactRefSchema,
  LabelCollectedProductSchema,
  PackagingFactsSchema,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblySetup, labelCandidate } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { labelCollectedHash } from "./label-collection.js";
import { extractPackagingFacts } from "./packaging.js";

const signal = () => new AbortController().signal;

/** A product with packaging admission; the page documents claim these servings-per-container values. */
function packagingSetup(candidates = [labelCandidate()], values = ["3", "12"]) {
  const setup = assemblySetup(candidates);
  const image = defined(setup.join.manifest.sources[0]);
  if (image.kind !== "image") {
    throw new Error("image source expected");
  }
  const ref = ArtifactRefSchema.parse({
    ...image.task.input.selection.image,
    kind: "result-json",
    mediaType: "application/json",
    objectKey: "packaging/document.json",
    producer: { operationId: "prepared", module: "page.prepare", implementationVersion: "1" },
  });
  const claims = values.map((value, index) => {
    const text = `Servings Per Container: ${value}`;
    return {
      document: ref,
      field: "servingsPerContainer",
      value,
      quote: { text, start: index * 40, end: index * 40 + text.length },
    };
  });
  const unique = [...new Set(values)];
  const status = unique.length > 1 ? "conflict" : unique.length ? "observed" : "unknown";
  const packaging = PackagingFactsSchema.parse({
    codec: "packaging-facts/1",
    observation: setup.join.manifest.observation,
    productComposition: "unknown",
    containerCount: null,
    servingSize: { status: "unknown", value: null, claims: [] },
    servingsPerContainer: { status, value: unique.length === 1 ? unique[0] : null, claims },
    unresolvedPackMentions: [],
    warnings: unique.length > 1 ? ["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"] : [],
    blockingIssues: [],
  });
  setup.join.manifest.admission = { policy: "label-packaging/1", documents: [ref] };
  setup.deps.readPackaging.mockResolvedValue(packaging);
  return { ...setup, packaging, ref };
}

async function collect(setup: ReturnType<typeof packagingSetup>) {
  const out = await setup.assembly.run(setup.join, signal());
  expect(out.status).toBe("ready");
  const result = await setup.collector.run(
    { join: setup.join, evidenceKey: out.evidenceKey },
    signal(),
  );
  expect(result.status).toBe("collected");
  return { out, result, record: defined([...setup.collected.values()][0]) };
}

const rows = (candidate: LabelImageCandidate) => defined(candidate.formula?.columns[0]).rows;

// Cases carried over from the former packaging-admission tests.
describe("packaging admission", () => {
  it("a count conflict still collects (/4) with no count, the raw claims kept, and a cold readback agrees", async () => {
    const setup = packagingSetup();
    const { out, result, record } = await collect(setup);
    expect(record).toMatchObject({
      schemaVersion: 4,
      codec: "collected-product/4",
      formula: { servingsPerContainer: null },
    });
    expect(defined(record.provenance[0]).candidate.formula?.servingsPerContainer?.text).toBe("3");
    if (record.schemaVersion !== 4) {
      throw new Error("collected-product/4 expected");
    }
    expect(record.packaging.servingsPerContainer.claims.map((claim) => claim.value)).toEqual([
      "3",
      "12",
    ]);
    expect(record.warnings).toEqual([
      { id: setup.join.manifest.operationId, code: "PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT" },
    ]);
    const hash = labelCollectedHash(record);
    const writes = setup.remote.writes;
    const input = { join: setup.join, evidenceKey: out.evidenceKey };
    expect(await setup.cold().collector.run(input, signal())).toEqual(result);
    expect([
      setup.registry.append.mock.calls.length,
      setup.remote.writes,
      labelCollectedHash(record),
    ]).toEqual([1, writes, hash]);
  });

  it("different counts across accepted sources are not a formula conflict", async () => {
    const second = labelCandidate();
    defined(second.formula?.servingsPerContainer).text = "12";
    await collect(packagingSetup([labelCandidate(), second], []));
  });

  it.each(["amount", "serving size", "group", "ingredients"])(
    "a core %s conflict still blocks, even for an optional source",
    async (kind) => {
      const second = labelCandidate();
      if (kind === "amount") {
        defined(defined(rows(second)[5]).amount).text = "201 mg";
      }
      if (kind === "serving size") {
        defined(second.formula?.servingSize).text = "3";
      }
      if (kind === "group") {
        defined(rows(second)[17]).kind = "nutrient";
        defined(rows(second)[17]).parentRowIndex = null;
      }
      if (kind === "ingredients") {
        defined(second.otherIngredients?.items[0]).text = "Different syrup";
      }
      const setup = packagingSetup([labelCandidate(), second]);
      defined(setup.join.manifest.sources[1]).required = false;
      expect((await setup.assembly.run(setup.join, signal())).status).toBe("review");
      expect(setup.collected.size).toBe(0);
    },
  );

  it("candidate metadata uncertainty never becomes packaging success", async () => {
    const setup = packagingSetup();
    const read = defined(setup.deps.readSource.getMockImplementation());
    setup.deps.readSource.mockImplementation(async (source) => {
      const entry = await read(source);
      entry.candidate.issues.push({ code: "METADATA_CONFLICT", detail: "Unclassified" });
      return entry;
    });
    expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
      status: "review",
      codes: [
        "LABEL.EVIDENCE_UNCERTAIN",
        "VALIDATION.FORMULA_MISSING",
        "VALIDATION.INGREDIENTS_MISSING",
      ],
    });
  });

  it("missing packaging evidence never falls back to the old policy", async () => {
    const setup = packagingSetup();
    setup.deps.readPackaging.mockRejectedValue(new Error("unavailable"));
    expect((await setup.assembly.run(setup.join, signal())).status).toBe("review");
    expect(setup.registry.append).not.toHaveBeenCalled();
  });

  it("packaging that no longer verifies after assembly prevents the insert", async () => {
    const setup = packagingSetup();
    const out = await setup.assembly.run(setup.join, signal());
    setup.deps.readPackaging.mockRejectedValue(new Error("missing-original"));
    expect(
      (await setup.collector.run({ join: setup.join, evidenceKey: out.evidenceKey }, signal()))
        .status,
    ).toBe("review");
    expect(setup.registry.append).not.toHaveBeenCalled();
  });

  it("an uncontested count stays 3, with no false warning", async () => {
    const { record } = await collect(packagingSetup([labelCandidate()], ["3"]));
    expect(record.formula?.servingsPerContainer?.text).toBe("3");
    expect(record.warnings).toEqual([]);
  });

  it("image-first keeps the non-blocking container-count policy", async () => {
    const setup = packagingSetup();
    setup.join.manifest.evidencePolicy = "label-image-first/1";
    const { record } = await collect(setup);
    expect(record.formula?.servingsPerContainer).toBeNull();
  });

  it.each(["observed", "conflict"] as const)(
    "a verified image serving size wins over %s page evidence, with a warning",
    async (status) => {
      const setup = packagingSetup();
      const values = status === "observed" ? ["9"] : ["9", "10"];
      const servingSize = {
        status,
        value: status === "observed" ? "9" : null,
        claims: values.map((value) => ({
          document: setup.ref,
          field: "servingSize",
          value,
          quote: { text: value, start: 0, end: value.length },
        })),
      };
      const blockingIssues = status === "conflict" ? ["PACKAGING.SERVING_SIZE_CONFLICT"] : [];
      setup.deps.readPackaging.mockResolvedValue(
        PackagingFactsSchema.parse({ ...setup.packaging, servingSize, blockingIssues }),
      );
      expect((await setup.assembly.run(setup.join, signal())).status).toBe("review");
      setup.join.manifest.operationId = "image-first-serving";
      setup.join.manifest.evidencePolicy = "label-image-first/1";
      const { record } = await collect(setup);
      expect(record.formula?.servingSize?.citation.kind).toBe("image");
      expect(
        record.warnings.some((warning) => warning.code === "PACKAGING.SERVING_SIZE_CONFLICT"),
      ).toBe(true);
      const withoutWarning = {
        ...record,
        warnings: record.warnings.filter(
          (warning) => warning.code !== "PACKAGING.SERVING_SIZE_CONFLICT",
        ),
      };
      expect(LabelCollectedProductSchema.safeParse(withoutWarning).success).toBe(false);
    },
  );

  it("the typography policy tolerates only harmless typography and keeps both originals", async () => {
    const second = labelCandidate();
    defined(second.formula?.columns[0]?.heading).text = "Amount Per Serving";
    defined(rows(second)[4]).name.text = "FocusFuel Electrolyte Blend";
    defined(defined(rows(second)[5]).amount).text = "200mg";
    defined(rows(second)[11]).name.text = "Lion's Mane";
    const setup = packagingSetup([labelCandidate(), second]);
    defined(setup.join.manifest.admission).comparison = "label-typography/1";
    const { record } = await collect(setup);
    expect(record).toMatchObject({ comparisonPolicy: "label-typography/1" });
    expect(defined(record.provenance[1]).candidate.formula?.columns[0]?.rows[5]?.amount?.text).toBe(
      "200mg",
    );
  });

  it.each(["unit", "dose", "group", "order"])(
    "the typography policy still blocks a %s change",
    async (kind) => {
      const second = labelCandidate();
      const secondRows = rows(second);
      if (kind === "unit") {
        defined(defined(secondRows[5]).amount).text = "200 mcg";
      }
      if (kind === "dose") {
        defined(defined(secondRows[5]).amount).text = "20 mg";
      }
      if (kind === "group") {
        defined(secondRows[17]).kind = "nutrient";
        defined(secondRows[17]).parentRowIndex = null;
      }
      if (kind === "order") {
        [secondRows[5], secondRows[6]] = [defined(secondRows[6]), defined(secondRows[5])];
      }
      const setup = packagingSetup([labelCandidate(), second]);
      defined(setup.join.manifest.admission).comparison = "label-typography/1";
      expect(await setup.assembly.run(setup.join, signal())).toMatchObject({
        status: "review",
        codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"],
      });
    },
  );
});

describe("packaging facts", () => {
  const document = (text: string) => ({
    ref: {
      schemaVersion: 1,
      artifactId: "page-document",
      observationId: "observation",
      sourceId: "source",
      listingId: "listing",
      variantId: null,
      kind: "result-json",
      mediaType: "application/json",
      sha256: "a".repeat(64),
      byteSize: 10,
      objectKey: "v3/pages/page/document.json",
      producer: { operationId: "page", module: "page.prepare", implementationVersion: "1" },
    },
    document: {
      schemaVersion: 1,
      requestId: "request",
      observationId: "observation",
      brandId: "brand",
      sourceId: "source",
      listingId: "listing",
      variantId: null,
      producer: "page.prepare",
      source: {
        schemaVersion: 1,
        artifactId: "html",
        observationId: "observation",
        sourceId: "source",
        listingId: "listing",
        variantId: null,
        kind: "source-html",
        mediaType: "text/html",
        sha256: "b".repeat(64),
        byteSize: 10,
        objectKey: "capture/page.html",
        producer: { operationId: "capture", module: "capture", implementationVersion: "1" },
      },
      pageIndex: null,
      text,
    },
  });
  const owner = {
    schemaVersion: 1,
    requestId: "request",
    observationId: "observation",
    brandId: "brand",
    sourceId: "source",
    listingId: "listing",
    variantId: null,
  };

  it("reads inline and next-line values, keeps pack mentions unresolved, and never takes a heading as a quantity", () => {
    const facts = extractPackagingFacts(owner, [
      document(
        "Serving Size: 2 scoops\nServings Per Container\n30\nPack of 2\nServings Per Container:\nDirections",
      ),
    ]);
    expect(facts.servingSize).toMatchObject({ status: "observed", value: "2 scoops" });
    expect(facts.servingsPerContainer).toMatchObject({ status: "observed", value: "30" });
    expect(facts.unresolvedPackMentions.map((claim) => claim.value)).toEqual(["Pack of 2"]);
    expect(facts.warnings).toEqual(["PACKAGING.PACK_MEANING_UNRESOLVED"]);
  });

  it("a unitless serving size is no claim, and format-only differences agree (GNC/Swanson, owner 2026-10-08)", () => {
    const gnc = extractPackagingFacts(owner, [
      document(
        "Serving Size\u00a0 1 Scoop (22g)\n\nServing Size\n\n1\n\nServings Per Container\n\n20",
      ),
    ]);
    expect(gnc.servingSize).toMatchObject({ status: "observed", value: "1 Scoop (22g)" });
    expect(gnc.blockingIssues).toEqual([]);
    const spaced = extractPackagingFacts(owner, [
      document("Serving Size: 1 Scoop (22g)\nServing Size: 1 scoop (22 g)"),
    ]);
    expect(spaced.servingSize).toMatchObject({ status: "observed", value: "1 Scoop (22g)" });
  });

  it("different serving sizes are a blocking conflict; no documents or a duplicate are refused", () => {
    const facts = extractPackagingFacts(owner, [
      document("Serving Size: 1 capsule\nServing Size: 2 capsules"),
    ]);
    expect(facts.blockingIssues).toEqual(["PACKAGING.SERVING_SIZE_CONFLICT"]);
    expect(() => extractPackagingFacts(owner, [])).toThrow(
      expect.objectContaining({ code: "PACKAGING.SOURCE_LIMIT" }),
    );
    const one = document("Serving Size: 1");
    expect(() => extractPackagingFacts(owner, [one, one])).toThrow(
      expect.objectContaining({ code: "PACKAGING.DUPLICATE_SOURCE" }),
    );
  });
});
