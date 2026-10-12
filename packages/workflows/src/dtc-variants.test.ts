import { beforeEach, expect, it, vi } from "vitest";
import type { DtcVariantHandoff } from "@crawl-automation/v3-contracts";
import { ProductPipelineInputSchema, ReviewRequestSchema } from "./pipeline-model.js";

const env = vi.hoisted(() => ({
  review: vi.fn(),
  child: vi.fn(),
  capture: vi.fn(),
  collect: vi.fn(),
  patched: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
  proxyActivities: () => ({ reviewProduct: env.review }),
  executeChild: env.child,
  workflowInfo: () => ({ workflowId: "parent" }),
  uuid4: () => "variant-child-id",
  patched: env.patched,
  isCancellation: (error: unknown) => error === "cancelled",
  ParentClosePolicy: { REQUEST_CANCEL: "REQUEST_CANCEL" },
  ChildWorkflowCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
  ActivityCancellationType: { WAIT_CANCELLATION_COMPLETED: "WAIT" },
}));
vi.mock("./browser-product.js", () => ({ collectInBrowser: env.capture }));
vi.mock("./collect-captured-product.js", () => ({
  collectCapturedProduct: env.collect,
  enrichCollectedResult: vi.fn(),
  runProductEnrichment: vi.fn(),
}));
vi.mock("./resources/capture-product.js", () => ({ captureProduct: env.capture }));
vi.mock("./family-product.js", () => ({ collectFamilyProduct: vi.fn() }));

import { collectDtcVariants, DtcVariantWorkflow } from "./dtc-variants.js";
import { ProductPipelineWorkflow } from "./product-pipeline-workflow.js";
import { pipelineFixture } from "./testing/replay/product-fixture.js";

const input = ProductPipelineInputSchema.parse({
  ...pipelineFixture("pipeline").input,
  channel: "dtc",
  capture: "browser",
  url: "https://shop.example/products/sleep?variant=11",
});
const member: DtcVariantHandoff = {
  status: "review",
  operationId: "variant-11",
  code: "DTC.VARIANT_EVIDENCE",
  reason: "missing variant-specific materials",
  evidence: ["retained/capture-review.json", "retained/variant-11.html"],
  variant: {
    listingId: "sleep",
    variantId: "11",
    url: input.url,
    title: "30 capsules",
    available: true,
  },
};
const pipeline = { reviewProduct: env.review } as unknown as Parameters<
  typeof collectDtcVariants
>[1];

beforeEach(() => {
  vi.resetAllMocks();
  env.patched.mockReturnValue(true);
  env.review.mockImplementation(async (raw: unknown) => {
    const request = ReviewRequestSchema.parse(raw);
    return { status: "review", code: request.causeCode, automaticRetry: false };
  });
});

it("keeps each failed member's identity, reason/code and bounded evidence on the existing activity", async () => {
  const variants = [
    member,
    {
      ...member,
      operationId: "variant-22",
      variant: { ...member.variant, variantId: "22" },
      reason: "gallery image unresolved ".repeat(200),
      evidence: Array.from({ length: 25 }, (_, index) => `v3/dtc/${index}/${"e".repeat(150)}.json`),
    },
  ];
  expect(await collectDtcVariants(input, pipeline, variants)).toMatchObject({
    status: "review",
    counts: { total: 2, completed: 0, review: 2 },
    code: "DTC.VARIANTS_INCOMPLETE",
  });
  expect(env.review).toHaveBeenCalledTimes(2);
  expect(env.review.mock.calls[0]?.[0]).toMatchObject({
    causeCode: member.code,
    details: {
      variantId: "11",
      code: member.code,
      reason: member.reason,
      evidenceKeys: member.evidence,
    },
  });
  const details = ReviewRequestSchema.parse(env.review.mock.calls[1]?.[0]).details;
  expect(details?.variantId).toBe("22");
  expect(details?.reason).toHaveLength(200);
  expect(details?.evidenceKeys).toHaveLength(20);
  // A truncated key would point nowhere: keys are kept whole or dropped.
  expect(details?.evidenceKeys?.[0]).toBe(`v3/dtc/0/${"e".repeat(150)}.json`);
  expect(env.child).not.toHaveBeenCalled();
});

it.each(["parent", "variant"])(
  "keeps thrown failure diagnostics in the %s Review",
  async (where) => {
    const captured = await pipelineFixture("pipeline").activities.captureProduct();
    const ready: DtcVariantHandoff = {
      status: "ready",
      operationId: member.operationId,
      variant: member.variant,
      evidence: member.evidence,
      planned: {
        ...captured,
        status: "captured",
        sourcePlan: {
          ...captured.sourcePlan,
          channel: "dtc",
          parserVersion: "dtc-rendered/1",
          owner: { ...captured.sourcePlan.owner, variantId: "11" },
          source: {
            ...captured.sourcePlan.source,
            variantId: "11",
            producer: {
              ...captured.sourcePlan.source.producer,
              module: "dtc.browser-projection",
              implementationVersion: "dtc-rendered/1",
            },
          },
        },
      },
    };
    const error = {
      cause: { type: "DTC.VARIANT_EVIDENCE", details: [{ reason: "retained_variant_mismatch" }] },
    };
    if (where === "parent") {
      env.child.mockRejectedValueOnce(error);
      await collectDtcVariants(input, pipeline, [ready]);
      expect(env.child).toHaveBeenCalledOnce();
    } else {
      env.collect.mockRejectedValueOnce(error);
      await DtcVariantWorkflow({
        input: { ...input, operationId: member.operationId },
        member: ready,
      });
      expect(env.collect).toHaveBeenCalledOnce();
    }
    expect(env.review).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        causeCode: "DTC.VARIANT_EVIDENCE",
        details: expect.objectContaining({
          variantId: "11",
          reason: "retained_variant_mismatch",
          evidenceKeys: member.evidence,
        }),
      }),
    );
  },
);

it.each([
  {
    code: "DTC.PRODUCT_SCOPE_UNRESOLVED",
    raw: {
      decision: { reason: "mixed single and bundle offers" },
      evidence: { objectKey: "scope/result.json" },
    },
    details: { reason: "mixed single and bundle offers", evidenceKeys: ["scope/result.json"] },
  },
  {
    code: "DTC.PRODUCT_SCOPE_UNRESOLVED",
    raw: { reason: "citation_not_in_retained_field" },
    details: { reason: "citation_not_in_retained_field" },
  },
  {
    code: "DTC.CAPTURE_REVIEW",
    raw: {
      result: {
        reasonCode: "gallery_incomplete",
        summary: "One original image failed to download",
      },
      verification: "retained capture incomplete",
    },
    details: {
      code: "gallery_incomplete",
      reason: "One original image failed to download",
      verification: "retained capture incomplete",
    },
  },
])(
  "forwards $code details through the strict activity boundary without extra commands",
  async ({ code, raw, details }) => {
    env.capture.mockRejectedValueOnce({ cause: { type: code, details: [raw] } });
    expect(await ProductPipelineWorkflow(input)).toMatchObject({ status: "review", code });
    expect(env.capture).toHaveBeenCalledOnce();
    expect(env.review).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ causeCode: code, details: expect.objectContaining(details) }),
    );
    expect(env.child).not.toHaveBeenCalled();
    expect(env.collect).not.toHaveBeenCalled();
  },
);
