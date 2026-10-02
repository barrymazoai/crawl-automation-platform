import { expect, it, vi } from "vitest";
import { sha256 } from "@crawl-automation/platform";
import {
  decodeEnrichment,
  enrichmentInput,
  ENRICHMENT_RESPONSE_BYTES,
} from "@crawl-automation/processing";
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

it("keeps a prior enrichment immutable when verified website variant content arrives", async () => {
  const state = setup();
  state.source.subject.channel = "dtc";
  state.source.subject.title = "Vitamin D";
  vi.mocked(state.deps.model.interpret).mockResolvedValueOnce(
    JSON.stringify({ ...answer, variant: { ...answer.variant, count: null } }),
  );
  const first = await state.service.run({ ...request, channel: "dtc" }, signal());
  expect(first).toMatchObject({ status: "registered", candidate: { variant: { count: null } } });
  const original = structuredClone([...state.records.values()][0]);
  state.source.subject.websiteVariant = {
    protocol: "website-variant/1",
    variantId: "sixty",
    title: "60 capsules",
    options: [],
    evidence: { sourceId: "retained-projection", sha256: "a".repeat(64) },
  };
  const second = await state.service.run({ ...request, channel: "dtc" }, signal());
  expect(second).toMatchObject({
    status: "registered",
    reused: false,
    candidate: { variant: { count: 60 } },
  });
  expect(state.records.size).toBe(2);
  expect([...state.records.values()][0]).toEqual(original);
  expect([...state.records.values()][1]?.subject.websiteVariant).toEqual(
    state.source.subject.websiteVariant,
  );
  expect(state.deps.model.interpret).toHaveBeenLastCalledWith(
    expect.objectContaining({ prompt: expect.stringContaining('"title":"60 capsules"') }),
    expect.any(AbortSignal),
  );
});

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
  const review = [...state.reviews.values()][0];
  expect(review?.rawError.details).toMatchObject({ reason: "schema" });
  expect(review?.candidate).toEqual({
    schema: "text-raw-response/1",
    value: {
      rawResponse: "invalid response",
      truncated: false,
      byteSize: Buffer.byteLength("invalid response"),
      sha256: sha256(Buffer.from("invalid response")),
    },
  });
  const saved = state.objects.get(review?.failure.evidenceKey ?? "");
  expect(saved && JSON.parse(Buffer.from(saved).toString())).toEqual(review);
});

it("keeps the refused answer and exact reason, so it can be decoded without another model call", async () => {
  const state = setup();
  const response = JSON.stringify({ ...answer, baseName: "Vitamin miracle" });
  vi.mocked(state.deps.model.interpret).mockResolvedValue(response);
  const result = await state.service.run(request, signal());
  expect(result.status).toBe("review");
  const review = [...state.reviews.values()][0];
  const prepared = enrichmentInput(state.source.collection, state.source.subject.title);
  expect(review?.rawError.details).toMatchObject({
    reason: "unsupported-word:baseName:miracle",
    inputKey: `v3/product-enrichment/${prepared.inputHash}/input.json`,
    responseKey: `v3/product-enrichment/${prepared.inputHash}/response.txt`,
  });
  const value = review?.candidate?.value as { rawResponse: string };
  expect(value.rawResponse).toBe(response);
  const prefix = `v3/product-enrichment/${prepared.inputHash}`;
  const inputBytes = state.objects.get(`${prefix}/input.json`);
  const responseBytes = state.objects.get(`${prefix}/response.txt`);
  const savedInput = JSON.parse(Buffer.from(inputBytes ?? []).toString());
  const savedResponse = Buffer.from(responseBytes ?? []).toString();
  expect(savedInput.input).toEqual(prepared.input);
  expect(savedResponse).toBe(response);
  expect(() => decodeEnrichment(savedResponse, savedInput.input)).toThrow(
    expect.objectContaining({ details: { reason: "unsupported-word:baseName:miracle" } }),
  );
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect(state.deps.repository.register).not.toHaveBeenCalled();
});

