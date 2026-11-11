import { describe, expect, it } from "vitest";
import { amazonLabelFormats } from "./amazon-marketplaces.js";
import {
  columnRole,
  formatRules,
  LABEL_FORMATS,
  readsCompositionRules,
  type LabelFormatId,
} from "./label-formats.js";

const UK: readonly LabelFormatId[] = ["in-nutritional-information/3"];
const INDIA: readonly LabelFormatId[] = ["in-nutritional-information/2"];

// KAN-243 (owner 2026-11-10): the UK reads India's formats. Headers copied from real amazon.co.uk labels (2026-11-10,
// docs/plans/KAN-243-uk-plan.md §1).
describe("in-nutritional-information/3: India's table with the UK's headers", () => {
  it("is what amazon.co.uk reads; amazon.in keeps /2 and amazon.com the US panel alone", () => {
    expect(amazonLabelFormats("amazon-uk")).toEqual([
      "us-facts/1",
      "in-nutritional-information/3",
      "in-composition/2",
    ]);
    expect(amazonLabelFormats("amazon-in")).toEqual([
      "us-facts/1",
      "in-nutritional-information/2",
      "in-composition/2",
    ]);
    expect(amazonLabelFormats("amazon")).toEqual(["us-facts/1"]);
  });

  it.each([
    ["Av. per Tablet", "amount"],
    ["Average per capsule", "amount"],
    ["Per Daily Intake (Two Capsules)", "amount"],
    ["Per 2 Capsules", "amount"],
    ["Per Serving", "amount"],
    ["Each daily dose (3 sprays) contains", "amount"],
    ["Per 3.4 g", "amount"],
    ["Per 100g", "per_basis"],
  ])("reads %s as the %s column", (header, role) => {
    expect(columnRole(header, UK)).toMatchObject({ role, format: "in-nutritional-information/3" });
  });

  it.each(["%NRV", "%NRV*", "% NRV", "NRV%", "*%NRV", "% RI*"])("reads %s as a %%NRV column", (header) => {
    expect(columnRole(header, UK)).toEqual({
      role: "daily_value",
      basis: "eu_nrv",
      format: "in-nutritional-information/3",
    });
  });

  it("reads every Indian header as /2 does", () => {
    for (const header of ["Qty./Serving", "Qty/100g", "%RDA", "**%RDA Per Serve", "Per Serve % RDA", "% Daily Value"]) {
      expect(columnRole(header, UK), header).toEqual({
        ...columnRole(header, INDIA),
        format: "in-nutritional-information/3",
      });
    }
  });

  it("leaves /2 as it was: a %NRV or per-daily-intake header is no column there", () => {
    for (const header of ["%NRV*", "Av. per Tablet", "Per Daily Intake (Two Capsules)"]) {
      expect(columnRole(header, INDIA), header).toBeNull();
    }
    expect(LABEL_FORMATS["in-nutritional-information/2"].keywords).not.toContain("NRV");
  });

  it("skips the NRV footnotes and treats Typical Values as the name column's header", () => {
    const skip = formatRules(UK, "skip");
    for (const line of ["**Nutrient Reference Value Not Established", "*NRV - Nutrient Reference Value", "NRV not established"]) {
      expect(skip.some((rule) => rule.test(line)), line).toBe(true);
    }
    expect(formatRules(UK, "headerCells").some((rule) => rule.test("Typical Values"))).toBe(true);
    expect(skip.some((rule) => rule.test("Magnesium Glycinate"))).toBe(false);
  });
});

// KAN-243 (owner 2026-11-11): Canada reads India's composition lists. Lines copied from real amazon.ca labels
// (2026-11-11, docs/plans/KAN-243-canada-plan.md §1).
describe("in-composition/3: India's composition list with Health Canada's lines", () => {
  const CANADA: readonly LabelFormatId[] = ["in-composition/3"];
  const COMPOSITION: readonly LabelFormatId[] = ["in-composition/2"];
  const serving = (line: string, formats: readonly LabelFormatId[]) =>
    formatRules(formats, "servingFor")
      .map((rule) => rule.exec(line)?.[1])
      .find(Boolean) ?? null;

  it("is what amazon.ca reads, and the composition rules apply to it as to /2", () => {
    expect(amazonLabelFormats("amazon-ca")).toEqual(["us-facts/1", "in-composition/3"]);
    expect(readsCompositionRules(["us-facts/1", "in-composition/3"])).toBe(true);
    expect(readsCompositionRules(["us-facts/1", "in-composition/2"])).toBe(true);
    expect(readsCompositionRules(["us-facts/1", "in-composition/1"])).toBe(false);
    expect(readsCompositionRules(["us-facts/1"])).toBe(false);
  });

  it.each([
    ["Each tablet contains:", "tablet"],
    ["Each softgel contains:", "softgel"],
    ["Each capsule contains: / Chaque capsule contient :", "capsule"],
    ["Medicinal Ingredients: Each tablet contains:", "tablet"],
    ["Ingredients (each softgel contains):", "softgel"],
    ["Medicinal ingredient – each serving (10 g) contains", "serving (10 g)"],
    ["(In each softgel)", "softgel"],
  ])("reads %s as the serving line", (line, printed) => {
    expect(serving(line, CANADA)).toBe(printed);
  });

  it("leaves /2 as it was: Health Canada's lines are no serving or heading there", () => {
    expect(serving("(In each softgel)", COMPOSITION)).toBeNull();
    expect(serving("Ingredients (each softgel contains):", COMPOSITION)).toBeNull();
    expect(serving("Each tablet contains:", COMPOSITION)).toBe("tablet");
    expect(LABEL_FORMATS["in-composition/2"].keywords).toEqual(["Composition"]);
    expect(formatRules(COMPOSITION, "skip").some((rule) => rule.test("Product Facts / Info-produit"))).toBe(
      false,
    );
  });

  it("skips the box headings and the French serving lines, never an ingredient", () => {
    const skip = formatRules(CANADA, "skip");
    for (const line of [
      "Product Facts / Info-produit",
      "Medicinal ingredients / Ingrédients médicinaux",
      "Medicinal Ingredients",
      "Ingrédients médicinaux :",
      "Chaque comprimé contient :",
      "(Dans chaque gélule)",
    ]) {
      expect(skip.some((rule) => rule.test(line)), line).toBe(true);
    }
    for (const line of ["Vitamin D3 (cholecalciferol)", "Fish oil (Gadidae - whole)", "Creatine Monohydrate"]) {
      expect(skip.some((rule) => rule.test(line)), line).toBe(false);
    }
  });

  it("reads the bilingual table headers of a medicinal-ingredient table", () => {
    expect(columnRole("Amount Per Serving / Quantité par portion", CANADA)).toEqual({
      role: "amount",
      format: "in-composition/3",
    });
    expect(columnRole("%DV / %VQ", CANADA)).toEqual({
      role: "daily_value",
      basis: "ca_dv",
      format: "in-composition/3",
    });
    expect(columnRole("%DV / %VQ", COMPOSITION)).toBeNull();
    expect(columnRole("%DV", ["us-facts/1", ...CANADA])).toMatchObject({ basis: "us_dv" });
  });
});
