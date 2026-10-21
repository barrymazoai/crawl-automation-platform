import { expect, it } from "vitest";
import {
  projectLabelProductCandidate,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { rowsOf, signal } from "../testing/merge-fixture.js";
import { textEntry } from "../testing/assembly-fixture.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";
import { compareLabelStructure } from "./label-comparison.js";

function mergeImages(first: LabelImageCandidate, second: LabelImageCandidate) {
  const setup = assemblySetup([first, second]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  return mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
}

async function collectImages(first: LabelImageCandidate, second: LabelImageCandidate) {
  const setup = assemblySetup([first, second]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  const assembled = await setup.assembly.run(setup.join, signal());
  expect(assembled.status).toBe("ready");
  return setup.collector.run({ join: setup.join, evidenceKey: assembled.evidenceKey }, signal());
}

type FormulaRow = ReturnType<typeof rowsOf>[number];
const fact = (name: string, amount: string | null, dv: string | null = null): FormulaRow => ({
  kind: "nutrient",
  name: agreementField(name),
  amount: amount ? agreementField(amount) : null,
  amountStatus: amount ? "printed" : "not_declared",
  dailyValue: dv ? agreementField(dv) : null,
  parentRowIndex: null,
});
const component = (name: string, amount: string | null, parentRowIndex: number) => ({
  ...fact(name, amount),
  kind: "blend_component" as const,
  parentRowIndex,
});
const group = (name: string): FormulaRow => ({
  ...fact(name, null),
  kind: "group_header",
  amountStatus: "not_applicable",
});
const blend = (name: string, amount: string): FormulaRow => ({
  ...fact(name, amount),
  kind: "blend_total",
});
function panel(rows: FormulaRow[], serving: string | null, count: string | null) {
  const candidate = agreementCandidate();
  defined(candidate.formula).servingSize = serving ? agreementField(serving) : null;
  defined(candidate.formula).servingsPerContainer = count ? agreementField(count) : null;
  defined(defined(candidate.formula).columns[0]).rows = rows;
  return candidate;
}

it("B001E11AP8 joins separate image sections and preserves both source IDs through collection", async () => {
  const tail = panel(
    [
      fact("cinnamon (bark)", "10 mg"),
      fact("citrus bioflavonoid complex", "10 mg"),
      fact("apple pectin", "10 mg"),
      fact("betaine hcl", "10 mg"),
      fact("alfalfa", "5 mg"),
      fact("chamomile", "5 mg"),
      fact("rose hips", "5 mg"),
      fact("acerola extract", "500 mcg", "*; *"),
    ],
    null,
    null,
  );
  const head = panel(
    [
      fact("vitamin a", "1000 mcg rae", "111%; 77%"),
      fact("vitamin c", "120 mg"),
      fact("vitamin d2", "20 mcg"),
      fact("calcium", "130 mg"),
    ],
    "1 tablet",
    "90",
  );
  const setup = assemblySetup([tail, head]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  const result = mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
  expect(result).toMatchObject({ status: "ready", codes: [] });
  expect(result.warnings).toContainEqual({
    id: "source-1",
    code: "LABEL_PRODUCT.FORMULA_SECTIONS_JOINED",
  });
  expect(result.formula?.columns[0]?.rows.map((row) => row.name.sourceId)).toEqual([
    ...Array(4).fill("source-1"),
    ...Array(8).fill("source-0"),
  ]);
  const assembled = await setup.assembly.run(setup.join, signal());
  expect(assembled.status).toBe("ready");
  expect(
    (await setup.collector.run({ join: setup.join, evidenceKey: assembled.evidenceKey }, signal()))
      .status,
  ).toBe("collected");
});

it("B007VN4HKI picks the full panel over the two prefix rows", async () => {
  const close = panel(
    [fact("rhodiola extract", "385 mg"), fact("boron citrate", "100 mg")],
    null,
    null,
  );
  const full = panel(
    [
      fact("total carbohydrate", "<1 g"),
      fact("calcium", "50 mg"),
      fact("sodium", "10 mg"),
      group("anti-catabolic complex"),
      component(
        "rhodiola extract (as rhodiola crenulata) (root) standardized for salidrosides",
        "385 mg",
        3,
      ),
      component("ginkgo extract (as ginkgo biloba) (leaf)", "2.8 mg", 3),
      group("free (active) testosterone stimulator"),
      component("boron citrate supplying 5 mg of boron", "100 mg", 6),
    ],
    "2 caplets",
    "30",
  );
  const result = mergeImages(close, full);
  expect(result).toMatchObject({ status: "ready", codes: [] });
  expect(result.warnings).toContainEqual({ id: "source-0", code: "LABEL_PRODUCT.FORMULA_SUBSET" });
  expect(result.formula).toEqual(projectLabelProductCandidate("source-1", full).formula);
  expect((await collectImages(close, full)).status).toBe("collected");
});

it("B078SD9ZY5 picks complete wording and DV over split or truncated component lines", async () => {
  const common = [
    fact("calories", "30"),
    fact("sodium", "45 mg"),
    fact("protein", "7 g"),
    blend("multi collagen complex", "7.8 g"),
  ];
  const short = panel(
    [
      ...common,
      component("hydrolyzed bovine collagen peptides", null, 3),
      component("bovine bone broth", null, 3),
      component("hydrolyzed protein", null, 3),
      component("hydrolyzed fish collagen peptides", null, 3),
      component("chi", null, 3),
      component("bone broth collagen concentrate", null, 3),
      component("eggshell membrane coll", null, 3),
    ],
    "1 scoop",
    "30",
  );
  const full = panel(
    [
      ...common.slice(0, 1),
      fact("sodium", "45 mg", "2%"),
      fact("protein", "7 g", "0%"),
      defined(common[3]),
      component("hydrolyzed bovine collagen peptides", null, 3),
      component("bovine bone broth hydrolyzed protein", null, 3),
      component("hydrolyzed fish collagen peptides", null, 3),
      component("chicken bone broth collagen concentrate", null, 3),
      component("eggshell membrane collagen", null, 3),
    ],
    "1 scoop",
    "30",
  );
  const result = mergeImages(short, full);
  expect(result).toMatchObject({
    status: "ready",
    codes: [],
    warnings: [{ id: "source-0", code: "LABEL_PRODUCT.FORMULA_SUBSET" }],
  });
  expect(result.formula).toEqual(projectLabelProductCandidate("source-1", full).formula);
  expect((await collectImages(short, full)).status).toBe("collected");
});

it("keeps changed dose and conflicting serving sizes in Review", () => {
  const close = panel([fact("rhodiola extract", "385 mg")], null, null);
  const changed = panel([fact("rhodiola extract (root)", "38.5 mg")], null, null);
  expect(mergeImages(close, changed).codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
  const first = panel([fact("cinnamon", "10 mg")], "1 tablet", null);
  const second = panel([fact("vitamin a", "1000 mcg")], "2 capsules", null);
  expect(mergeImages(first, second).codes).toContain("LABEL_PRODUCT.FORMULA_CONFLICT");
});

it("does not join a page formula to a disjoint image formula", () => {
  const image = panel([fact("cinnamon", "10 mg")], "1 tablet", null);
  const page = panel([fact("vitamin a", "1000 mcg")], "1 tablet", null);
  const setup = assemblySetup([image]);
  const text = textEntry(page);
  setup.join.manifest.sources.push({
    id: text.id,
    kind: "text",
    required: true,
    task: text.record.input,
  });
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  const result = mergeLabelProduct(setup.join.manifest, {
    entries: [...setup.entries.values(), text],
  });
  expect(result.warnings).not.toContainEqual(
    expect.objectContaining({
      code: "LABEL_PRODUCT.FORMULA_SECTIONS_JOINED",
    }),
  );
  expect(result.formula?.columns[0]?.rows).toHaveLength(1);
});

it("accepts cosmetic formula differences without a warning", () => {
  const first = agreementCandidate();
  const second = structuredClone(first);
  defined(rowsOf(first)[0]).dailyValue = agreementField("250%†");
  defined(rowsOf(second)[0]).dailyValue = agreementField("250 %**");
  defined(rowsOf(second)[0]).name = agreementField("VITAMIN D (as\ncholecalciferol).");
  defined(rowsOf(second)[0]).amount = agreementField("50µg");
  expect(mergeImages(first, second)).toMatchObject({ status: "ready", codes: [], warnings: [] });
});

it("selects the longer formula and rechecks its subset warning at collection", async () => {
  const short = agreementCandidate();
  const full = agreementCandidate();
  defined(defined(short.formula).columns[0]).rows.pop();
  const result = mergeImages(short, full);
  expect(result).toMatchObject({
    status: "ready",
    codes: [],
    warnings: [{ id: "source-0", code: "LABEL_PRODUCT.FORMULA_SUBSET" }],
  });
  expect(result.formula).toEqual(projectLabelProductCandidate("source-1", full).formula);
  const setup = assemblySetup([short, full]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  const assembled = await setup.assembly.run(setup.join, signal());
  expect(assembled.status).toBe("ready");
  expect(
    (await setup.collector.run({ join: setup.join, evidenceKey: assembled.evidenceKey }, signal()))
      .status,
  ).toBe("collected");
});

it("retains both normalized formulas when a dose conflicts", async () => {
  const first = agreementCandidate();
  const second = agreementCandidate();
  defined(rowsOf(first)[0]).amount = agreementField("500 mg");
  defined(rowsOf(second)[0]).amount = agreementField("50 mg");
  const setup = assemblySetup([first, second]);
  const outcome = await setup.assembly.run(setup.join, signal());
  expect(outcome).toMatchObject({ status: "review", codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"] });
  if (outcome.status !== "review") {
    throw new Error("expected Review");
  }
  const details = defined(setup.records.get(outcome.reviewId)).rawError.details as {
    conflicts: {
      code: string;
      sources: { id: string; shape: { columns: { rows: string[][] }[] } }[];
    }[];
  };
  expect(details.conflicts[0]?.code).toBe("LABEL_PRODUCT.FORMULA_CONFLICT");
  expect(details.conflicts[0]?.sources.map((source) => source.id)).toEqual([
    "source-0",
    "source-1",
  ]);
  expect(
    details.conflicts[0]?.sources.map((source) => source.shape.columns[0]?.rows[0]?.[2]),
  ).toEqual(["500 mg", "50 mg"]);
});

it("keeps different printed counts in Review and uses the existing diagnostic code", () => {
  const first = agreementCandidate();
  const second = agreementCandidate();
  defined(first.formula).servingsPerContainer = agreementField("30 capsules");
  defined(second.formula).servingsPerContainer = agreementField("60 capsules");
  expect(mergeImages(first, second)).toMatchObject({
    status: "review",
    codes: ["LABEL_PRODUCT.FORMULA_CONFLICT"],
    warnings: [],
  });
  expect(
    compareLabelStructure(
      { kind: "image", candidate: first },
      { kind: "image", candidate: second },
    ),
  ).toEqual({
    status: "conflict",
    codes: ["LABEL.CONTAINER_COUNT_CONFLICT"],
  });
});
