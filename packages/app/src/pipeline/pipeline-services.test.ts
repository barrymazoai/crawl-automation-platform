import { swansonAdapter } from "@crawl-automation/channel-swanson";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { swansonPipelineFixture } from "@crawl-automation/channel-swanson";
import type { ReviewRecord } from "@crawl-automation/v3-contracts";
import type { ProductPipelineInput } from "@crawl-automation/workflows";
import { describe, expect, it, vi } from "vitest";
import { LabelHandoffs } from "./label-handoffs.js";
import { ProductReviews } from "./product-reviews.js";

const signal = () => AbortSignal.timeout(5000);
const registry = new ChannelRegistry([swansonAdapter]);

const pipeline: ProductPipelineInput = {
  codec: "product-pipeline/1",
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "swanson",
  url: "https://www.swansonvitamins.com/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
  queues: { activities: "pipeline", plan: "plan", label: "label" },
  resources: {
    queue: "resource",
    activities: { captureProduct: [{ resourceId: "swanson-http-lane", units: 1 }] },
    maxWaitSeconds: 900,
  },
};

const queueNames = [
  "plan",
  "page",
  "pageText",
  "imagePrepare",
  "ocr",
  "ocrReceipts",
  "keywords",
  "core",
  "source",
  "manifest",
  "text",
  "textReceipts",
  "vision",
  "assembly",
  "collection",
  "review",
];

function evidenceStore() {
  const saved = new Map<string, Uint8Array>();
  const publish = vi.fn(async (key: string, bytes: Uint8Array) => {
    saved.set(key, bytes);
  });
  return { saved, publish };
}

describe("LabelHandoffs", () => {
  async function setup(planned: unknown = { manifest: {} }) {
    const fixture = await swansonPipelineFixture(signal());
    const { sourcePlan } = fixture;
    const evidence = evidenceStore();
    const executions = { register: vi.fn(async () => undefined) };
    const handoffs = new LabelHandoffs({
      registry,
      plans: { inspect: async () => planned },
      evidence,
      executions,
      settings: {
        text: {
          ...fixture.settings.text,
          resultSchemaVersion: 3,
          implementationVersion: "codex-text/3",
        },
        visionConfigFingerprint: "d".repeat(64),
        evidencePolicy: "label-image-first/3",
        queues: Object.fromEntries(queueNames.map((name) => [name, name])) as never,
        resources: { queue: "resource", activities: {}, maxWaitSeconds: 900 },
      },
    });
    const execution = { clusterId: "c", namespace: "n", workflowId: "w", runId: "r" };
    return { handoffs, sourcePlan, evidence, executions, execution };
  }

  it("builds the label input with the channel's core step, keeps it, and links the run", async () => {
    const { handoffs, sourcePlan, evidence, executions, execution } = await setup();

    const handoff = await handoffs.prepare({ pipeline, sourcePlan, execution }, signal());

    expect(handoff.input.corePolicy).toBe("swanson-label-core/1");
    expect(handoff.input.sourcePlan).toEqual(sourcePlan);
    expect(evidence.saved.has("v3/product-runs/pipeline-capture-1/label.json")).toBe(true);
    expect(executions.register).toHaveBeenCalledWith(sourcePlan.owner.observationId, execution);
  });

  it("refuses when the formula plan is not saved", async () => {
    const { handoffs, sourcePlan, execution } = await setup(null);

    await expect(
      handoffs.prepare({ pipeline, sourcePlan, execution }, signal()),
    ).rejects.toMatchObject({ code: "PIPELINE.PLAN_UNVERIFIED" });
  });
});

describe("ProductReviews", () => {
  function setup() {
    const rows = new Map<string, ReviewRecord>();
    const reviews = {
      read: vi.fn(async (id: string) => rows.get(id) ?? null),
      append: vi.fn(async (record: ReviewRecord) => rows.set(record.reviewId, record)),
    };
    const evidence = evidenceStore();
    return { reviews, evidence, service: new ProductReviews({ registry, evidence, reviews }) };
  }

  it("records the real cause code and its category", async () => {
    const { service, reviews } = setup();

    const review = await service.review(
      { pipeline, code: "PIPELINE.PRODUCT_UNRESOLVED", causeCode: "SCRAPERAPI.PROVIDER_FAILURE" },
      signal(),
    );

    expect(review).toMatchObject({ status: "review", code: "SCRAPERAPI.PROVIDER_FAILURE" });
    const record = reviews.append.mock.calls[0]?.[0];
    expect(record?.failure.category).toBe("SOURCE");
    expect(record?.observation?.listingId).toBe("healthy-origins-natural-d-ribose-10-6-oz-pwdr");
  });

  it("keeps the pipeline code when the failure had none, and writes one Review per product", async () => {
    const { service, reviews } = setup();
    const request = { pipeline, code: "PIPELINE.PRODUCT_UNRESOLVED", causeCode: null };

    const first = await service.review(request, signal());
    const second = await service.review(request, signal());

    expect(first.code).toBe("PIPELINE.PRODUCT_UNRESOLVED");
    expect(second).toEqual(first);
    expect(reviews.append).toHaveBeenCalledOnce();
  });
});
