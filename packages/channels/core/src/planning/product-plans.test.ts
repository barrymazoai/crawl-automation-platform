import { createHash } from "node:crypto";
import type { ArtifactRef, ChannelPlanInput } from "@crawl-automation/v3-contracts";
import { describe, expect, it } from "vitest";
import type { ChannelAdapter, ChannelPlanning, ParsedProduct, PlannedProduct } from "../adapter.js";
import { ChannelRegistry } from "../registry.js";
import { ProductSourcePlans } from "../pipeline/source-plans.js";
import type { CaptureRequest, PlanSettings } from "../pipeline/capture-request.js";
import type { PlanObjectStore, PlanPublication } from "./plan-ports.js";
import { ProductPlans } from "./product-plans.js";

class MemoryStore implements PlanObjectStore {
  readonly data = new Map<string, Uint8Array>();
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async create(key: string, bytes: Uint8Array) {
    this.data.set(key, Buffer.from(bytes));
    return "created";
  }
}

class MemoryPublication implements PlanPublication {
  readonly local = new MemoryStore();
  readonly remote = new MemoryStore();
  async retain(key: string, bytes: Uint8Array) {
    await this.local.create(key, bytes);
  }
  async publish(key: string, bytes: Uint8Array) {
    await this.remote.create(key, bytes);
  }
}

const verifyBytes = (ref: ArtifactRef, bytes: Uint8Array) => {
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== ref.byteSize || hash !== ref.sha256) {
    throw Object.assign(new Error("integrity"), { code: "ARTIFACT.INTEGRITY" });
  }
};

const table =
  "<table><tr><td>Serving Size 2 Softgels</td></tr><tr><td>EPA</td><td>650 mg</td></tr></table>" +
  "<p>Other Ingredients: fish oil, gelatin</p>";
const image = (name: string) => ({
  url: `https://www.gnc.com/on/demandware.static/${name}`,
  variantId: null,
  basis: "product-gallery" as const,
  verifiedOriginal: false as const,
});
const evidence = (facts: string | null) => ({
  codec: "channel-product/1" as const,
  channel: "gnc" as const,
  listingId: "877080",
  variantId: null,
  url: "https://www.gnc.com/fish-oil/877080.html",
  title: "Fish Oil",
  brandRaw: "GNC",
  variantOptions: [],
  variants: [],
  detailsHtml: null,
  factsCandidates: facts
    ? [{ field: "facts", html: facts, scope: "selected-product" as const }]
    : [],
  imageCandidates: [image("front.jpg"), image("label.pdf"), image("back.jpg")],
  warnings: [],
});

/** A GNC-like channel whose projection is the evidence plus the facts verdict the adapter would give. */
function planning(complete: boolean): ChannelPlanning {
  return {
    channel: "gnc",
    parserVersion: "gnc-rendered/1",
    projectionModule: "gnc.http-projection",
    projection: (rendered) => rendered,
    read: (projection): PlannedProduct => ({
      evidence: projection as PlannedProduct["evidence"],
      facts: { text: null, complete, missing: complete ? [] : ["FACTS.TEXT_MISSING"] },
    }),
  };
}

const settings: PlanSettings = {
  text: {
    schemaVersion: 1,
    module: "codex.text",
    implementationVersion: "codex-text/2",
    policyVersion: "anchored/2",
    resultSchemaVersion: 2,
    configFingerprint: "a".repeat(64),
  },
  ocr: {
    schemaVersion: 1,
    module: "ocr.file",
    implementationVersion: "1",
    policyVersion: "1",
    resultSchemaVersion: 2,
    configFingerprint: "b".repeat(64),
  },
  visionConfigFingerprint: "c".repeat(64),
  egressId: "scraperapi-us/1",
  factsPolicy: "text-facts-first/1",
};
const request = {
  runId: "7b0c6a52-3a47-4f5b-9a4e-4c3c1f0a9d11",
  channel: "gnc" as const,
  url: "https://www.gnc.com/fish-oil/877080.html",
  brandId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  sourceId: "1a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  operationId: "pipeline-capture-1",
};
const signal = () => AbortSignal.timeout(5_000);

async function setup(input: {
  facts: string | null;
  complete: boolean;
  channel?: CaptureRequest["channel"];
  sourceOrder?: PlanSettings["sourceOrder"];
  images?: ReturnType<typeof image>[];
}) {
  const publication = new MemoryPublication();
  const hooks = planning(input.complete);
  const adapter = { id: "gnc", planning: hooks } as unknown as ChannelAdapter;
  const registry = new ChannelRegistry([adapter]);
  const product = evidence(input.facts);
  product.imageCandidates = input.images ?? product.imageCandidates;
  const parsed = { rendered: product, identity: { listingId: "877080", variantId: null } };
  const sourcePlans = new ProductSourcePlans(publication as never, {
    ...settings,
    sourceOrder: input.sourceOrder ?? {},
  });
  const plan = await sourcePlans.publish(
    { ...request, channel: input.channel ?? request.channel },
    { parsed: parsed as unknown as ParsedProduct, planning: hooks },
    signal(),
  );
  const resolver = {
    resolve: async (ref: ArtifactRef) => ({
      ref,
      bytes: publication.remote.data.get(ref.objectKey) ?? new Uint8Array(),
    }),
  };
  const ledger = new Map<string, unknown>();
  const reviews = {
    read: async (id: string) => (ledger.get(id) as never) ?? null,
    append: async (record: { reviewId: string }) => void ledger.set(record.reviewId, record),
  };
  const deps = { registry, publication, resolver, reviews, integrity: { verifyBytes } };
  return { plans: new ProductPlans(deps), plan, publication, ledger };
}

