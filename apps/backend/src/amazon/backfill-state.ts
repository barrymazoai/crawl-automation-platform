import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type BackfillLaneStatus = "pending" | "processing" | "ready" | "review" | "failed";
export type FormulaLaneStatus = "waiting" | BackfillLaneStatus;
export type BackfillJoinStatus = "waiting" | "ready" | "review";
export type StagingLaneStatus = "pending" | "processing" | "ready" | "review" | "failed";
export type FormulaRecoveryStatus = "pending" | "processing" | "ready" | "review" | "failed";

export interface BackfillSeed {
  productId: string;
  source: unknown;
  hasFormula: boolean;
  hasExistingOcrText: boolean;
  imageCount: number;
}

export interface BackfillTask<T = unknown> {
  productId: string;
  source: T;
  textStatus: BackfillLaneStatus;
  imageStatus: BackfillLaneStatus;
  formulaStatus: FormulaLaneStatus;
  joinStatus: BackfillJoinStatus;
  textResult: unknown;
  imageResult: unknown;
  review: unknown;
  stagingStatus: StagingLaneStatus;
  stagingResult: unknown;
}

function parseJson(value: unknown) {
  if (typeof value !== "string" || !value) return null;
  return JSON.parse(value) as unknown;
}

export class AmazonBackfillState {
  private db: DatabaseSync;

