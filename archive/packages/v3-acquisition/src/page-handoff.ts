import { randomUUID } from "node:crypto";
import { isDeepStrictEqual as equal } from "node:util";
import { PreparedPageRecordSchema, PagePrepareInputSchema, PageTextPrepareInputSchema, PageTablesSchema, TextDocumentSchema,
  TextInputSchema, ReviewRecordSchema, observationIdentity, textFingerprint, type PagePrepareInput, type PagePrepareOutcome,
  type PreparedPageRecord, type ArtifactRef, type ReviewRecord } from "@crawl-automation/v3-contracts";
import { verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { hash, verifyInput } from "./core.js";
import { preparePage, PAGE_CONFIG_FINGERPRINT, PAGE_POLICY } from "./page.js";
type Dependencies = { local: ObjectStore; remote: ObjectStore;
  reviews: { read(id: string): Promise<ReviewRecord | null>; append(r: ReviewRecord): Promise<unknown> } };
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
export const pageCompletionKey = (input: PagePrepareInput) => `v3/pages/${input.operationId}/completion.json`;
function checked(raw: unknown) {
  const input = PagePrepareInputSchema.parse(raw); verifyInput(input, PAGE_CONFIG_FINGERPRINT);
  if (input.operationId === input.page.producer.operationId) throw Error("PAGE.IDENTITY_CONFLICT");
  return input;
}
/** Read-only evidence validation and bounded publication. No parser/model/source fetch capability. */
export class PageEvidence {
  constructor(readonly deps: Dependencies) {}
  async source(input: PagePrepareInput, signal: AbortSignal) {
    const bytes = await this.deps.remote.read(input.page.objectKey, PAGE_POLICY.maxBytes, signal);
    if (!bytes) throw Error("PAGE.SOURCE_NOT_DURABLE");
    verifyBytes(input.page, bytes, PAGE_POLICY.maxBytes); return bytes;
  }
  async inspect(raw: unknown, signal: AbortSignal): Promise<PreparedPageRecord | null> {
    const input = checked(raw), bytes = await this.deps.remote.read(pageCompletionKey(input), 65536, signal);
    if (!bytes) return null;
    const record = PreparedPageRecordSchema.parse(decode(bytes));
    if (!equal(record.input, input)) throw Error("PAGE.IDENTITY_CONFLICT");
    await this.source(input, signal);
    const outputs = [];
    for (const [name, ref] of [["document", record.document], ["tables", record.tables]] as const) {
      if (ref.objectKey !== `v3/pages/${input.operationId}/${name}.json` || ref.artifactId !== `page-${name}-${hash(input.operationId)}`) throw Error("PAGE.IDENTITY_CONFLICT");
      const data = await this.deps.remote.read(ref.objectKey, PAGE_POLICY.maxOutputBytes, signal);
      if (!data) throw Error("PAGE.NOT_DURABLE");
      verifyBytes(ref, data, PAGE_POLICY.maxOutputBytes); outputs.push(decode(data));
    }
    const document = TextDocumentSchema.parse(outputs[0]); PageTablesSchema.parse(outputs[1]);
    if (!equal(observationIdentity(document), observationIdentity(input)) || !equal(document.source, input.page) ||
      document.producer !== "page.prepare" || document.pageIndex !== null || document.text.length !== record.textLength) throw Error("PAGE.IDENTITY_CONFLICT");
    return record;
  }
  async publish(key: string, value: unknown, limit: number, signal: AbortSignal) {
    const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > limit) throw Error("PAGE.OUTPUT_LIMIT");
    const verify = (b: Uint8Array | null) => { if (!b || hash(b) !== hash(bytes)) throw Error("PAGE.HANDOFF_UNVERIFIED"); };
    const prior = await this.deps.remote.read(key, limit, signal); if (prior) { verify(prior); return; }
    // Candidate retention is separate from publication intent; each remote PUT has a local one-shot marker.
    const intent = `page-publications/${hash(key)}.json`, marker = Buffer.from(JSON.stringify({ key, sha256: hash(bytes), nonce: randomUUID() }));
    const claim = await this.deps.local.create(intent, marker, "application/json", signal);
    if (claim !== "created") throw Error("PAGE.HANDOFF_PENDING");
    const retained = await this.deps.local.read(intent, 65536, signal);
    if (!retained || hash(retained) !== hash(marker)) throw Error("PAGE.LOCAL_UNVERIFIED");
    // Shared intent prevents an empty-cache replacement from retrying an uncertain PUT.
    let shared;
    try { shared = await this.deps.remote.create(intent, marker, "application/json", signal); }
    catch { throw Error("PAGE.HANDOFF_PENDING"); }
    if (shared !== "created") throw Error("PAGE.HANDOFF_PENDING");
    const confirmed = await this.deps.remote.read(intent, 65536, signal);
    if (!confirmed || hash(confirmed) !== hash(marker)) throw Error("PAGE.HANDOFF_PENDING");
    try { await this.deps.remote.create(key, bytes, "application/json", signal); } catch { /* GET only. */ }
    verify(await this.deps.remote.read(key, limit, signal));
  }
  async review(input: PagePrepareInput, stage: "page.prepare" | "page.text-input", error: unknown): Promise<Extract<PagePrepareOutcome, { status: "review" }>> {
    const value = error instanceof Error ? ("code" in error ? String(error.code) : error.message) : "";
    const code = /^(PAGE|PROCESSING|ARTIFACT|INPUT|RUNTIME)\.[A-Z_]+$/.test(value) ? value : "PAGE.UNRESOLVED";
    const reviewId = `page-${randomUUID()}`, evidenceKey = `page-reviews/${reviewId}.json`;
    const record = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId, occurredAt: new Date().toISOString(),
      failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
        inputFingerprint: input.inputFingerprint, stage, category: "PROCESSING", code, executionFact: "unknown", evidenceKey, blockedBy: null, automaticRetry: false },
      observation: observationIdentity(input), rawError: { name: "PageFailure", message: code, stack: null, details: { input } }, candidate: null, inspection: { kind: "none" } });
    const bytes = Buffer.from(JSON.stringify(record)), signal = AbortSignal.timeout(10000);
    await this.deps.local.create(evidenceKey, bytes, "application/json", signal);
    const saved = await this.deps.local.read(evidenceKey, 2 * 1024 * 1024, signal);
    if (!saved || hash(saved) !== hash(bytes)) throw Error("PAGE.REVIEW_UNVERIFIED");
    try { await this.deps.reviews.append(record); } catch { /* Exact ID readback. */ }
    const confirmed = await this.deps.reviews.read(reviewId);
    if (!confirmed || !equal(ReviewRecordSchema.parse(confirmed), record)) throw Error("PAGE.REVIEW_UNVERIFIED");
    return { status: "review", operationId: input.operationId, reviewId, evidenceKey, code, automaticRetry: false };
  }
}
export class PreparePageModule {
  constructor(private readonly evidence: PageEvidence) {}
  async run(raw: unknown, signal: AbortSignal): Promise<PagePrepareOutcome> {
    const input = PagePrepareInputSchema.parse(raw), e = this.evidence;
    try {
      checked(input); signal.throwIfAborted();
      const prior = await e.inspect(input, signal); if (prior) return { status: "durable", record: prior };
      const source = await e.source(input, signal), intentKey = `page-intents/${input.operationId}.json`, intent = { input, nonce: randomUUID() };
      let claim;
      try { claim = await e.deps.remote.create(intentKey, Buffer.from(JSON.stringify(intent)), "application/json", signal); }
      catch { throw Error("PAGE.INTENT_UNKNOWN"); }
      const saved = await e.deps.remote.read(intentKey, 65536, signal);
      if (claim !== "created") throw Error("PAGE.EXECUTION_UNKNOWN");
      if (!saved || !equal(decode(saved), intent)) throw Error("PAGE.INTENT_UNKNOWN");
      let parsed;
      try { parsed = preparePage(input, source, signal); }
      catch (error) { if (error instanceof TypeError) throw Error("PAGE.ENCODING"); throw error; }
      if (parsed.text.length > 200000) throw Error("PAGE.TEXT_LIMIT");
      const document = TextDocumentSchema.parse({ ...observationIdentity(input), producer: "page.prepare", source: input.page, pageIndex: null, text: parsed.text });
      const tables = PageTablesSchema.parse(parsed.tables);
      const ref = (name: string, value: unknown): ArtifactRef => {
        const bytes = Buffer.from(JSON.stringify(value));
        return { schemaVersion: 1, artifactId: `page-${name}-${hash(input.operationId)}`, observationId: input.observationId, sourceId: input.sourceId,
          listingId: input.listingId, variantId: input.variantId, kind: "result-json", mediaType: "application/json", byteSize: bytes.length,
          sha256: hash(bytes), objectKey: `v3/pages/${input.operationId}/${name}.json`, producer: { module: input.module, operationId: input.operationId, implementationVersion: input.implementationVersion } };
      };
      const record = PreparedPageRecordSchema.parse({ schemaVersion: 1, codec: "prepared-page/1", input,
        document: ref("document", document), tables: ref("tables", tables), textLength: parsed.text.length });
      // Retain all computed outputs before attempting shared publication; no cleanup after success/failure.
      const retain = AbortSignal.timeout(10000);
      for (const [key, value] of [[record.document.objectKey, document], [record.tables.objectKey, tables], [pageCompletionKey(input), record]] as const) {
        const bytes = Buffer.from(JSON.stringify(value));
        await e.deps.local.create(key, bytes, "application/json", retain);
        const saved = await e.deps.local.read(key, PAGE_POLICY.maxOutputBytes, retain);
        if (!saved || hash(saved) !== hash(bytes)) throw Error("PAGE.LOCAL_UNVERIFIED");
      }
      await e.publish(record.document.objectKey, document, PAGE_POLICY.maxOutputBytes, signal);
      await e.publish(record.tables.objectKey, tables, PAGE_POLICY.maxOutputBytes, signal);
      await e.publish(pageCompletionKey(input), record, 65536, signal);
      const verified = await e.inspect(input, signal); if (!verified) throw Error("PAGE.NOT_DURABLE");
      return { status: "durable", record: verified };
    } catch (error) {
      try { const record = await e.inspect(input, AbortSignal.timeout(10000)); if (record) return { status: "durable", record }; } catch { /* No recomputation or reupload. */ }
      return e.review(input, "page.prepare", error);
    }
  }
}
/** No parser: verifies completed page, then creates a signed V2 TextInput for the full text. */
export class PreparePageText {
  constructor(private readonly evidence: PageEvidence) {}
  async run(raw: unknown, signal: AbortSignal) {
    const { plan, receipt } = PageTextPrepareInputSchema.parse(raw), input = plan.page, e = this.evidence;
    try {
      checked(input);
      if (receipt?.status === "review") {
        const saved = await e.deps.reviews.read(receipt.reviewId);
        if (!saved) throw Error("PAGE.REVIEW_UNVERIFIED");
        const r = ReviewRecordSchema.parse(saved);
        if (receipt.operationId !== input.operationId || r.reviewId !== receipt.reviewId || r.failure.operationId !== input.operationId ||
          r.failure.inputFingerprint !== input.inputFingerprint || r.failure.stage !== "page.prepare" || r.failure.code !== receipt.code ||
          r.failure.evidenceKey !== receipt.evidenceKey || !equal(r.observation, observationIdentity(input))) throw Error("PAGE.IDENTITY_CONFLICT");
        return receipt;
      }
      const record = await e.inspect(input, signal); if (!record) throw Error("PAGE.NOT_DURABLE");
      if (receipt && !equal(receipt.record, record)) throw Error("PAGE.IDENTITY_CONFLICT");
      const unsigned = { ...observationIdentity(input), ...plan.text, operationId: plan.textOperationId,
        source: { kind: "prepared" as const, document: record.document }, range: { start: 0, end: record.textLength } };
      const task = TextInputSchema.parse({ ...unsigned, inputFingerprint: textFingerprint(unsigned, hash) });
      const key = `v3/page-text-inputs/${plan.textOperationId}.json`, candidate = { plan, record, task };
      const bytes = Buffer.from(JSON.stringify(candidate));
      await e.deps.local.create(key, bytes, "application/json", signal);
      const saved = await e.deps.local.read(key, 65536, signal);
      if (!saved || hash(saved) !== hash(bytes)) throw Error("PAGE.IDENTITY_CONFLICT");
      await e.publish(key, candidate, 65536, signal);
      return { status: "prepared" as const, task };
    } catch (error) { return e.review(input, "page.text-input", error); }
  }
}
