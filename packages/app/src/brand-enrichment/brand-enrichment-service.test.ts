import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrandEnrichmentService } from "./brand-enrichment-service.js";
import { BrandIdentityService } from "./identity-service.js";
import { BrandCloseService } from "./close-service.js";
import { BrandQuestionService } from "./question-service.js";
import { AnswerBrandQuestionSchema } from "./api-model.js";
import { companies, reviews, requests, signal } from "./testing/fakes.js";
import { memoryRuns, seededRuns } from "./testing/memory-runs.js";

it("a Supply Smart 409 cannot create or start a local run", async () => {
  const store = memoryRuns();
  const request = requests();
  const requestId = randomUUID();
  request.pending.mockResolvedValue([
    {
      id: requestId,
      brandName: "Example",
      brandUrl: "https://example.test",
      companyId: null,
      status: "pending",
      failureReason: null,
      summary: null,
    },
  ]);
  request.update.mockResolvedValue({ claimed: false });
  const gateway = {
    startProductsRetry: vi.fn(),
    describeProductsRetry: vi.fn(),
    start: vi.fn(),
    cancel: vi.fn(),
    describe: vi.fn(),
  };
  const service = new BrandEnrichmentService({
    runs: store.runs,
    requests: request,
    reviews: reviews(),
    companies: companies(),
    gateway,
  });
  await expect(service.start({ requestId }, signal)).rejects.toMatchObject({
    code: "BRAND_ENRICHMENT.CLAIM_CONFLICT",
  });
  expect(store.runs.create).not.toHaveBeenCalled();
  expect(gateway.start).not.toHaveBeenCalled();
});
it("ambiguous identity fails without guessing or creating a company", async () => {
  const store = await seededRuns();
  const run = await store.runs.get(store.runId);
  if (!run) {
    throw new Error("fixture missing");
  }
  store.records.set(store.runId, { ...run, companyId: null });
  const company = companies();
  company.resolveDomain.mockResolvedValue({
    status: "ambiguous",
    companyId: null,
    companyName: null,
    candidates: [],
    reason: "two candidates",
  });
  await expect(
    new BrandIdentityService({ ...store, companies: company }).resolve(store.runId, signal),
  ).rejects.toMatchObject({ code: "BRAND_ENRICHMENT.IDENTITY_UNRESOLVED" });
  expect(company.create).not.toHaveBeenCalled();
});
it.each(["sub_brand", "owner"] as const)(
  "closing a %s child never closes or emails a Supply Smart request",
  async (role) => {
    const store = await seededRuns(role);
    const request = requests();
    await new BrandCloseService({ ...store, requests: request, companies: companies() }).close(
      { runId: store.runId, state: "completed" },
      signal,
    );
    expect(request.update).not.toHaveBeenCalled();
    expect(await store.runs.get(store.runId)).toMatchObject({ state: "completed" });
  },
);
it("a human ownership answer writes exactly the chosen link and does not choose a merge", async () => {
  const store = await seededRuns();
  const review = reviews();
  const company = companies();
  const question = await review.addQuestion(store.runId, "ownership", { reason: "uncertain" });
  const link = {
    fromCompanyId: store.companyId,
    toCompanyId: randomUUID(),
    kind: "brand_of" as const,
    confidence: 1,
  };
  await new BrandQuestionService({ ...store, reviews: review, companies: company }).answer(
    {
      runId: store.runId,
      questionId: question.questionId,
      answer: { action: "link", link, reason: "verified" },
    },
    signal,
  );
  expect(company.link).toHaveBeenCalledWith(link, signal);
  expect(company.recordOwnershipCheck).toHaveBeenCalledWith(
    { companyId: store.companyId, result: "has_parent", signals: ["human_answer"] },
    signal,
  );
  expect(question.state).toBe("answered");
});
it("rejects merge commands while old merge questions remain dismissible", async () => {
  const store = await seededRuns();
  const review = reviews();
  const company = companies();
  const question = await review.addQuestion(store.runId, "merge", {});
  expect(() =>
    AnswerBrandQuestionSchema.parse({
      runId: store.runId,
      questionId: question.questionId,
      answer: {
        action: "merge",
        fromCompanyId: store.companyId,
        toCompanyId: randomUUID(),
        reason: "duplicate",
      },
    }),
  ).toThrow();
  await new BrandQuestionService({ ...store, reviews: review, companies: company }).answer(
    {
      runId: store.runId,
      questionId: question.questionId,
      answer: { action: "dismiss", reason: "Never merge" },
    },
    signal,
  );
  expect(question.state).toBe("dismissed");
  expect(company.link).not.toHaveBeenCalled();
  expect(company.enrich).not.toHaveBeenCalled();
});

it("exposes automatic ownership records through get without creating questions", async () => {
  const store = await seededRuns();
  const retained = {
    "ownership-unresolved": { verdict: "cannot_tell" },
    "ownership-conflict": { detail: "existing owner" },
  };
  for (const [step, output] of Object.entries(retained)) {
    await store.runs.saveStep({ runId: store.runId, step, output, archiveKeys: [] });
  }
  const service = new BrandEnrichmentService({
    ...store,
    requests: requests(),
    reviews: reviews(),
    companies: companies(),
    gateway: {
      startProductsRetry: vi.fn(),
      describeProductsRetry: vi.fn(),
      start: vi.fn(),
      cancel: vi.fn(),
      describe: vi.fn(async () => null),
    },
  });
  expect(await service.get({ runId: store.runId })).toMatchObject({
    steps: retained,
    questions: [],
  });
});

it("omits old waiting_for_person ownership from the outgoing completion summary", async () => {
  const store = await seededRuns();
  await store.runs.saveStep({
    runId: store.runId,
    step: "ownership",
    output: "waiting_for_person",
    archiveKeys: [],
  });
  const request = requests();
  await new BrandCloseService({ ...store, requests: request, companies: companies() }).close(
    { runId: store.runId, state: "completed" },
    signal,
  );
  expect(request.update).toHaveBeenCalledWith(
    expect.objectContaining({ summary: { profile: "missing" }, status: "completed" }),
    signal,
  );
});
