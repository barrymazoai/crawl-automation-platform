import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import {
  ProductFamilySchema,
  type CaptureRequest,
  type ProductSourcePlans,
  type ChannelPlanning,
} from "@crawl-automation/channels-core";
import { DtcVariantHandoffsSchema, type DtcVariantHandoff } from "@crawl-automation/v3-contracts";
import type { DtcSitePolicy } from "../site-policy.js";
import { capturedProductProjection } from "./product-projection.js";
import { readVariantRecord, type VariantRecordInput } from "./variant-record.js";
import type { readCapturedProduct } from "./product-record.js";

interface HandoffInput extends VariantRecordInput {
  request: CaptureRequest;
  site: DtcSitePolicy;
  parsed: ReturnType<typeof capturedProductProjection>;
  images: Awaited<ReturnType<typeof readCapturedProduct>>["images"];
  planning: ChannelPlanning;
}

/** Immutable per-variant projections reference the same retained image bytes. */
export class DtcVariantHandoffs {
  constructor(
    private readonly deps: {
      publication: RetainedPublication;
      sourcePlans: ProductSourcePlans;
    },
  ) {}

  async publish(input: HandoffInput, signal: AbortSignal): Promise<DtcVariantHandoff[]> {
    const requested = input.parsed.identity.variantId;
    const variants = input.parsed.evidence.variants.filter(
      (variant) => requested === null || variant.variantId === requested,
    );
    const results: DtcVariantHandoff[] = [];
    for (const [index, variant] of variants.entries()) {
      signal.throwIfAborted();
      const operationId = `dtc-variant-${sha256(
        Buffer.from(JSON.stringify([input.request.operationId, variant.variantId, index])),
      )}`;
      results.push(await this.member(input, { operationId, variant }, signal));
    }
    const verified = DtcVariantHandoffsSchema.parse(results);
    await this.deps.publication.publish(
      `v3/dtc-agent/${input.request.operationId}/variants.json`,
      Buffer.from(JSON.stringify({ codec: "dtc-variants/1", variants: verified })),
      "application/json",
      signal,
    );
    return verified;
  }

  private async member(
    input: HandoffInput,
    member: Pick<DtcVariantHandoff, "operationId" | "variant">,
    signal: AbortSignal,
  ): Promise<DtcVariantHandoff> {
    let scoped;
    try {
      scoped = await scopedProjection(input, member.variant);
    } catch (error) {
      signal.throwIfAborted();
      return {
        ...member,
        status: "review",
        code: "DTC.VARIANT_EVIDENCE",
        reason: String(error).slice(0, 4000),
        evidence: input.review.evidence,
      };
    }
    const sourcePlan = await this.publishPlan(input, { ...member, scoped }, signal);
    return {
      ...member,
      status: scoped.context.status === "mixed" ? "mixed" : "ready",
      evidence: scoped.context.evidence,
      planned: {
        status: "captured",
        sourcePlan,
        factsComplete: scoped.parsed.facts.complete,
        labelText: scoped.parsed.facts.text,
        family: family(input, scoped.context, member.variant),
      },
    };
  }

  private async publishPlan(
    input: HandoffInput,
    member: Pick<DtcVariantHandoff, "operationId" | "variant"> & {
      scoped: Awaited<ReturnType<typeof scopedProjection>>;
    },
    signal: AbortSignal,
  ) {
    const { scoped } = member;
    // Publication failures stop the handoff; they are not misclassified as source ambiguity.
    const request = { ...input.request, operationId: member.operationId, url: member.variant.url };
    await this.deps.publication.publish(
      `v3/dtc-agent/${member.operationId}/images.json`,
      Buffer.from(
        JSON.stringify({
          version: "dtc-agent-images/1",
          url: request.url,
          images: input.images.filter((image) => scoped.review.galleryUrls.includes(image.url)),
        }),
      ),
      "application/json",
      signal,
    );
    return this.deps.sourcePlans.publish(
      request,
      { parsed: scoped.parsed, planning: input.planning },
      signal,
    );
  }
}

async function scopedProjection(input: HandoffInput, variant: DtcVariantHandoff["variant"]) {
  if (
    !variant.variantId ||
    input.record.variants.filter((item) => item.variantId === variant.variantId).length !== 1
  ) {
    throw new Error("variant_identity_missing_or_duplicate");
  }
  const scoped = await readVariantRecord(input, variant.variantId);
  const parsed = capturedProductProjection({
    ...scoped,
    site: input.site,
    url: variant.url,
    sourceUrl: input.request.sourceUrl,
    variantContextVerified: scoped.context.status === "observed",
    variantStateVerified: true,
  });
  if (
    parsed.identity.variantId !== variant.variantId ||
    parsed.identity.listingId !== variant.listingId
  ) {
    throw new Error("variant_url_identity_conflict");
  }
  return { ...scoped, parsed };
}

function family(
  input: HandoffInput,
  context: Awaited<ReturnType<typeof readVariantRecord>>["context"],
  selected: DtcVariantHandoff["variant"],
) {
  if (context.status !== "observed" || !context.difference) {
    return null;
  }
  const result = ProductFamilySchema.safeParse({
    differsBy: context.difference.kind,
    group: context.difference.group,
    selectedLabel: selected.title,
    members: input.parsed.evidence.variants.map((variant) => ({
      listingId: variant.listingId,
      variantId: variant.variantId,
      url: variant.url,
      label: variant.title,
    })),
  });
  return result.success ? result.data : null;
}
