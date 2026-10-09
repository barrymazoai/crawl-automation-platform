import type { z } from "zod";
import type { BrandEnrichmentReviews, BrandEnrichmentRuns, SupplySmartCompanies } from "./ports.js";
import type { AnswerBrandQuestionSchema } from "./api-model.js";
import type { CompanyLink } from "@crawl-automation/v3-contracts";
import { brandEnrichmentErrors } from "./errors.js";
import { requireRun, requireCompanyRun } from "./run-records.js";

type Answer = z.infer<typeof AnswerBrandQuestionSchema>;
/** Human commands: only the explicitly selected link/check is written; merge never runs implicitly. */
export class BrandQuestionService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      reviews: BrandEnrichmentReviews;
      companies: SupplySmartCompanies;
    },
  ) {}
  async answer(input: Answer, signal: AbortSignal) {
    const question = await this.question(input);
    const { answer } = input;
    if (answer.action === "merge") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.MERGE_NOT_WIRED");
    }
    if (answer.action !== "dismiss" && question.kind === "identity") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
    }
    if (answer.action !== "dismiss" && !(await this.apply(input, signal))) {
      return { applied: false, conflict: true };
    }
    const answered = await this.deps.reviews.answerQuestion(
      question.questionId,
      answer.action === "dismiss" ? "dismissed" : "answered",
      answer,
    );
    if (answer.action !== "dismiss") {
      const run = await requireRun(this.deps.runs, input.runId);
      await this.deps.runs.update(run.runId, {
        summary: {
          ...run.summary,
          ownership: answer.action === "link" ? "has_parent" : "independent",
        },
      });
    }
    return { applied: true, question: answered };
  }
  private async question(input: Answer) {
    const question = (await this.deps.reviews.questions({ runId: input.runId, limit: 1000 })).find(
      (item) => item.questionId === input.questionId,
    );
    if (!question) {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.NOT_FOUND");
    }
    if (question.state !== "open") {
      throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
    }
    return question;
  }
  private async apply(input: Answer, signal: AbortSignal) {
    const run = await requireCompanyRun(this.deps.runs, input.runId);
    const { answer } = input;
    if (answer.action === "link") {
      // Family conflicts are attached to the root; the proposed child link is read from the stored question.
      const question = await this.question(input);
      const proposed = question.question["link"] as Partial<CompanyLink> | undefined;
      const from = proposed?.fromCompanyId ?? run.companyId;
      if (answer.link.fromCompanyId !== from || answer.link.toCompanyId === from) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_MATCH");
      }
      const result = await this.deps.companies.link(answer.link, signal);
      if (result.status === "conflict") {
        return false;
      }
      await this.deps.companies.recordOwnershipCheck(
        { companyId: from, result: "has_parent", signals: ["human_answer"] },
        signal,
      );
    }
    if (answer.action === "independent") {
      const status = await this.deps.companies.ownershipStatus(run.companyId, signal);
      if (status.owners.length) {
        throw brandEnrichmentErrors.create("BRAND_ENRICHMENT.INVALID_STATE");
      }
      await this.deps.companies.recordOwnershipCheck(
        { companyId: run.companyId, result: "independent", signals: ["human_answer"] },
        signal,
      );
    }
    return true;
  }
}
