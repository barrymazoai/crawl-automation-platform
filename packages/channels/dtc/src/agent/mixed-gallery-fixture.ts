import { expect } from "vitest";
import { DtcMixedGallery } from "./mixed-gallery.js";
import { variantCaptureFixture } from "./variant-capture-fixture.js";
const signal = new AbortController().signal;
export async function prepareMixedGallery(
  fixture: Awaited<ReturnType<typeof variantCaptureFixture>>,
) {
  const { input } = fixture;
  input.review.variantContexts = fixture.contexts.map((context) => ({
    status: "mixed",
    basis: "variant-state",
    variantId: context.variantId,
    methodPath: context.methodPath,
    galleryUrls: input.record.gallery.map((image) => image.url),
    reason: "URL changes but both Facts remain in the carousel",
    evidence: context.evidence,
  }));
  await fixture.preflight();
  const variants = await fixture.publish();
  expect(variants.map((member) => member.status)).toEqual(["mixed", "mixed"]);
  const sourcePlan = await fixture.sourcePlans.publish(
    input.request,
    { parsed: input.parsed, planning: input.planning },
    signal,
  );
  await fixture.publication.publish(
    `v3/dtc-agent/${input.request.operationId}/images.json`,
    Buffer.from(
      JSON.stringify({
        version: "dtc-agent-images/1",
        url: input.request.url,
        images: input.images,
      }),
    ),
    "application/json",
    signal,
  );
  const gallery = new DtcMixedGallery(fixture.publication);
  const prepared = await gallery.prepare({ sourcePlan, variants }, signal);
  return { gallery, prepared, variants, task: await gallery.task(prepared.task, signal) };
}