it("persists and reuses warnings without changing notes, raw answers or collected formula", async () => {
  const state = setup();
  const original = structuredClone(state.source.collection);
  const response = JSON.stringify({ ...answer, form: "liquid", notes: "Check dosage form" });
  vi.mocked(state.deps.model.interpret).mockResolvedValue(response);
  const first = await state.service.run(request, signal());
  const candidate = {
    ...answer,
    form: "unknown",
    notes: "Check dosage form",
    warnings: ["form-not-printed:liquid"],
  };
  expect(first).toMatchObject({ status: "registered", candidate, reused: false });
  const record = [...state.records.values()][0];
  expect(record?.candidate).toEqual(candidate);
  const saved = state.objects.get(record?.evidenceKey ?? "");
  expect(JSON.parse(Buffer.from(saved ?? []).toString()).candidate).toEqual(candidate);
  const rawAnswerSaved = [...state.objects.values()].some(
    (bytes) => Buffer.from(bytes).toString() === response,
  );
  expect(rawAnswerSaved).toBe(true);
  expect(await state.service.run(request, signal())).toMatchObject({
    status: "registered",
    candidate,
    reused: true,
  });
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect(state.source.collection).toEqual(original);
  expect(state.reviews.size).toBe(0);
});

it.each(["input.json", "response.txt"])(
  "does not claim that unconfirmed %s was saved or retry the failed operation",
  async (file) => {
    const state = setup();
    vi.mocked(state.deps.publication.publish).mockImplementation(async (key, bytes) => {
      if (key.endsWith(`/${file}`)) {
        throw new Error("publication unconfirmed");
      }
      state.objects.set(key, bytes);
    });
    const outcome = await state.service.run(request, signal());
    expect(outcome.status).toBe("review");
    expect(await state.service.run(request, signal())).toEqual(outcome);
    const review = [...state.reviews.values()][0];
    expect(review?.rawError.details).toMatchObject({
      inputKey: file === "input.json" ? null : expect.stringMatching(/\/input.json$/u),
      responseKey: null,
    });
    expect(review?.candidate).toBeNull();
    expect(review?.failure.automaticRetry).toBe(false);
    expect(state.deps.model.interpret).toHaveBeenCalledTimes(file === "input.json" ? 0 : 1);
    expect(state.deps.repository.register).not.toHaveBeenCalled();
  },
);

it("bounds an oversized UTF-8 answer in the Review and marks it truncated", async () => {
  const state = setup();
  const response = "a".repeat(ENRICHMENT_RESPONSE_BYTES - 1) + "🍊";
  vi.mocked(state.deps.model.interpret).mockResolvedValue(response);
  const result = await state.service.run(request, signal());
  expect(result).toMatchObject({ status: "review", code: "ENRICH.OUTPUT_INVALID" });
  const review = [...state.reviews.values()][0];
  expect(review?.rawError.details).toMatchObject({ reason: "too-large" });
  const value = review?.candidate?.value as { rawResponse: string; truncated: boolean };
  expect(value.truncated).toBe(true);
  expect(value.rawResponse).toBe("a".repeat(ENRICHMENT_RESPONSE_BYTES - 1));
  expect(Buffer.byteLength(value.rawResponse)).toBeLessThanOrEqual(ENRICHMENT_RESPONSE_BYTES);
  expect(
    [...state.objects.values()].some((bytes) => Buffer.from(bytes).toString() === response),
  ).toBe(true);
  expect(await state.service.run(request, signal())).toEqual(result);
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
});

it("an uncertain provider failure never runs twice", async () => {
  const state = setup();
  vi.mocked(state.deps.model.interpret).mockRejectedValue(new Error("provider stopped"));
  const result = await state.service.run(request, signal());
  expect(await state.service.run(request, signal())).toEqual(result);
  expect(state.deps.model.interpret).toHaveBeenCalledTimes(1);
  expect([...state.reviews.values()][0]?.rawError.message).toBe("provider stopped");
  expect([...state.reviews.values()][0]?.candidate).toBeNull();
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
