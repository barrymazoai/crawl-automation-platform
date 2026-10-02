import type { ChannelRegistry } from "@crawl-automation/channels-core";
import type { ArtifactResolver } from "@crawl-automation/platform";
import { enrichmentErrors } from "@crawl-automation/processing";
import type {
  ChannelProductEvidence,
  EnrichmentRequest,
  EnrichmentSubject,
} from "@crawl-automation/v3-contracts";

/** Reads the title through the channel's existing projection decoder, with verified artifact ownership. */
export class EnrichmentTitleReader {
  constructor(
    private readonly registry: ChannelRegistry,
    private readonly artifacts: Pick<ArtifactResolver, "resolve">,
  ) {}

  async read(request: EnrichmentRequest, subject: EnrichmentSubject, signal: AbortSignal) {
    const plan = request.sourcePlan;
    if (!plan) {
      return subject;
    }
    if (
      plan.channel !== subject.channel ||
      plan.owner.listingId !== subject.listingId ||
      plan.owner.variantId !== subject.variantId ||
      (request.captureOperationId &&
        plan.source.producer.operationId !== request.captureOperationId)
    ) {
      throw enrichmentErrors.create("ENRICH.INTEGRITY");
    }
    const saved = await this.artifacts.resolve(plan.source, plan.owner, signal);
    const planning = this.registry.get(subject.channel).planning;
    if (!planning) {
      throw enrichmentErrors.create("ENRICH.INPUT_MISSING");
    }
    const product = planning.read(
      JSON.parse(Buffer.from(saved.bytes).toString()),
      plan.expectedUrl,
      plan.owner,
    );
    const evidence = { sourceId: plan.source.objectKey, sha256: plan.source.sha256 };
    const variant = websiteVariant(product.evidence, subject);
    const result: EnrichmentSubject = {
      ...subject,
      title: product.evidence.title,
      titleEvidence: evidence,
    };
    if (variant) {
      result.websiteVariant = { ...variant, evidence };
    } else {
      delete result.websiteVariant;
    }
    return result;
  }
}

function websiteVariant(product: ChannelProductEvidence, subject: EnrichmentSubject) {
  if (subject.channel !== "dtc") {
    return null;
  }
  const variants =
    subject.variantId === null
      ? product.variants
      : product.variants.filter((entry) => entry.variantId === subject.variantId);
  const variant = variants.length === 1 ? variants[0] : null;
  if (!variant || variant.listingId !== subject.listingId) {
    return null;
  }
  return {
    protocol: "website-variant/1" as const,
    variantId: variant.variantId,
    title: variant.title,
    options: product.variantOptions,
  };
}
