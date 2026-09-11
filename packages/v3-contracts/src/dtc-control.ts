import { z } from 'zod';
import { CatalogPageInputSchema } from './catalog.js';
import { DtcProductCaptureSchema, DtcProductJobSchema } from './dtc-live.js';
import { FileAcquireInputSchema } from './acquisition.js';
import { ReviewRecordSchema } from './reviews.js';
import { VersionTagSchema } from './artifacts.js';

const file = { capture: DtcProductCaptureSchema, input: FileAcquireInputSchema };
// Narrow task-bound requests, never SQL, database credentials, or arbitrary RPC.
export const DtcBrowserControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('catalog'), input: CatalogPageInputSchema, model: z.boolean() }),
  z.strictObject({ action: z.literal('product'), job: DtcProductJobSchema, model: z.boolean() }),
  z.strictObject({ action: z.literal('file'), ...file }),
  z.strictObject({ action: z.literal('file-review-read'), ...file, reviewId: z.string().min(1).max(200) }),
  z.strictObject({ action: z.literal('file-review-append'), ...file, record: ReviewRecordSchema }),
]);
export type DtcBrowserControl = z.infer<typeof DtcBrowserControlSchema>;
export const DtcNodeIdentitySchema = z.strictObject({
  nodeId: VersionTagSchema, host: z.string().min(1).max(255), root: z.string().min(1).max(1024),
});
export const DtcNodeSessionSchema = z.strictObject({
  node: DtcNodeIdentitySchema, sessionId: z.uuid(), controlQueue: VersionTagSchema,
  sequence: z.number().int().min(-1).default(-1), resumed: z.boolean().default(false),
});
export type DtcNodeSession = z.infer<typeof DtcNodeSessionSchema>;
export const DtcNodeReportSchema = z.strictObject({
  sessionId: z.uuid(), sequence: z.number().int().nonnegative(), healthy: z.boolean(),
});
export const DtcNodeControlSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('preflight'), nodeId: VersionTagSchema }),
  z.strictObject({ action: z.literal('open'), session: DtcNodeSessionSchema }),
  z.strictObject({ action: z.literal('health'), session: DtcNodeSessionSchema, report: DtcNodeReportSchema }),
  z.strictObject({ action: z.literal('close'), session: DtcNodeSessionSchema }),
]);
