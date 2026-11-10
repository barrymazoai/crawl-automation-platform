import { describe, expect, it } from "vitest";
import { amazonLabelFormats } from "./amazon-marketplaces.js";
import { columnRole, formatRules, LABEL_FORMATS, type LabelFormatId } from "./label-formats.js";

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
