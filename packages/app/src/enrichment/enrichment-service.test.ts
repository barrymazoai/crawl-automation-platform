import { expect, it, vi } from "vitest";
import type {
  LabelCollectedProduct,
  ReviewRecord,
  SharedEnrichmentRecord,
} from "@crawl-automation/v3-contracts";
import type { EnrichmentDependencies, EnrichmentSource } from "./ports.js";
import { EnrichmentService } from "./enrichment-service.js";

const request = { collectionOperationId: "collected-one", channel: "gnc" as const };
const answer = {
  unifiedName: "Vitamin D",
  baseName: "Vitamin D",
  form: "capsule",
  variant: { count: 60, size: null, flavor: null, strength: null },
  healthFunctions: [],
  confidence: 1,
  notes: null,
};

function setup() {
  const observation = {
    schemaVersion: 1 as const,
    requestId: "request",
    observationId: "observation",
    sourceId: "source",
    brandId: "brand",
    listingId: "listing",
    variantId: null,
  };
  const source: EnrichmentSource = {
    subject: {
      channel: "gnc",
      listingId: "listing",
      variantId: null,
      title: "Vitamin D 60 capsules",
      titleEvidence: null,
      collectionOperationId: request.collectionOperationId,
      observation,
    },
    collection: {
      operationId: request.collectionOperationId,
      observation,
      formula: { servingSize: { text: "1 capsule", sourceId: "label" } },
      otherIngredients: null,
      ingredients: [],
    } as unknown as LabelCollectedProduct,
  };
  const records = new Map<string, SharedEnrichmentRecord>();
  const reviews = new Map<string, ReviewRecord>();
  const objects = new Map<string, Uint8Array>();
  const claims = new Set<string>();
  const deps: EnrichmentDependencies = {
    repository: {
      source: vi.fn(async () => source),
      missing: vi.fn(async () => [request]),
      claim: vi.fn(async (hash) => {
        if (claims.has(hash)) {
          return false;
        }
        claims.add(hash);
        return true;
      }),
      read: vi.fn(async (hash) => records.get(hash) ?? null),
      attach: vi.fn(async () => undefined),
      register: vi.fn(async (record) => {
        records.set(record.inputHash, record);
      }),
    },
    publication: {
      publish: vi.fn(async (key, bytes) => {
        objects.set(key, bytes);
      }),
    },
    remote: { read: vi.fn(async (key) => objects.get(key) ?? null) },
    reviews: {
      read: vi.fn(async (key) => reviews.get(key) ?? null),
      append: vi.fn(async (record) => {
        reviews.set(record.reviewId, record);
      }),
    },
    model: { provider: "codex-app-server/2", interpret: vi.fn(async () => JSON.stringify(answer)) },
  };
  return { deps, source, records, reviews, objects, service: new EnrichmentService(deps) };
}
const signal = () => AbortSignal.timeout(5000);

it("stores immutable evidence and returns the candidate; a second observation reuses by content hash", async () => {
  const state = setup();
  const first = await state.service.run(request, signal());
  expect(first).toMatchObject({ status: "registered", candidate: answer, reused: false });
  state.source.subject.listingId = "linked-product";
  expect(await state.service.run(request, signal())).toMatchObject({
    status: "registered",
    reused: true,
  });
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect(state.deps.repository.attach).toHaveBeenCalledTimes(2);
  expect([...state.objects.keys()].some((key) => key.endsWith("/response.txt"))).toBe(true);
});

it("a concurrent claim loser never runs the model", async () => {
  const state = setup();
  const results = await Promise.all([
    state.service.run(request, signal()),
    state.service.run(request, signal()),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual(["pending", "registered"]);
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
});

it("invalid output is archived, reviewed once, and never retried; collection is retained", async () => {
  const state = setup();
  const original = structuredClone(state.source.collection);
  vi.mocked(state.deps.model.interpret).mockResolvedValue("invalid response");
  const first = await state.service.run(request, signal());
  expect(first).toMatchObject({ status: "review", code: "ENRICH.OUTPUT_INVALID" });
  expect(await state.service.run(request, signal())).toEqual(first);
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect(state.source.collection).toEqual(original);
  expect(
    [...state.objects.values()].some(
      (bytes) => Buffer.from(bytes).toString() === "invalid response",
    ),
  ).toBe(true);
  expect([...state.reviews.values()][0]?.failure.automaticRetry).toBe(false);
  expect([...state.reviews.values()][0]?.failure.executionFact).toBe("executed");
});

it("an uncertain provider failure never runs twice", async () => {
  const state = setup();
  vi.mocked(state.deps.model.interpret).mockRejectedValue(new Error("provider stopped"));
  const result = await state.service.run(request, signal());
  expect(await state.service.run(request, signal())).toEqual(result);
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect([...state.reviews.values()][0]?.rawError.message).toBe("provider stopped");
});

it("a lost insert acknowledgement is reconciled by readback without another call", async () => {
  const state = setup();
  vi.mocked(state.deps.repository.register).mockImplementation(async (record) => {
    state.records.set(record.inputHash, record);
    throw new Error("lost acknowledgement");
  });
  expect(await state.service.run(request, signal())).toMatchObject({ status: "registered" });
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
});

it.each(["record.json", "response.txt", "prompt.json"])(
  "missing %s cannot become success or cause a second model call",
  async (file) => {
    const state = setup();
    await state.service.run(request, signal());
    const record = [...state.records.values()][0];
    if (!record) {
      throw new Error("missing record");
    }
    state.objects.delete(record.evidenceKey.replace("record.json", file));
    expect(await state.service.run(request, signal())).toMatchObject({
      status: "review",
      code: "ENRICH.INTEGRITY",
    });
    expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  },
);
