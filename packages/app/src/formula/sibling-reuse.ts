import { pipelineErrors } from "@crawl-automation/platform";
import { ProductFamilySchema, type ProductFamily } from "@crawl-automation/channels-core";
import { checkSiblingLabel, hashString } from "@crawl-automation/processing";
import { KeywordResultSchema } from "@crawl-automation/v3-contracts";
import { SiblingReuseRequestSchema, type SiblingReuseRequest } from "@crawl-automation/workflows";
import { formulaChannels } from "./formula-lookup.js";
import type {
  FamilyCoverage,
  FormulaFamilies,
  FormulaIndex,
  FormulaLinks,
  LabelImageText,
} from "./ports.js";

export type SiblingReuseResult = (
  | {
      status: "reused";
      formulaOperationId: string;
      linkId: string;
      siblingListingId: string;
      siblingVariantId: string | null;
    }
  | { status: "extract"; reason: string }
) & { coverage?: FamilyCoverage };

/** Only these differences may share a formula, and only after the label check. */
const SHAREABLE: readonly string[] = ["size", "pack-count"];

const extract = (reason: string): SiblingReuseResult => ({ status: "extract", reason });
const differsCode = (differsBy: string) =>
  `FORMULA.FAMILY_DIFFERS_BY_${differsBy.replace(/-/gu, "_").toUpperCase()}`;

type Found = { member: ProductFamily["members"][number]; operationId: string };

/** The label the check compares: the page's facts text, or the OCR text of the facts image. */
interface Label {
  text: string;
  check: "label-text-match/1" | "label-ocr-match/1";
  image?: { ocrOperationId: string; imageId: string };
}

/**
 * Sibling formula reuse (docs/spark/2026-09-28-channel-brand-adapters-plan.md, Phase 2 item 6): a product with no
 * formula of its own uses a size or pack-count sibling's formula only when its own label prints exactly that formula.
 * The label is the page's facts text; a page without it is asked again with its facts image's OCR text. The reuse is
 * written as a link record with its evidence; anything else is full extraction, with the reason.
 */
export class SiblingFormulaReuse {
  constructor(
    private readonly deps: {
      index: FormulaIndex;
      families: FormulaFamilies;
      links: FormulaLinks;
      /** Reads the facts image's OCR text; without it a label only in images is extracted in full. */
      labelImages?: LabelImageText;
    },
  ) {}

  async reuse(raw: unknown, signal?: AbortSignal): Promise<SiblingReuseResult> {
    const request = SiblingReuseRequestSchema.parse(raw);
    const family = ProductFamilySchema.safeParse(request.family);
    if (!family.success) {
      return extract(pipelineErrors.code("FORMULA.FAMILY_UNREADABLE"));
    }
    const coverage = await this.deps.index.familyCoverage?.(
      family.data.members.map((member) => ({
        channels: formulaChannels(request.channel, this.deps.families),
        listingId: member.listingId,
        variantId: member.variantId,
        memberUrl: member.url,
      })),
    );
    const result = await this.reuseFamily({ request, family: family.data, signal });
    return coverage ? { ...result, coverage } : result;
  }

  private async reuseFamily(input: {
    request: SiblingReuseRequest;
    family: ProductFamily;
    signal: AbortSignal | undefined;
  }): Promise<SiblingReuseResult> {
    const { request, family, signal } = input;
    if (!SHAREABLE.includes(family.differsBy)) {
      return extract(differsCode(family.differsBy));
    }
    const found = await this.firstSiblingFormula(request, family);
    if (!found) {
      return extract(pipelineErrors.code("FORMULA.NO_SIBLING_FORMULA"));
    }
    // Checked only once a sibling formula exists, so the workflow reads the facts image only when it can pay off.
    const label = await this.labelOf(request, signal ?? new AbortController().signal);
    if (!label) {
      return extract(pipelineErrors.code("FORMULA.LABEL_TEXT_UNAVAILABLE"));
    }
    return this.checkAndLink({ request, family, found, label });
  }

  /** The first family member, in page order, that has a formula across this channel's formula family. */
  private async firstSiblingFormula(
    request: SiblingReuseRequest,
    family: ProductFamily,
  ): Promise<Found | null> {
    const channels = formulaChannels(request.channel, this.deps.families);
    for (const member of family.members) {
      const { listingId, variantId } = member;
      const formula = await this.deps.index.findForMember({
        channels,
        listingId,
        variantId,
        memberUrl: member.url,
      });
      if (formula && (formula.variantId === undefined || formula.variantId === variantId)) {
        const resolved = {
          ...member,
          listingId: formula.listingId ?? listingId,
          variantId: formula.variantId === undefined ? variantId : formula.variantId,
        };
        return { member: resolved, operationId: formula.operationId };
      }
    }
    return null;
  }

  private async labelOf(request: SiblingReuseRequest, signal: AbortSignal): Promise<Label | null> {
    if (request.labelText) {
      return { text: request.labelText, check: "label-text-match/1" };
    }
    if (request.labelImage === undefined || !this.deps.labelImages) {
      return null;
    }
    const selection = KeywordResultSchema.parse(request.labelImage);
    const text = await this.deps.labelImages.verifiedText(selection, signal);
    const image = { ocrOperationId: selection.ocrOperationId, imageId: selection.image.artifactId };
    return { text, check: "label-ocr-match/1", image };
  }

  private async checkAndLink(parts: {
    request: SiblingReuseRequest;
    family: ProductFamily;
    found: Found;
    label: Label;
  }): Promise<SiblingReuseResult> {
    const { request, family, found, label } = parts;
    const saved = await this.deps.index.readSaved(found.operationId);
    if (!saved) {
      return extract(pipelineErrors.code("FORMULA.SIBLING_FORMULA_UNREADABLE"));
    }
    if (!checkSiblingLabel(label.text, saved).match) {
      return extract(pipelineErrors.code("FORMULA.LABEL_MISMATCH"));
    }
    const { channel, listingId, variantId, runId } = request;
    const sibling = { listingId: found.member.listingId, variantId: found.member.variantId };
    const evidence = {
      family,
      labelText: label.text,
      check: label.check,
      ...(label.image ? { labelImage: label.image } : {}),
    };
    const link = await this.deps.links.record({
      linkId: hashString(JSON.stringify(["formula-link/1", channel, listingId, variantId])),
      channel,
      listingId,
      variantId,
      formulaOperationId: found.operationId,
      sibling,
      evidence,
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
