import { randomUUID } from "node:crypto";
import type {
  ApolloTry,
  BrandEnrichmentRunChange,
  BrandEnrichmentRuns,
  NewBrandEnrichmentRun,
  StepOutput,
} from "@crawl-automation/app";
import type { Database } from "@crawl-automation/platform";
import {
  BrandEnrichmentRunSchema,
  OwnershipClueSchema,
  type OwnershipClue,
} from "@crawl-automation/v3-contracts";
import { latestProductAttemptSql } from "./brand-product-attempt-sql.js";
import { storeErrors } from "../errors.js";

const runColumns = `id AS "runId", request_id AS "requestId", parent_run_id AS "parentRunId", role,
  brand_name AS "brandName", brand_url AS "brandUrl", company_id AS "companyId", workflow_id AS "workflowId",
  state, stage, summary, failure_reason AS "failureReason", created_at AS "createdAt", updated_at AS "updatedAt"`;

const toRun = (row: unknown) => BrandEnrichmentRunSchema.parse(row);

/** Brand enrichment runs, steps, clues and Apollo tries (migration 058). */
export class PostgresBrandEnrichmentRuns implements BrandEnrichmentRuns {
  constructor(private readonly database: Database) {}

  async create(run: NewBrandEnrichmentRun) {
    const inserted = await this.database.query(
      `INSERT INTO brand_enrichment_run (id, request_id, parent_run_id, role, brand_name, brand_url, workflow_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (request_id) WHERE state IN ('running', 'waiting_for_person') DO NOTHING
       RETURNING ${runColumns}`,
      [
        run.runId,
        run.requestId,
        run.parentRunId,
        run.role,
        run.brandName,
        run.brandUrl,
        run.workflowId,
      ],
    );
    if (inserted[0]) {
      return { run: toRun(inserted[0]), created: true };
    }
    const live = await this.database.query(
      `SELECT ${runColumns} FROM brand_enrichment_run
       WHERE request_id = $1 AND state IN ('running', 'waiting_for_person')`,
      [run.requestId],
    );
    if (!live[0]) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", { details: { runId: run.runId } });
    }
    return { run: toRun(live[0]), created: false };
  }

  async get(runId: string) {
    const rows = await this.database.query(
      `SELECT ${runColumns} FROM brand_enrichment_run WHERE id = $1`,
      [runId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  async list(filter: { state?: string; parentRunId?: string; limit: number }) {
    const rows = await this.database.query(
      `SELECT ${runColumns} FROM brand_enrichment_run
       WHERE ($1::text IS NULL OR state = $1) AND ($2::uuid IS NULL OR parent_run_id = $2)
       ORDER BY created_at DESC LIMIT $3`,
      [filter.state ?? null, filter.parentRunId ?? null, filter.limit],
    );
    return rows.map(toRun);
  }

  async update(runId: string, change: BrandEnrichmentRunChange) {
    const rows = await this.database.query(
      `UPDATE brand_enrichment_run SET
         state = COALESCE($2, state),
         stage = COALESCE($3, stage),
         company_id = COALESCE($4::uuid, company_id),
         summary = COALESCE($5::jsonb, summary),
         failure_reason = COALESCE($6, failure_reason),
         updated_at = clock_timestamp()
       WHERE id = $1 RETURNING ${runColumns}`,
      [
        runId,
        change.state ?? null,
        change.stage ?? null,
        change.companyId ?? null,
        change.summary ? JSON.stringify(change.summary) : null,
        change.failureReason ?? null,
      ],
    );
    if (!rows[0]) {
      throw storeErrors.create("STORE.UNEXPECTED_ROW", { details: { runId } });
    }
    return toRun(rows[0]);
  }

  async saveStep(step: StepOutput) {
    await this.database.query(
      `INSERT INTO brand_enrichment_step (run_id, step, output, archive_keys) VALUES ($1, $2, $3::jsonb, $4::jsonb)
       ON CONFLICT (run_id, step) DO NOTHING`,
      [step.runId, step.step, JSON.stringify(step.output), JSON.stringify(step.archiveKeys)],
    );
    return this.step(step.runId, step.step);
  }

  async step(runId: string, step: string) {
    const rows = await this.database.query<{ output: unknown }>(
      "SELECT output FROM brand_enrichment_step WHERE run_id = $1 AND step = $2",
      [runId, step],
    );
    return rows[0]?.output ?? null;
  }

  async latestProductAttempt(runId: string) {
    const rows = await this.database.query<{ attempt: number }>(`${latestProductAttemptSql}$1`, [
      runId,
    ]);
    return rows[0]?.attempt ?? 1;
  }

  async addClues(runId: string, clues: OwnershipClue[]) {
    for (const clue of clues.map((clue) => OwnershipClueSchema.parse(clue))) {
      await this.database.query(
        `INSERT INTO brand_enrichment_clue
           (id, run_id, signal, owner_name, owner_domain, owner_company_id, quote, url, archive_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          randomUUID(),
          runId,
          clue.signal,
          clue.ownerName,
          clue.ownerDomain,
          clue.ownerCompanyId,
          clue.quote,
          clue.url,
          clue.archiveKey,
        ],
      );
    }
  }

  async clues(runId: string) {
    const rows = await this.database.query(
      `SELECT signal, owner_name AS "ownerName", owner_domain AS "ownerDomain",
         owner_company_id AS "ownerCompanyId", quote, url, archive_key AS "archiveKey"
       FROM brand_enrichment_clue WHERE run_id = $1 ORDER BY created_at, id`,
      [runId],
    );
    return rows.map((row) => OwnershipClueSchema.parse(row));
  }

  async recordApolloTry(runId: string, attempt: ApolloTry) {
    await this.database.query(
      `INSERT INTO brand_enrichment_apollo_try (run_id, attempt, query, organization_ids)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)`,
      [
        runId,
        attempt.attempt,
        JSON.stringify(attempt.query),
        JSON.stringify(attempt.organizationIds),
      ],
    );
  }

  async apolloTries(runId: string) {
    const rows = await this.database.query<{ tries: number }>(
      "SELECT count(*)::int AS tries FROM brand_enrichment_apollo_try WHERE run_id = $1",
      [runId],
    );
    return rows[0]?.tries ?? 0;
  }
}