const kinds = (outcome: Awaited<ReturnType<ProductPlans["run"]>>) =>
  outcome.status === "prepared"
    ? outcome.manifest.sources.map((source) => [source.kind, source.required])
    : [];

describe("formula planner (text facts first)", () => {
  it.each([
    ["amazon", "images-first"],
    ["wholefoods", "images-first"],
    ["gnc", "text-first"],
    ["swanson", "text-first"],
    ["costco", "text-first"],
    ["dtc", "text-first"],
  ] as const)("persists the default source policy for new %s plans", async (channel, order) => {
    const { plan } = await setup({ facts: table, complete: true, channel });
    expect(plan.sourcePolicy).toEqual({ version: "label-sources/1", order });
    expect(plan).not.toHaveProperty("sourceOrder");
  });

  it.each(["amazon", "wholefoods"] as const)(
    "applies the Amazon config override to %s formulas",
    async (channel) => {
      const { plan } = await setup({
        facts: table,
        complete: true,
        channel,
        sourceOrder: { amazon: "text-first" },
      });
      expect(plan.sourcePolicy?.order).toBe("text-first");
    },
  );

  it("keeps inactive image fallbacks in a new complete-text plan", async () => {
    const { plans, plan } = await setup({ facts: table, complete: true });
    const input = { ...plan, sourcePolicy: { version: "label-sources/1", order: "text-first" } };
    expect(kinds(await plans.run(input, signal()))).toEqual([
      ["page", true],
      ["file-image", false],
      ["file-image", false],
    ]);
    expect((await plans.inspect(input, signal()))?.labelPreparation).toEqual({
      pageHasLabelSection: true,
      pageFactsComplete: true,
    });
  });

  it("does not admit marketing-only page text in a new source plan", async () => {
    const { plans, plan } = await setup({
      facts: "<p>Premium formula supports health</p>",
      complete: false,
    });
    const input = { ...plan, sourcePolicy: { version: "label-sources/1", order: "images-first" } };
    await plans.run(input, signal());
    expect((await plans.inspect(input, signal()))?.labelPreparation?.pageHasLabelSection).toBe(
      false,
    );
  });
  it("keeps an old saved plan text-only when its facts are complete", async () => {
    const { plans, plan } = await setup({ facts: table, complete: true });
    const { sourcePolicy: _policy, ...legacyPlan } = plan;
    const outcome = await plans.run(legacyPlan, signal());
    expect(kinds(outcome)).toEqual([["page", true]]);
  });

  it("keeps the images (PDFs left out) when the facts are incomplete", async () => {
    const { plans, plan } = await setup({ facts: table, complete: false });
    const outcome = await plans.run(plan, signal());
    expect(outcome.status).toBe("prepared");
    const ids =
      outcome.status === "prepared" ? outcome.manifest.sources.map((source) => source.id) : [];
    // The PDF at position 1 is not planned, and the image after it keeps its own position.
    expect(ids).toEqual(["page", "image-0", "image-2"]);
  });

  it.each(["badge.svg", "badge.SVG?v=1"])(
    "skips unsupported %s without blocking the next label or changing its operation ID",
    async (badge) => {
      const images = [image("front.jpg"), image(badge), image("facts.png"), image("image?id=4")];
      const { plans, plan } = await setup({ facts: null, complete: false, images });
      const outcome = await plans.run(plan, signal());
      expect(outcome.status).toBe("prepared");
      const saved = await plans.inspect(plan, signal());
      expect(saved?.product.imageCandidates).toEqual(images);
      expect(saved?.manifest.sources.map((source) => source.id)).toEqual([
        "image-0",
        "image-2",
        "image-3",
      ]);
      expect(saved?.files.map((file) => file.url)).toEqual([
        images[0]?.url,
        images[2]?.url,
        images[3]?.url,
      ]);
      expect(await plans.run(plan, signal())).toEqual(outcome);
    },
  );

  it("answers the same saved plan again and gives each planned image its URL", async () => {
    const { plans, plan } = await setup({ facts: null, complete: false });
    const first = await plans.run(plan, signal());
    expect(await plans.run(plan, signal())).toEqual(first);
    const saved = await plans.inspect(plan, signal());
    const file = saved?.manifest.sources.find((source) => source.kind === "file-image");
    const acquire = file?.kind === "file-image" ? file.plan.acquire : null;
    expect(await plans.fileSource(plan as ChannelPlanInput, acquire, signal())).toBe(
      "https://www.gnc.com/on/demandware.static/front.jpg",
    );
  });

  it("records a passive Review with the planning code and never replays it", async () => {
    const { plans, plan, publication, ledger } = await setup({ facts: null, complete: false });
    publication.remote.data.delete(plan.source.objectKey);
    const review = await plans.run(plan, signal());
    expect(review).toMatchObject({ status: "review", automaticRetry: false });
    expect(ledger.size).toBe(1);
    expect(await plans.run(plan, signal())).toEqual(review);
  });
});
