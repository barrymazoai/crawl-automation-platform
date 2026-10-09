import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import type {
  Company,
  BrandEnrichmentQuestion,
  StoredDecision,
  BrandResearch,
  FamilyFinding,
} from "@crawl-automation/v3-contracts";
import type { SupplySmartCompanies, BrandRequests, BrandEnrichmentReviews } from "../ports.js";
import { brandEnrichmentErrors } from "../errors.js";
export const signal = new AbortController().signal;
export const research: BrandResearch = {
  description: "Nutrition products",
  category: "nutrition",
  keywords: ["nutrition"],
  legalName: null,
  address: null,
  linkedinUrl: null,
  clues: [],
  checkedUrls: ["https://example.test/about"],
  evidence: [],
  archiveKeys: [],
};
export const family: FamilyFinding = {
  landedUrl: "https://example.test",
  catalogUrl: null,
  redirect: null,
  isNutrition: true,
  shape: "single",
  subBrands: [],
  otherDomains: [],
  clues: [],
  archiveKeys: [],
};

export function companies() {
  const records = new Map<string, Company>();
  return {
    ...companyIdentity(records),
    addDomains: vi.fn<SupplySmartCompanies["addDomains"]>(async () => ({
      added: [],
      existing: [],
      conflicts: [],
      skipped: [],
    })),
    enrich: vi.fn<SupplySmartCompanies["enrich"]>(async (input) => ({
      matched: true,
      companyId: input.companyId,
      updatedFields: ["description"],
      skippedFields: [],
      categories: { added: 1, existing: 0 },
      contacts: { inserted: 0, skipped: 0 },
      apolloOrganizationHeldBy: null,
      routed: [],
    })),
    link: vi.fn<SupplySmartCompanies["link"]>(async () => ({
      status: "linked",
      result: { status: "created", relationshipId: randomUUID(), apolloOrganizationMoved: null },
    })),
    unlink: vi.fn<SupplySmartCompanies["unlink"]>(async () => ({ status: "removed" })),
    recordOwnershipCheck: vi.fn<SupplySmartCompanies["recordOwnershipCheck"]>(
      async () => undefined,
    ),
    ownershipStatus: vi.fn<SupplySmartCompanies["ownershipStatus"]>(async () => ({
      latestCheck: null,
      owners: [],
    })),
  } satisfies SupplySmartCompanies;
}
function companyIdentity(records: Map<string, Company>) {
  return {
    resolveDomain: vi.fn<SupplySmartCompanies["resolveDomain"]>(async () => ({
      status: "unmatched",
      companyId: null,
      companyName: null,
      candidates: [],
      reason: "none",
    })),
    resolve: vi.fn<SupplySmartCompanies["resolve"]>(async () => ({
      status: "unmatched",
      companyId: null,
      matchedBy: null,
      matches: [],
      reason: "none",
    })),
    get: vi.fn<SupplySmartCompanies["get"]>(
      async (id) => records.get(id) ?? { id, name: "Example", website: "https://example.test" },
    ),
    create: vi.fn<SupplySmartCompanies["create"]>(async (input) => {
      const result = { id: randomUUID(), ...input, website: input.website ?? null };
      records.set(result.id, result);
      return result;
    }),
  };
}
export function requests() {
  return {
    pending: vi.fn<BrandRequests["pending"]>(async () => []),
    update: vi.fn<BrandRequests["update"]>(async () => ({ claimed: true })),
  };
}
export function reviews() {
  const questions: BrandEnrichmentQuestion[] = [];
  const decisions: StoredDecision[] = [];
  return {
    ...decisionLedger(decisions),
    ...questionLedger(questions),
  } satisfies BrandEnrichmentReviews;
}
function decisionLedger(decisions: StoredDecision[]) {
  return {
    addDecision: vi.fn<BrandEnrichmentReviews["addDecision"]>(async (input) => {
      const decision = {
        ...input,
        decisionId: randomUUID(),
        sent: null,
        spotCheck: null,
        createdAt: new Date(),
      };
      decisions.push(decision);
      return decision;
    }),
    markDecisionSent: vi.fn<BrandEnrichmentReviews["markDecisionSent"]>(async () => undefined),
    decisions: vi.fn<BrandEnrichmentReviews["decisions"]>(async (runId) =>
      decisions.filter((item) => item.runId === runId),
    ),
    recordSpotCheck: vi.fn<BrandEnrichmentReviews["recordSpotCheck"]>(async (id, check) => {
      const decision = decisions.find((item) => item.decisionId === id);
      if (!decision) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND");
      }
      return { ...decision, spotCheck: check };
    }),
  };
}
function questionLedger(questions: BrandEnrichmentQuestion[]) {
  return {
    addQuestion: vi.fn<BrandEnrichmentReviews["addQuestion"]>(async (runId, kind, question) => {
      const result: BrandEnrichmentQuestion = {
        runId,
        kind,
        question,
        questionId: randomUUID(),
        state: "open",
        answer: null,
        createdAt: new Date(),
      };
      questions.push(result);
      return result;
    }),
    questions: vi.fn<BrandEnrichmentReviews["questions"]>(async (filter) =>
      questions.filter(
        (item) =>
          (!filter.runId || item.runId === filter.runId) &&
          (!filter.state || item.state === filter.state),
      ),
    ),
    answerQuestion: vi.fn<BrandEnrichmentReviews["answerQuestion"]>(async (id, state, answer) => {
      const question = questions.find((item) => item.questionId === id);
      if (!question) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND");
      }
      Object.assign(question, { state, answer });
      return question;
    }),
  };
}
