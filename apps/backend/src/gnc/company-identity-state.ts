import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CompanyIdentityInput, CompanyIdentityVerdict, GncSearchEvidence } from "./company-identity.js";

export type CompanyIdentityStatus = "pending" | "processing" | "no_match" | "confirmed" | "review" | "error";

export class GncCompanyIdentityState {
  private readonly db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma busy_timeout=5000;
      create table if not exists company_identity_task (
        company_id text primary key,
        company_name text not null,
        canonical_name text,
        website text,
        status text not null default 'pending',
        attempts integer not null default 0,
        search_evidence_json text,
        verdict_json text,
        error_message text,
        available_at text not null,
        updated_at text not null
      );
      create index if not exists company_identity_task_status_idx
        on company_identity_task(status,available_at,updated_at);
    `);
  }

  seed(companies: CompanyIdentityInput[]) {
    const statement = this.db.prepare(`insert into company_identity_task(
      company_id,company_name,canonical_name,website,available_at,updated_at
    ) values(?,?,?,?,?,?) on conflict(company_id) do update set
      company_name=excluded.company_name,
      canonical_name=excluded.canonical_name,
      website=excluded.website`);
    const now = new Date().toISOString();
    this.db.exec("begin immediate");
    try {
      for (const company of companies) statement.run(company.companyId, company.companyName, company.canonicalName, company.website, now, now);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  recoverInterrupted() {
    const now = new Date().toISOString();
    this.db.prepare("update company_identity_task set status='pending',available_at=?,updated_at=? where status='processing'").run(now, now);
  }

  claim(): CompanyIdentityInput | null {
    this.db.exec("begin immediate");
    try {
      const now = new Date().toISOString();
      const row = this.db.prepare(`select company_id,company_name,canonical_name,website
        from company_identity_task where status='pending' and available_at<=?
        order by attempts,updated_at,company_id limit 1`).get(now) as {
          company_id: string; company_name: string; canonical_name: string | null; website: string | null;
        } | undefined;
      if (!row) { this.db.exec("commit"); return null; }
      const claimed = this.db.prepare(`update company_identity_task set
        status='processing',attempts=attempts+1,error_message=null,updated_at=?
        where company_id=? and status='pending'`).run(now, row.company_id);
      this.db.exec("commit");
      if (Number(claimed.changes) !== 1) return null;
      return { companyId: row.company_id, companyName: row.company_name, canonicalName: row.canonical_name, website: row.website };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  record(companyId: string, status: Extract<CompanyIdentityStatus, "no_match" | "confirmed" | "review">, evidence: GncSearchEvidence[], verdict: CompanyIdentityVerdict) {
    this.db.prepare(`update company_identity_task set status=?,search_evidence_json=?,verdict_json=?,
      error_message=null,updated_at=? where company_id=?`).run(
      status,
      JSON.stringify(evidence),
      JSON.stringify(verdict),
      new Date().toISOString(),
      companyId,
    );
  }

  recordError(companyId: string, message: string, retryAfterMs: number, maxAttempts: number) {
    const row = this.db.prepare("select attempts from company_identity_task where company_id=?").get(companyId) as { attempts: number } | undefined;
    const retry = Number(row?.attempts ?? maxAttempts) < maxAttempts;
    const now = new Date();
    const available = new Date(now.getTime() + retryAfterMs).toISOString();
    this.db.prepare(`update company_identity_task set status=?,error_message=?,available_at=?,updated_at=? where company_id=?`).run(
      retry ? "pending" : "error",
      message.slice(0, 4000),
      available,
      now.toISOString(),
      companyId,
    );
  }

  summary() {
    const rows = this.db.prepare("select status,count(*) count from company_identity_task group by status").all() as Array<{ status: CompanyIdentityStatus; count: number }>;
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count)])) as Partial<Record<CompanyIdentityStatus, number>>;
  }

  nextAvailableAt() {
    const row = this.db.prepare("select min(available_at) value from company_identity_task where status='pending'").get() as { value: string | null } | undefined;
    return row?.value ?? null;
  }

  listRecent(limit = 20) {
    const rows = this.db.prepare(`select company_id,company_name,status,verdict_json,error_message,updated_at
      from company_identity_task order by updated_at desc limit ?`).all(limit) as Array<{
        company_id: string; company_name: string; status: CompanyIdentityStatus;
        verdict_json: string | null; error_message: string | null; updated_at: string;
      }>;
    return rows.map((row) => ({
      companyId: row.company_id,
      companyName: row.company_name,
      status: row.status,
      verdict: row.verdict_json ? JSON.parse(row.verdict_json) : null,
      error: row.error_message,
      updatedAt: row.updated_at,
    }));
  }

  close() { this.db.close(); }
}
