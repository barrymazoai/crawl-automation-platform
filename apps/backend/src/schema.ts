import { bigint, boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const sources = pgTable("pipeline_source", {
  id: uuid().primaryKey(), url: text().notNull(), origin: text().notNull(), sourceType: text("source_type").notNull(),
  adapter: text(), mode: text().notNull(), scheduleCron: text("schedule_cron"), scheduleTimezone: text("schedule_timezone").notNull(),
  enabled: boolean().notNull(), nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
}, (table) => [uniqueIndex("pipeline_source_origin_mode_idx").on(table.origin, table.mode)]);

export const runs = pgTable("pipeline_run", {
  id: uuid().primaryKey(), sourceId: uuid("source_id").notNull(), status: text().notNull(), itemCount: integer("item_count").notNull(),
  openReviewCount: integer("open_review_count").notNull(), errorCode: text("error_code"), errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const jobs = pgTable("pipeline_job", {
  id: uuid().primaryKey(), runId: uuid("run_id").notNull(), stage: text().notNull(), state: text().notNull(),
  requiredCapability: text("required_capability").notNull(), dependsOn: uuid("depends_on").array().notNull(), payload: jsonb().notNull(), output: jsonb(),
  attempt: integer().notNull(), maxAttempts: integer("max_attempts").notNull(), availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
  leasedBy: text("leased_by"), leaseTokenHash: text("lease_token_hash"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const artifacts = pgTable("pipeline_artifact", {
  id: uuid().primaryKey(), runId: uuid("run_id").notNull(), jobId: uuid("job_id").notNull(), kind: text().notNull(),
  bucketKey: text("bucket_key").notNull(), fileName: text("file_name").notNull(), contentType: text("content_type").notNull(),
  sha256: text().notNull(), byteSize: bigint("byte_size", { mode: "number" }).notNull(), status: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