  constructor(filename: string) {
    fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      pragma journal_mode=WAL;
      pragma busy_timeout=5000;
      create table if not exists product_task (
        product_id text primary key,
        source_json text not null,
        text_status text not null default 'pending',
        image_status text not null,
        join_status text not null default 'waiting',
        text_result_json text,
        image_result_json text,
        review_json text,
        text_attempts integer not null default 0,
        image_attempts integer not null default 0,
        updated_at text not null
      );
      create index if not exists product_task_text_status_idx on product_task(text_status, updated_at);
      create index if not exists product_task_image_status_idx on product_task(image_status, updated_at);
      create index if not exists product_task_join_status_idx on product_task(join_status, updated_at);
      create table if not exists formula_task (
        product_id text primary key,
        status text not null default 'waiting',
        source text,
        evidence_file text,
        result_json text,
        review_json text,
        attempts integer not null default 0,
        updated_at text not null
      );
      create index if not exists formula_task_status_idx on formula_task(status, updated_at);
      create table if not exists review_queue (
        product_id text not null,
        lane text not null,
        status text not null default 'pending',
        reason_json text,
        result_json text,
        updated_at text not null,
        primary key(product_id,lane)
      );
      create index if not exists review_queue_status_idx on review_queue(status, updated_at);
      create table if not exists formula_recovery (
        product_id text primary key,
        status text not null default 'pending',
        result_json text,
        review_json text,
        attempts integer not null default 0,
        updated_at text not null
      );
      create index if not exists formula_recovery_status_idx on formula_recovery(status, updated_at);
      create table if not exists backfill_state_meta (key text primary key,value text not null);
      insert into formula_task(product_id,status,source,evidence_file,updated_at)
      select product_id,
        case json_extract(image_result_json,'$.source')
          when 'existing_formula' then 'ready'
          when 'existing_ocr_text' then 'pending'
          when 'ocr_facts_candidates' then 'pending'
          else 'waiting'
        end,
        json_extract(image_result_json,'$.source'),
        json_extract(image_result_json,'$.evidenceFile'),
        updated_at
      from product_task
      where true
      on conflict(product_id) do nothing;
      insert into review_queue(product_id,lane,reason_json,updated_at)
      select product_id,'text',json_extract(review_json,'$.text'),updated_at
      from product_task where text_status in ('review','failed')
      on conflict(product_id,lane) do nothing;
      insert into review_queue(product_id,lane,reason_json,updated_at)
      select product_id,'image',json_extract(review_json,'$.image'),updated_at
      from product_task where image_status in ('review','failed')
      on conflict(product_id,lane) do nothing;
    `);
    const productColumns = new Set((this.db.prepare("pragma table_info(product_task)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!productColumns.has("staging_status")) this.db.exec("alter table product_task add column staging_status text not null default 'pending'");
    if (!productColumns.has("staging_result_json")) this.db.exec("alter table product_task add column staging_result_json text");
    if (!productColumns.has("staging_attempts")) this.db.exec("alter table product_task add column staging_attempts integer not null default 0");
    this.db.exec("create index if not exists product_task_staging_status_idx on product_task(staging_status,join_status,updated_at)");
    const formulaJoinMigration = this.db.prepare("select value from backfill_state_meta where key='formula_join_v1'").get();
    if (!formulaJoinMigration) {
      this.refreshAllJoins();
      this.db.prepare("insert into backfill_state_meta(key,value) values('formula_join_v1',?)").run(new Date().toISOString());
    }
  }

  seed(input: BackfillSeed) {
    const now = new Date().toISOString();
    const imageStatus: BackfillLaneStatus = input.hasFormula || input.hasExistingOcrText
      ? "ready"
      : input.imageCount > 0
        ? "pending"
        : "review";
    const imageResult = input.hasFormula
      ? { source: "existing_formula" }
      : input.hasExistingOcrText
        ? { source: "existing_ocr_text" }
        : null;
    const review = imageStatus === "review" ? { image: { reasons: ["no_images"] } } : null;
    const inserted = this.db.prepare(`insert into product_task(
      product_id,source_json,image_status,image_result_json,review_json,updated_at
    ) values(?,?,?,?,?,?) on conflict(product_id) do nothing`).run(
      input.productId,
      JSON.stringify(input.source),
      imageStatus,
      imageResult ? JSON.stringify(imageResult) : null,
      review ? JSON.stringify(review) : null,
      now,
    );
    if (Number(inserted.changes) > 0) {
      this.ensureFormulaTask(input.productId, input.hasFormula ? "ready" : input.hasExistingOcrText ? "pending" : "waiting", input.hasFormula ? "existing_formula" : input.hasExistingOcrText ? "existing_ocr_text" : null, null);
      if (imageStatus === "review") this.upsertReview(input.productId, "image", review?.image, null);
      this.refreshJoin(input.productId);
    }
  }

  recoverInterrupted(lane: "all" | "text" | "image" | "formula" | "staging" = "all") {
    const now = new Date().toISOString();
    if (lane === "all" || lane === "text") this.db.prepare("update product_task set text_status='pending',updated_at=? where text_status='processing'").run(now);
    if (lane === "all" || lane === "image") this.db.prepare("update product_task set image_status='pending',updated_at=? where image_status='processing'").run(now);
    if (lane === "all" || lane === "formula") this.db.prepare("update formula_task set status='pending',updated_at=? where status='processing'").run(now);
    if (lane === "all" || lane === "staging") this.db.prepare("update product_task set staging_status='pending',updated_at=? where staging_status='processing'").run(now);
  }

  claimText(limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare("select product_id,source_json from product_task where text_status='pending' order by case when text_attempts>0 then 0 else 1 end,updated_at,product_id limit ?")
        .all(limit) as Array<{ product_id: string; source_json: string }>;
      const now = new Date().toISOString();
      const claim = this.db.prepare("update product_task set text_status='processing',text_attempts=text_attempts+1,updated_at=? where product_id=? and text_status='pending'");
      for (const row of rows) claim.run(now, String(row.product_id));
      this.db.exec("commit");
      return rows.map((row) => ({ productId: row.product_id, source: JSON.parse(row.source_json) as unknown }));
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  retryText(productId: string) {
    const row = this.db.prepare("select review_json from product_task where product_id=?")
      .get(productId) as { review_json: string | null } | undefined;
    if (!row) return false;
    const existing = parseJson(row.review_json);
    const review = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown> }
      : {};
    delete review.text;
    this.db.prepare("delete from review_queue where product_id=? and lane='text'").run(productId);
    this.db.prepare(`update product_task set text_status='pending',text_result_json=null,review_json=?,updated_at=? where product_id=?`).run(
      JSON.stringify(review),
      new Date().toISOString(),
      productId,
    );
    this.refreshJoin(productId);
    return true;
  }

  listReadyTextResults(limit = 100_000) {
    const rows = this.db.prepare("select product_id,text_result_json from product_task where text_status='ready' and text_result_json is not null order by product_id limit ?")
      .all(limit) as Array<{ product_id: string; text_result_json: string }>;
    return rows.map((row) => ({ productId: row.product_id, result: JSON.parse(row.text_result_json) as unknown }));
  }

  claimImage(limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare(`select product_id,source_json from product_task
        where image_status='pending'
        order by case when text_status='ready' then 0 else 1 end,updated_at,product_id
        limit ?`)
        .all(limit) as Array<{ product_id: string; source_json: string }>;
      const now = new Date().toISOString();
      const claim = this.db.prepare("update product_task set image_status='processing',image_attempts=image_attempts+1,updated_at=? where product_id=? and image_status='pending'");
      for (const row of rows) claim.run(now, row.product_id);
      this.db.exec("commit");
      return rows.map((row) => ({ productId: row.product_id, source: JSON.parse(row.source_json) as unknown }));
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  retryImage(productId: string) {
    const row = this.db.prepare("select review_json from product_task where product_id=?")
      .get(productId) as { review_json: string | null } | undefined;
    if (!row) return false;
    const existing = parseJson(row.review_json);
    const review = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown> }
      : {};
    delete review.image;
    this.db.prepare("delete from review_queue where product_id=? and lane='image'").run(productId);
    this.db.prepare(`update product_task set image_status='pending',image_result_json=null,review_json=?,updated_at=? where product_id=?`).run(
      JSON.stringify(review),
      new Date().toISOString(),
      productId,
    );
    this.refreshJoin(productId);
    return true;
  }

  recordText(productId: string, status: "ready" | "review" | "failed", result: unknown, review?: unknown) {
    const now = new Date().toISOString();
    this.db.prepare(`update product_task set text_status=?,text_result_json=?,review_json=?,updated_at=? where product_id=?`).run(
      status,
      result == null ? null : JSON.stringify(result),
      JSON.stringify(this.mergeReview(productId, "text", review)),
      now,
      productId,
    );
    this.syncReview(productId, "text", status, review, result);
    this.refreshJoin(productId);
  }

  recordImage(productId: string, status: "ready" | "review" | "failed", result: unknown, review?: unknown) {
    const now = new Date().toISOString();
    this.db.prepare(`update product_task set image_status=?,image_result_json=?,review_json=?,updated_at=? where product_id=?`).run(
      status,
      result == null ? null : JSON.stringify(result),
      JSON.stringify(this.mergeReview(productId, "image", review)),
      now,
      productId,
    );
    const value = result && typeof result === "object" ? result as Record<string, unknown> : null;
    if (status === "ready" && value?.source === "ocr_facts_candidates") {
      this.ensureFormulaTask(productId, "pending", "ocr_facts_candidates", typeof value.evidenceFile === "string" ? value.evidenceFile : null, true);
    }
    this.syncReview(productId, "image", status, review, result);
    this.refreshJoin(productId);
  }

  claimFormula(limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare(`select product_id,source,evidence_file from formula_task
        where status='pending' order by case when attempts>0 then 0 else 1 end,updated_at,product_id limit ?`)
        .all(limit) as Array<{ product_id: string; source: string | null; evidence_file: string | null }>;
      const now = new Date().toISOString();
      const claim = this.db.prepare("update formula_task set status='processing',attempts=attempts+1,updated_at=? where product_id=? and status='pending'");
      for (const row of rows) claim.run(now, row.product_id);
      this.db.exec("commit");
      return rows.map((row) => ({ productId: row.product_id, source: row.source, evidenceFile: row.evidence_file }));
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  recordFormula(productId: string, status: "ready" | "review" | "failed", result: unknown, review?: unknown) {
    this.db.prepare(`update formula_task set status=?,result_json=?,review_json=?,updated_at=? where product_id=?`).run(
      status,
      result == null ? null : JSON.stringify(result),
      review == null ? null : JSON.stringify(review),
      new Date().toISOString(),
      productId,
    );
    this.syncReview(productId, "formula", status, review, result);
    this.refreshJoin(productId);
  }

  seedFormulaRecovery(limit: number) {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`select f.product_id
      from formula_task f join product_task p on p.product_id=f.product_id
      where f.status='review' and f.evidence_file is not null
        and p.text_status='ready' and p.image_status='ready'
        and json_extract(p.staging_result_json,'$.targetProductId') is not null
        and not exists(select 1 from formula_recovery r where r.product_id=f.product_id)
      order by f.updated_at,f.product_id limit ?`).all(limit) as Array<{ product_id: string }>;
    const insert = this.db.prepare("insert into formula_recovery(product_id,status,updated_at) values(?,'pending',?) on conflict(product_id) do nothing");
    for (const row of rows) insert.run(row.product_id, now);
    return rows.map((row) => row.product_id);
  }

  recoverInterruptedFormulaRecovery() {
    return Number(this.db.prepare("update formula_recovery set status='pending',updated_at=? where status='processing'")
      .run(new Date().toISOString()).changes);
  }

  claimFormulaRecovery(limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare(`select r.product_id,f.evidence_file
        from formula_recovery r join formula_task f on f.product_id=r.product_id
        where r.status='pending' and f.status='review' and f.evidence_file is not null
        order by r.updated_at,r.product_id limit ?`).all(limit) as Array<{ product_id: string; evidence_file: string }>;
      const claim = this.db.prepare("update formula_recovery set status='processing',attempts=attempts+1,updated_at=? where product_id=? and status='pending'");
      const now = new Date().toISOString();
      for (const row of rows) claim.run(now, row.product_id);
      this.db.exec("commit");
      return rows.map((row) => ({ productId: row.product_id, evidenceFile: row.evidence_file }));
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  recordFormulaRecovery(productId: string, status: "ready" | "review" | "failed", result: unknown, review?: unknown) {
    const update = this.db.prepare(`update formula_recovery set status=?,result_json=?,review_json=?,updated_at=?
      where product_id=? and status='processing'`).run(
      status,
      result == null ? null : JSON.stringify(result),
      review == null ? null : JSON.stringify(review),
      new Date().toISOString(),
      productId,
    );
    return Number(update.changes) > 0;
  }

  acceptFormulaRecovery(productId: string, formulaResult: unknown, recoveryResult: unknown) {
    this.db.exec("begin immediate");
    try {
      const now = new Date().toISOString();
      const accepted = this.db.prepare(`update formula_task set status='ready',result_json=?,review_json=null,updated_at=?
        where product_id=? and status='review'`).run(JSON.stringify(formulaResult), now, productId);
      if (Number(accepted.changes) !== 1) throw new Error(`formula_recovery_source_not_review:${productId}`);
      this.db.prepare("delete from review_queue where product_id=? and lane='formula'").run(productId);
      this.refreshJoin(productId);
      const staging = this.db.prepare(`update product_task set staging_status='pending',staging_result_json=null,updated_at=?
        where product_id=? and join_status='ready' and staging_status in ('review','failed')`).run(now, productId);
      const recovery = this.db.prepare(`update formula_recovery set status='ready',result_json=?,review_json=null,updated_at=?
        where product_id=? and status='processing'`).run(JSON.stringify(recoveryResult), now, productId);
      if (Number(recovery.changes) !== 1) throw new Error(`formula_recovery_not_processing:${productId}`);
      this.db.exec("commit");
      return { stagingRetried: Number(staging.changes) > 0 };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  formulaRecoverySummary() {
    const rows = this.db.prepare("select status,count(*) count from formula_recovery group by status order by status")
      .all() as Array<{ status: string; count: number }>;
    return rows.map((row) => ({ status: row.status as FormulaRecoveryStatus, count: Number(row.count) }));
  }

  claimStaging(limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare(`select p.product_id,p.source_json,p.text_result_json,p.image_result_json,
          p.review_json,p.join_status,f.result_json formula_result_json,f.source formula_source,
          f.review_json formula_review_json
        from product_task p left join formula_task f on f.product_id=p.product_id
        where p.staging_status='pending' and p.join_status in ('ready','review')
        order by case p.join_status when 'ready' then 0 else 1 end,p.updated_at,p.product_id limit ?`)
        .all(limit) as Array<Record<string, unknown>>;
      const now = new Date().toISOString();
      const claim = this.db.prepare("update product_task set staging_status='processing',staging_attempts=staging_attempts+1,updated_at=? where product_id=? and staging_status='pending'");
      for (const row of rows) claim.run(now, String(row.product_id));
      this.db.exec("commit");
      return rows.map((row) => {
        const productReview = parseJson(row.review_json);
        const formulaReview = parseJson(row.formula_review_json);
        const review = productReview && typeof productReview === "object" && !Array.isArray(productReview)
          ? { ...productReview as Record<string, unknown> }
          : {};
        if (formulaReview != null) review.formula = formulaReview;
        return ({
        productId: String(row.product_id),
        source: parseJson(row.source_json),
        textResult: parseJson(row.text_result_json),
        imageResult: parseJson(row.image_result_json),
        formulaResult: parseJson(row.formula_result_json),
        formulaSource: row.formula_source == null ? null : String(row.formula_source),
        review,
        joinStatus: String(row.join_status) as BackfillJoinStatus,
        });
      });
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  recordStaging(productId: string, status: "ready" | "review" | "failed", result: unknown) {
    this.db.prepare("update product_task set staging_status=?,staging_result_json=?,updated_at=? where product_id=?").run(
      status,
      result == null ? null : JSON.stringify(result),
      new Date().toISOString(),
      productId,
    );
  }

  retryStaging(productId: string) {
    const result = this.db.prepare(`update product_task set staging_status='pending',staging_result_json=null,updated_at=?
      where product_id=? and join_status='ready' and staging_status in ('review','failed')`).run(
      new Date().toISOString(),
      productId,
    );
    return Number(result.changes) > 0;
  }

  retryStagingByReason(reason: string, limit: number) {
    this.db.exec("begin immediate");
    try {
      const rows = this.db.prepare(`select product_id from product_task
        where join_status='ready' and staging_status='review'
          and exists(select 1 from json_each(staging_result_json,'$.reasons') where value=?)
        order by updated_at,product_id limit ?`).all(reason, limit) as Array<{ product_id: string }>;
      const update = this.db.prepare("update product_task set staging_status='pending',staging_result_json=null,updated_at=? where product_id=? and staging_status='review'");
      const now = new Date().toISOString();
      for (const row of rows) update.run(now, row.product_id);
      this.db.exec("commit");
      return rows.map((row) => row.product_id);
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  stagingSummary() {
    const rows = this.db.prepare("select staging_status status,count(*) count from product_task group by staging_status order by staging_status")
      .all() as Array<{ status: string; count: number }>;
    return rows.map((row) => ({ status: row.status as StagingLaneStatus, count: Number(row.count) }));
  }

  formulaSummary() {
    const rows = this.db.prepare("select status,count(*) count from formula_task group by status order by status")
      .all() as Array<{ status: string; count: number }>;
    return rows.map((row) => ({ status: row.status as FormulaLaneStatus, count: Number(row.count) }));
  }

  listReviewQueue(limit = 100_000) {
    const rows = this.db.prepare(`select q.product_id,q.lane,q.reason_json,q.result_json,q.updated_at,p.source_json
      from review_queue q join product_task p on p.product_id=q.product_id
      where q.status='pending' order by q.updated_at,q.product_id,q.lane limit ?`).all(limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      productId: String(row.product_id),
      lane: String(row.lane),
      reasons: parseJson(row.reason_json),
      result: parseJson(row.result_json),
      source: parseJson(row.source_json),
      updatedAt: String(row.updated_at),
    }));
  }

  private ensureFormulaTask(productId: string, status: FormulaLaneStatus, source: string | null, evidenceFile: string | null, replaceWaiting = false) {
    const now = new Date().toISOString();
    this.db.prepare(`insert into formula_task(product_id,status,source,evidence_file,updated_at) values(?,?,?,?,?)
      on conflict(product_id) do update set
        status=case when ? and formula_task.status='waiting' then excluded.status else formula_task.status end,
        source=coalesce(excluded.source,formula_task.source),
        evidence_file=coalesce(excluded.evidence_file,formula_task.evidence_file),
        updated_at=case when ? and formula_task.status='waiting' then excluded.updated_at else formula_task.updated_at end`).run(
      productId, status, source, evidenceFile, now, replaceWaiting ? 1 : 0, replaceWaiting ? 1 : 0,
    );
  }

  private syncReview(productId: string, lane: "text" | "image" | "formula", status: "ready" | "review" | "failed", review: unknown, result: unknown) {
    if (status === "ready") {
      this.db.prepare("delete from review_queue where product_id=? and lane=?").run(productId, lane);
      return;
    }
    this.upsertReview(productId, lane, review, result);
  }

  private upsertReview(productId: string, lane: "text" | "image" | "formula", review: unknown, result: unknown) {
    this.db.prepare(`insert into review_queue(product_id,lane,reason_json,result_json,updated_at) values(?,?,?,?,?)
      on conflict(product_id,lane) do update set status='pending',reason_json=excluded.reason_json,result_json=excluded.result_json,updated_at=excluded.updated_at`).run(
      productId, lane, review == null ? null : JSON.stringify(review), result == null ? null : JSON.stringify(result), new Date().toISOString(),
    );
  }

  private mergeReview(productId: string, lane: "text" | "image", review: unknown) {
    const row = this.db.prepare("select review_json from product_task where product_id=?")
      .get(productId) as { review_json: string | null } | undefined;
    const existing = parseJson(row?.review_json);
    const merged = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing as Record<string, unknown> }
      : {};
    if (review == null) delete merged[lane];
    else merged[lane] = review;
    return merged;
  }

  private refreshJoin(productId: string) {
    const row = this.db.prepare(`select p.text_status,p.image_status,coalesce(f.status,'waiting') formula_status
      from product_task p left join formula_task f on f.product_id=p.product_id where p.product_id=?`)
      .get(productId) as { text_status: BackfillLaneStatus; image_status: BackfillLaneStatus; formula_status: FormulaLaneStatus } | undefined;
    if (!row) return;
    const joinStatus: BackfillJoinStatus = row.text_status === "review" || row.text_status === "failed" || row.image_status === "review" || row.image_status === "failed" || row.formula_status === "review" || row.formula_status === "failed"
      ? "review"
      : row.text_status === "ready" && row.image_status === "ready" && row.formula_status === "ready"
        ? "ready"
        : "waiting";
    this.db.prepare("update product_task set join_status=?,updated_at=? where product_id=?")
      .run(joinStatus, new Date().toISOString(), productId);
  }

  private refreshAllJoins() {
    const rows = this.db.prepare("select product_id from product_task").all() as Array<{ product_id: string }>;
    for (const row of rows) this.refreshJoin(row.product_id);
  }

  get<T = unknown>(productId: string): BackfillTask<T> | null {
    const row = this.db.prepare("select * from product_task where product_id=?").get(productId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      productId: String(row.product_id),
      source: JSON.parse(String(row.source_json)) as T,
      textStatus: row.text_status as BackfillLaneStatus,
      imageStatus: row.image_status as BackfillLaneStatus,
      formulaStatus: (this.db.prepare("select status from formula_task where product_id=?").get(productId) as { status?: FormulaLaneStatus } | undefined)?.status ?? "waiting",
      joinStatus: row.join_status as BackfillJoinStatus,
      textResult: parseJson(row.text_result_json),
      imageResult: parseJson(row.image_result_json),
      review: parseJson(row.review_json),
      stagingStatus: row.staging_status as StagingLaneStatus,
      stagingResult: parseJson(row.staging_result_json),
    };
  }

  summary() {
    const rows = this.db.prepare(`select text_status,image_status,join_status,count(*) count from product_task group by text_status,image_status,join_status order by text_status,image_status,join_status`)
      .all() as Array<{ text_status: string; image_status: string; join_status: string; count: number }>;
    return rows.map((row) => ({ textStatus: row.text_status, imageStatus: row.image_status, joinStatus: row.join_status, count: Number(row.count) }));
  }

  close() { this.db.close(); }
}
