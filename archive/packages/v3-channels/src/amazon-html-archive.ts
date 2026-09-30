import { isDeepStrictEqual as equal } from 'node:util';
import { z } from 'zod';
import { AmazonProductJobSchema, AmazonRenderedProductSchema, ArtifactRefSchema, type AmazonProductJob, type AmazonRenderedProduct, type ArtifactRef } from '@crawl-automation/v3-contracts';
import { RetainedPublication, sha256, verifyBytes } from '@crawl-automation/v3-artifacts';
import { amazonProductAddress } from './amazon-rendered.js';

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
export const AMAZON_HTML_LIMIT = 6 * 1024 * 1024;
export const amazonProductOwner = (job: AmazonProductJob) => {
  const d = job.discovery, identity = { listingId: d.entry.listingId, variantId: null };
  return { schemaVersion: 1 as const, requestId: d.catalogId,
    observationId: `amazon-${sha256(encode([d.discoveryId, identity]))}`,
    brandId: d.scope.brandId, sourceId: d.scope.sourceId, ...identity };
};
const receiptSchema = z.strictObject({ codec: z.literal('amazon-original-html/1'),
  operationId: z.string(), sessionId: z.string(), url: z.string().url(), capturedAt: z.iso.datetime(),
  source: ArtifactRefSchema.refine(v => v.kind === 'source-html' && v.byteSize <= AMAZON_HTML_LIMIT),
  fetchedVia: AmazonRenderedProductSchema.shape.fetchedVia,
  reusedFrom: z.strictObject({ receiptKey: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
});
export type ArchivedAmazonHtml = { bytes: Uint8Array; source: ArtifactRef; capturedAt: string; fetchedVia?: AmazonRenderedProduct['fetchedVia'] };
export interface AmazonHtmlFetchGate {
  acquire(job: AmazonProductJob, signal: AbortSignal): Promise<{ kind: 'download' } | { kind: 'reuse'; job: AmazonProductJob }>;
  complete(job: AmazonProductJob, capturedAt: string, signal: AbortSignal): Promise<void>;
}

/** Original response bytes are committed and read back from R2 before any product parsing.
 * The immutable receipt binds the bytes to the exact capture, not merely an ASIN. */
export class AmazonHtmlArchive {
  readonly job: AmazonProductJob;
  readonly prefix: string;
  constructor(readonly publication: RetainedPublication, job: AmazonProductJob) {
    this.job = AmazonProductJobSchema.parse(job);
    this.prefix = `v3/amazon-products/${this.job.operationId}`;
  }
  async beginDownload(signal: AbortSignal) {
    const intent = encode({ operationId: this.job.operationId, sessionId: this.job.sessionId, url: this.job.discovery.entry.url });
    if (await this.publication.remote.create(`${this.prefix}/original-request.json`, intent, 'application/json', signal) !== 'created')
      throw Error('AMAZON.HTML_DOWNLOAD_UNRESOLVED');
  }
  private source(bytes: Uint8Array) {
    const { observationId, sourceId, listingId, variantId } = amazonProductOwner(this.job);
    return ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `html-${sha256(encode(this.job.operationId))}`,
      observationId, sourceId, listingId, variantId, kind: 'source-html', mediaType: 'text/html',
      objectKey: `${this.prefix}/original.html`, byteSize: bytes.length, sha256: sha256(bytes),
      producer: { operationId: this.job.operationId, module: 'amazon.http-original', implementationVersion: 'amazon-html/1' } });
  }
  async inspect(signal: AbortSignal): Promise<ArchivedAmazonHtml | null> {
    const raw = await this.publication.remote.read(`${this.prefix}/original.json`, 65536, signal);
    if (!raw) return null;
    const receipt = receiptSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
    if (receipt.operationId !== this.job.operationId || receipt.sessionId !== this.job.sessionId ||
      receipt.url !== this.job.discovery.entry.url || receipt.source.objectKey !== `${this.prefix}/original.html`)
      throw Error('AMAZON.HTML_ARCHIVE_IDENTITY');
    const bytes = await this.publication.remote.read(receipt.source.objectKey, receipt.source.byteSize, signal);
    if (!bytes) throw Error('AMAZON.HTML_ARCHIVE_MISSING');
    verifyBytes(receipt.source, bytes, AMAZON_HTML_LIMIT);
    if (!equal(receipt.source, this.source(bytes))) throw Error('AMAZON.HTML_ARCHIVE_IDENTITY');
    if (receipt.reusedFrom) {
      const rawOrigin = await this.publication.remote.read(receipt.reusedFrom.receiptKey, 65536, signal);
      if (!rawOrigin || sha256(rawOrigin) !== receipt.reusedFrom.sha256) throw Error('AMAZON.HTML_REUSE_PROVENANCE');
      const origin = receiptSchema.parse(JSON.parse(Buffer.from(rawOrigin).toString('utf8')));
      if (origin.reusedFrom || receipt.reusedFrom.receiptKey !== `v3/amazon-products/${origin.operationId}/original.json` ||
        origin.source.objectKey !== `v3/amazon-products/${origin.operationId}/original.html` ||
        amazonProductAddress(origin.url).url !== amazonProductAddress(receipt.url).url ||
        origin.capturedAt !== receipt.capturedAt || !equal(origin.fetchedVia, receipt.fetchedVia) ||
        origin.source.sha256 !== receipt.source.sha256 || origin.source.byteSize !== receipt.source.byteSize)
        throw Error('AMAZON.HTML_REUSE_PROVENANCE');
      const originalBytes = await this.publication.remote.read(origin.source.objectKey, origin.source.byteSize, signal);
      if (!originalBytes) throw Error('AMAZON.HTML_ARCHIVE_MISSING');
      verifyBytes(origin.source, originalBytes, AMAZON_HTML_LIMIT);
    }
    return { bytes, source: receipt.source, capturedAt: receipt.capturedAt, ...(receipt.fetchedVia ? { fetchedVia: receipt.fetchedVia } : {}) };
  }
  async reuse(original: AmazonHtmlArchive, signal: AbortSignal): Promise<ArchivedAmazonHtml> {
    if (amazonProductAddress(original.job.discovery.entry.url).url !== amazonProductAddress(this.job.discovery.entry.url).url)
      throw Error('AMAZON.HTML_ARCHIVE_IDENTITY');
    const saved = await original.inspect(signal);
    if (!saved) throw Error('AMAZON.RECENT_HTML_FETCH_UNRESOLVED');
    const receiptKey = `${original.prefix}/original.json`, raw = await this.publication.remote.read(receiptKey, 65536, signal);
    if (!raw) throw Error('AMAZON.HTML_ARCHIVE_MISSING');
    return this.save(saved.bytes, signal, { capturedAt: saved.capturedAt, fetchedVia: saved.fetchedVia,
      reusedFrom: { receiptKey, sha256: sha256(raw) } });
  }
  async save(bytes: Uint8Array, signal: AbortSignal, metadata: { capturedAt?: string; fetchedVia?: AmazonRenderedProduct['fetchedVia']; reusedFrom?: { receiptKey: string; sha256: string } } = {}): Promise<ArchivedAmazonHtml> {
    if (!bytes.length || bytes.length > AMAZON_HTML_LIMIT) throw Error('AMAZON.PAGE_LIMIT');
    const source = this.source(bytes), old = await this.inspect(signal);
    if (old) {
      if (!equal(old.source, source)) throw Error('AMAZON.HTML_ARCHIVE_CONFLICT');
      return old;
    }
    const receipt = receiptSchema.parse({ codec: 'amazon-original-html/1', operationId: this.job.operationId,
      sessionId: this.job.sessionId, url: this.job.discovery.entry.url, capturedAt: metadata.capturedAt ?? new Date().toISOString(), source,
      ...(metadata.fetchedVia ? { fetchedVia: metadata.fetchedVia } : {}), ...(metadata.reusedFrom ? { reusedFrom: metadata.reusedFrom } : {}) });
    await this.publication.publish(source.objectKey, bytes, 'text/html', signal);
    await this.publication.publish(`${this.prefix}/original.json`, encode(receipt), 'application/json', signal);
    const saved = await this.inspect(signal);
    if (!saved || !equal(saved.source, source)) throw Error('AMAZON.HTML_ARCHIVE_UNVERIFIED');
    return saved;
  }
}
