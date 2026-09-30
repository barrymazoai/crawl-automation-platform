import { z } from "zod";
import { Id, SubmitCollection, CollectionSubmission, ActiveSubmission, DeliveryReadback, type Source, type DeliveryReceipt } from "@crawl-automation/v3-contracts";
import { ApiFailure, request } from "./api";

export const CollectionIntent = z.strictObject({
  key: Id, brandId: Id, sourceId: Id,
  input: SubmitCollection,
  label: z.string().min(1).max(2200),
});
export type CollectionIntent = z.infer<typeof CollectionIntent>;
export const collectionStorageKey = "crawler-v3-live:collection:v1";
export const collectionArchiveKey = "crawler-v3-live:collection-archive:v1";
export function readCollection(storage: Storage) {
  const raw = storage.getItem(collectionStorageKey);
  return raw === null ? null : CollectionIntent.parse(JSON.parse(raw));
}
export function prepareCollection(storage: Storage, source: Source) {
  if (readCollection(storage)) throw new Error("请先处理保留的原请求。");
  const intent = CollectionIntent.parse({ key: crypto.randomUUID(), brandId: source.brandId, sourceId: source.id,
    input: { sourceRevision: source.revision }, label: `${source.channel} · ${source.url}` });
  storage.setItem(collectionStorageKey, JSON.stringify(intent)); // Must succeed BEFORE any POST.
  return intent;
}
export function archiveCollection(storage: Storage, intent: CollectionIntent) {
  const archive = z.array(CollectionIntent).parse(JSON.parse(storage.getItem(collectionArchiveKey) ?? "[]"));
  storage.setItem(collectionArchiveKey, JSON.stringify([...archive, intent]));
  storage.removeItem(collectionStorageKey); // Never delete the only copy of the key.
}
function assertReceipt(intent: CollectionIntent, value: CollectionSubmission) {
  if (value.requestId !== intent.key || value.snapshot.brandId !== intent.brandId ||
      value.snapshot.sourceId !== intent.sourceId || value.snapshot.sourceRevision !== intent.input.sourceRevision)
    throw new ApiFailure("IDENTITY_MISMATCH", true, "回执与原请求不匹配，已保留编号，请人工核验。");
  return value;
}
export async function sendCollection(intent: CollectionIntent) {
  return assertReceipt(intent, await request(`/brands/${intent.brandId}/sources/${intent.sourceId}/submissions`, CollectionSubmission, {
    method: "POST", body: JSON.stringify(intent.input),
    headers: { "Content-Type": "application/json", "Idempotency-Key": intent.key },
  }, 202));
}
export type CollectionState = { submission: CollectionSubmission | null; active: CollectionSubmission | null; delivery: DeliveryReceipt | null; readAt: string };
export async function readCollectionState(source: Pick<Source, "brandId" | "id">, intent: CollectionIntent | null): Promise<CollectionState> {
  const { item: active } = await request(`/brands/${source.brandId}/sources/${source.id}/submissions/active`, ActiveSubmission);
  if (active && (active.snapshot.sourceId !== source.id || active.snapshot.brandId !== source.brandId))
    throw new Error("来源占用回执不匹配，请核验。");
  let submission = active;
  if (intent) {
    try { submission = assertReceipt(intent, await request(`/submissions/${intent.key}`, CollectionSubmission)); }
    catch (e) {
      if (!(e instanceof ApiFailure) || e.code !== "SUBMISSION_NOT_FOUND") throw e;
      submission = null; // A 404 is not permission to generate a new request key.
    }
  }
  const delivery = submission ? (await request(`/submissions/${submission.requestId}/delivery`, DeliveryReadback)).item : null;
  if (delivery && delivery.requestId !== submission?.requestId) throw new Error("交接回执编号不匹配，请核验。");
  return { active, submission, delivery, readAt: new Date().toISOString() };
}
export function deliveryLabel(submission: CollectionSubmission | null, delivery: DeliveryReceipt | null) {
  if (!submission) return "未确认受理";
  if (!delivery) return "已入库 · 等待交接（不代表已运行）";
  if (delivery.lastIssue || delivery.state === "START_UNKNOWN") return `交接待核验 · ${delivery.lastIssue ?? "START_UNKNOWN"}`;
  if (delivery.state === "CLOSED") return `流程已结束 · ${delivery.observedStatus}（不代表产品已入库）`;
  return `Temporal 已接收 · ${delivery.observedStatus ?? "状态待回读"}（不代表 Worker 已开始采集）`;
}
