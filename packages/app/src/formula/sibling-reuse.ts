import { ProductFamilySchema, type ProductFamily } from "@crawl-automation/channels-core";
import { checkSiblingLabel, hashString } from "@crawl-automation/processing";
import { SiblingReuseRequestSchema, type SiblingReuseRequest } from "@crawl-automation/workflows";
import { formulaChannels } from "./formula-lookup.js";
import type { FormulaIndex, FormulaLinks } from "./ports.js";

export type SiblingReuseResult =
  | {
      status: "reused";
      formulaOperationId: string;
      linkId: string;
      siblingListingId: string;
      siblingVariantId: string | null;
    }
  | { status: "extract"; reason: string };

/** Only these differences may share a formula, and only after the label check. */
const SHAREABLE: readonly string[] = ["size", "pack-count"];

const extract = (reason: string): SiblingReuseResult => ({ status: "extract", reason });
const differsCode = (differsBy: string) =>
  `FORMULA.FAMILY_DIFFERS_BY_${differsBy.replace(/-/gu, "_").toUpperCase()}`;

type Found = { member: ProductFamily["members"][number]; operationId: string };

/**
 * Sibling formula reuse (docs/spark/2026-09-28-channel-brand-adapters-plan.md, Phase 2 item 6): a product with no
 * formula of its own uses a size or pack-count sibling's formula only when its own label prints exactly that formula.
 * The reuse is written as a link record with its evidence; anything else is full extraction, with the reason.
 */
export class SiblingFormulaReuse {
  constructor(private readonly deps: { index: FormulaIndex; links: FormulaLinks }) {}

  async reuse(raw: unknown): Promise<SiblingReuseResult> {
    const request = SiblingReuseRequestSchema.parse(raw);
    const family = ProductFamilySchema.safeParse(request.family);
    if (!family.success) {
      return extract("FORMULA.FAMILY_UNREADABLE");
    }
    if (!SHAREABLE.includes(family.data.differsBy)) {
      return extract(differsCode(family.data.differsBy));
    }
    // The label check reads the page's own facts text; a label only in images is extracted in full.
    if (!request.labelText) {
      return extract("FORMULA.LABEL_TEXT_UNAVAILABLE");
    }
    const found = await this.firstSiblingFormula(request, family.data);
    if (!found) {
      return extract("FORMULA.NO_SIBLING_FORMULA");
    }
    return this.checkAndLink({ request, family: family.data, found });
  }

  /** The first family member, in page order, that has a formula across this channel's formula family. */
  private async firstSiblingFormula(
    request: SiblingReuseRequest,
    family: ProductFamily,
  ): Promise<Found | null> {
    const channels = formulaChannels(request.channel);
    for (const member of family.members) {
      const { listingId, variantId } = member;
      const formula = await this.deps.index.findForMember({ channels, listingId, variantId });
      if (formula) {
        return { member, operationId: formula.operationId };
      }
    }
    return null;
  }

  private async checkAndLink(parts: {
    request: SiblingReuseRequest;
    family: ProductFamily;
    found: Found;
  }): Promise<SiblingReuseResult> {
    const { request, family, found } = parts;
    const saved = await this.deps.index.readSaved(found.operationId);
    if (!saved) {
      return extract("FORMULA.SIBLING_FORMULA_UNREADABLE");
    }
    const labelText = request.labelText ?? "";
    const check = checkSiblingLabel(labelText, saved);
    if (!check.match) {
      return extract("FORMULA.LABEL_MISMATCH");
    }
    const { channel, listingId, variantId, runId } = request;
    const sibling = { listingId: found.member.listingId, variantId: found.member.variantId };
    const link = await this.deps.links.record({
      linkId: hashString(JSON.stringify(["formula-link/1", channel, listingId, variantId])),
      channel,
      listingId,
      variantId,
      formulaOperationId: found.operationId,
      sibling,
      evidence: { family, labelText, check: "label-text-match/1" },
      runId,
    });
    return {
      status: "reused",
      formulaOperationId: link.formulaOperationId,
      linkId: link.linkId,
      siblingListingId: link.sibling.listingId,
      siblingVariantId: link.sibling.variantId,
    };
  }
}
