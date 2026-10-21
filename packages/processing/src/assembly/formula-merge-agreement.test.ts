import { expect, it } from "vitest";
import {
  projectLabelProductCandidate,
  type LabelImageCandidate,
} from "@crawl-automation/v3-contracts";
import { assemblySetup } from "../testing/assembly-fixture.js";
import { defined } from "../testing/defined.js";
import { rowsOf, signal } from "../testing/merge-fixture.js";
import { agreementCandidate, agreementField } from "./label-agreement-fixture.js";
import { mergeLabelProduct } from "./label-merge.js";
import { compareLabelStructure } from "./label-comparison.js";

function mergeImages(first: LabelImageCandidate, second: LabelImageCandidate) {
  const setup = assemblySetup([first, second]);
  setup.join.manifest.evidencePolicy = "label-image-first/1";
  return mergeLabelProduct(setup.join.manifest, { entries: [...setup.entries.values()] });
}

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
