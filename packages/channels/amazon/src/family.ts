import { classifyFamily, type ProductFamily } from "@crawl-automation/channels-core";
import { z } from "zod";
import { AMAZON_ORIGIN } from "./address.js";
import { amazonErrors } from "./errors.js";
import type { ScriptData } from "./script-data.js";

const AsinSchema = z.string().regex(/^[A-Z0-9]{10}$/);
const LabelsSchema = z
  .array(z.string().min(1).max(500))
  .min(1)
  .max(10)
  .refine((labels) => labels.join(" / ").length <= 1000);
const MembersSchema = z.record(AsinSchema, LabelsSchema);
export interface AmazonVariationFamily {
  parentAsin: string | null;
  dimensions: string[];
  members: { asin: string; labels: string[]; label: string }[];
}

function readFamily(raw: ScriptData["families"][number]): AmazonVariationFamily | null {
  const members = MembersSchema.safeParse(raw.members);
  if (!members.success || Object.keys(members.data).length > 100) {
    return null;
  }
  const dimensions = z.array(z.string().min(1).max(100)).max(10).safeParse(raw.dimensions);
  const parent = AsinSchema.safeParse(raw.parentAsin);
  return {
    parentAsin: parent.success ? parent.data : null,
    dimensions: dimensions.success ? dimensions.data : [],
    members: Object.entries(members.data).map(([asin, labels]) => ({
      asin,
      labels,
      label: labels.join(" / "),
    })),
  };
}

/** Only a twister map containing this page's ASIN belongs to this product. */
export function extractVariationFamily(
  data: ScriptData,
  asin: string,
): AmazonVariationFamily | null {
  const candidates = data.families
    .map(readFamily)
    .filter(
      (family): family is AmazonVariationFamily =>
        family !== null && family.members.some((member) => member.asin === asin),
    );
  const first = candidates[0] ?? null;
  if (candidates.some((family) => JSON.stringify(family) !== JSON.stringify(first))) {
    throw amazonErrors.create("AMAZON.FAMILY_CONFLICT");
  }
  return first;
}

/**
 * Constant dimensions do not affect reuse. Unknown or mismatched dimension data remains
 * conservative.
 */
function varyingDimensions(family: AmazonVariationFamily): number[] {
  const width = family.members[0]?.labels.length ?? 0;
  if (
    family.dimensions.length !== width ||
    family.members.some((item) => item.labels.length !== width)
  ) {
    return [];
  }
  return family.dimensions
    .map((_, index) => index)
    .filter((index) => new Set(family.members.map((member) => member.labels[index])).size > 1);
}

function comparisonLabel(dimension: string, value: string): string {
  const count = ["item_package_quantity", "number_of_items"].includes(dimension);
  return count && /^[1-9]\d*$/.test(value) ? `Pack of ${value}` : value;
}

export function amazonProductFamily(
  family: AmazonVariationFamily | null,
  asin: string,
): ProductFamily | null {
  const selected = family?.members.find((member) => member.asin === asin);
  if (!family || !selected || family.members.length < 2) {
    return null;
  }
  const varying = varyingDimensions(family);
  const group = varying.map((index) => family.dimensions[index]?.replaceAll("_", " ")).join(" / ");
  const labels = family.members.map((member) =>
    varying
      .map((index) => comparisonLabel(family.dimensions[index] ?? "", member.labels[index] ?? ""))
      .join(" / "),
  );
  const known = varying.every((index) =>
    /^(?:(?:size|flavou?r|strength|form)(?:_name)?|item_package_quantity|number_of_items)$/i.test(
      family.dimensions[index] ?? "",
    ),
  );
  return {
    differsBy: group && known ? classifyFamily(group, labels) : "unknown",
    group: group || "Amazon variations",
    selectedLabel: selected.label,
    members: family.members
      .filter((member) => member.asin !== asin)
      .map((member) => ({
        listingId: member.asin,
        variantId: null,
        url: `${AMAZON_ORIGIN}/dp/${member.asin}`,
        label: member.label,
      })),
  };
}
