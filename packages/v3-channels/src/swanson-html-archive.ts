import { isDeepStrictEqual as equal } from "node:util";
import { z } from "zod";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { swansonProductAddress } from "./swanson-rendered.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
export const SWANSON_HTML_LIMIT = 6 * 1024 * 1024;
/** One product page download for one capture operation (family or variant job). */
export const SwansonHtmlCaptureSchema = z.strictObject({ operationId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
  url: z.string().url().max(4096), sourceId: z.string().min(1).max(200), listingId: z.string().min(1).max(200), variantId: z.string().min(1).max(200).nullable() });
export type SwansonHtmlCapture = z.infer<typeof SwansonHtmlCaptureSchema>;
const receiptSchema = z.strictObject({ codec: z.literal("swanson-original-html/1"), capture: SwansonHtmlCaptureSchema, capturedAt: z.iso.datetime(),
  source: ArtifactRefSchema.refine(v => v.kind === "source-html" && v.byteSize <= SWANSON_HTML_LIMIT),
  fetchedVia: z.strictObject({ mode: z.literal("http"), routeId: z.string(), egressId: z.string(), provider: z.string() }) });
export type ArchivedSwansonHtml = { bytes: Uint8Array; source: ArtifactRef; capturedAt: string };

/** Original Swanson product page bytes are committed and read back from R2 before any parsing (the original-HTML rule).
 * A create-once request intent is written before the paid download, so a lost answer never causes a second request. */
export class SwansonHtmlArchive {
  readonly capture: SwansonHtmlCapture;
  readonly prefix: string;
  constructor(readonly publication: RetainedPublication, capture: SwansonHtmlCapture) {
    this.capture = SwansonHtmlCaptureSchema.parse(capture);
    swansonProductAddress(this.capture.url);
    this.prefix = `v3/swanson-html/${this.capture.operationId}`;
  }
  async beginDownload(signal: AbortSignal) {
    if (await this.publication.remote.create(`${this.prefix}/original-request.json`, encode(this.capture), "application/json", signal) !== "created")
      throw Error("SWANSON.HTML_DOWNLOAD_UNRESOLVED");
  }
  private source(bytes: Uint8Array) {
    const c = this.capture;
    return ArtifactRefSchema.parse({ schemaVersion: 1, artifactId: `html-${sha256(encode(c.operationId))}`,
      observationId: `swanson-html-${sha256(encode(c.operationId))}`, sourceId: c.sourceId, listingId: c.listingId, variantId: c.variantId,
      kind: "source-html", mediaType: "text/html", objectKey: `${this.prefix}/original.html`, byteSize: bytes.length, sha256: sha256(bytes),
      producer: { operationId: c.operationId, module: "swanson.http-original", implementationVersion: "swanson-html/1" } });
  }
  async inspect(signal: AbortSignal): Promise<ArchivedSwansonHtml | null> {
    const raw = await this.publication.remote.read(`${this.prefix}/original.json`, 65536, signal);
    if (!raw) return null;
    const receipt = receiptSchema.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
    if (!equal(receipt.capture, this.capture) || receipt.source.objectKey !== `${this.prefix}/original.html`) throw Error("SWANSON.HTML_ARCHIVE_IDENTITY");
    const bytes = await this.publication.remote.read(receipt.source.objectKey, receipt.source.byteSize, signal);
    if (!bytes) throw Error("SWANSON.HTML_ARCHIVE_MISSING");
    verifyBytes(receipt.source, bytes, SWANSON_HTML_LIMIT);
    if (!equal(receipt.source, this.source(bytes))) throw Error("SWANSON.HTML_ARCHIVE_IDENTITY");
    return { bytes, source: receipt.source, capturedAt: receipt.capturedAt };
  }
  async save(bytes: Uint8Array, signal: AbortSignal, fetchedVia: z.infer<typeof receiptSchema>["fetchedVia"]): Promise<ArchivedSwansonHtml> {
    if (!bytes.length || bytes.length > SWANSON_HTML_LIMIT) throw Error("SWANSON.PAGE_LIMIT");
    const source = this.source(bytes), old = await this.inspect(signal);
    if (old) { if (!equal(old.source, source)) throw Error("SWANSON.HTML_ARCHIVE_CONFLICT"); return old; }
    const receipt = receiptSchema.parse({ codec: "swanson-original-html/1", capture: this.capture, capturedAt: new Date().toISOString(), source, fetchedVia });
    await this.publication.publish(source.objectKey, bytes, "text/html", signal);
    await this.publication.publish(`${this.prefix}/original.json`, encode(receipt), "application/json", signal);
    const saved = await this.inspect(signal);
    if (!saved || !equal(saved.source, source)) throw Error("SWANSON.HTML_ARCHIVE_UNVERIFIED");
    return saved;
  }
}
