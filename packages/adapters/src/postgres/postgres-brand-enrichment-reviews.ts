import { randomUUID } from "node:crypto";
import type { BrandEnrichmentReviews, NewDecision } from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import {
  BrandEnrichmentQuestionSchema,
  StoredDecisionSchema,
  type BrandEnrichmentQuestion,
} from "@crawl-automation/v3-contracts";
import { storeErrors } from "../errors.js";

const decisionColumns = `id AS "decisionId", run_id AS "runId", verdict, owner_company_id AS "ownerCompanyId",
  kind, confidence, reason, signals, decided_by AS "decidedBy", sent, spot_check AS "spotCheck",
  created_at AS "createdAt"`;
const questionColumns = `id AS "questionId", run_id AS "runId", kind, question, state, answer,
  created_at AS "createdAt"`;

const toDecision = (row: unknown) => StoredDecisionSchema.parse(row);
const toQuestion = (row: unknown) => BrandEnrichmentQuestionSchema.parse(row);

/** Reviewer decisions and questions for a person (migration 058); never sent to Supply Smart. */
export class PostgresBrandEnrichmentReviews implements BrandEnrichmentReviews {
  constructor(private readonly database: Database) {}

  async addDecision(decision: NewDecision) {
    const rows = await this.database.query(
      `INSERT INTO brand_enrichment_decision
         (id, run_id, verdict, owner_company_id, kind, confidence, reason, signals, decided_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) RETURNING ${decisionColumns}`,
      [
        randomUUID(),
        decision.runId,
        decision.verdict,
        decision.ownerCompanyId,
        decision.kind,
        decision.confidence,
        decision.reason,
        JSON.stringify(decision.signals),
        decision.decidedBy,
      ],
    );
    return toDecision(rows[0]);
  }

  async markDecisionSent(decisionId: string, sent: Record<string, unknown>) {
    await this.database.query(
      "UPDATE brand_enrichment_decision SET sent = $2::jsonb WHERE id = $1 AND sent IS NULL",
      [decisionId, JSON.stringify(sent)],
    );
  }

  async decisions(runId: string) {
    const rows = await this.database.query(
      `SELECT ${decisionColumns} FROM brand_enrichment_decision WHERE run_id = $1 ORDER BY created_at`,
      [runId],
    );
    return rows.map(toDecision);
  }

  async recordSpotCheck(decisionId: string, check: Record<string, unknown>) {
    const rows = await this.database.query(
      `UPDATE brand_enrichment_decision SET spot_check = $2::jsonb WHERE id = $1 RETURNING ${decisionColumns}`,
      [decisionId, JSON.stringify(check)],
    );
    if (!rows[0]) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", { details: { decisionId } });
    }
    return toDecision(rows[0]);
  }

  async addQuestion(
    runId: string,
    kind: BrandEnrichmentQuestion["kind"],
    question: Record<string, unknown>,
  ) {
    const rows = await this.database.query(
      `INSERT INTO brand_enrichment_question (id, run_id, kind, question) VALUES ($1, $2, $3, $4::jsonb)
       RETURNING ${questionColumns}`,
      [randomUUID(), runId, kind, JSON.stringify(question)],
    );
    return toQuestion(rows[0]);
  }

  async questions(filter: { state?: string; runId?: string; limit: number }) {
    const rows = await this.database.query(
      `SELECT ${questionColumns} FROM brand_enrichment_question
       WHERE ($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR run_id = $2)
       ORDER BY created_at LIMIT $3`,
      [filter.state ?? null, filter.runId ?? null, filter.limit],
    );
    return rows.map(toQuestion);
  }

  async answerQuestion(
    questionId: string,
    state: "answered" | "dismissed",
    answer: Record<string, unknown>,
  ) {
    const rows = await this.database.query(
      `UPDATE brand_enrichment_question SET state = $2, answer = $3::jsonb, answered_at = clock_timestamp()
       WHERE id = $1 AND state = 'open' RETURNING ${questionColumns}`,
      [questionId, state, JSON.stringify(answer)],
    );
    if (!rows[0]) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", {
        details: { questionId, state: "not open" },
      });
    }
    return toQuestion(rows[0]);
  }
}
