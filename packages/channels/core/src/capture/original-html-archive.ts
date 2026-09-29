import { isDeepStrictEqual } from "node:util";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { ScraperApiOptionsSchema } from "@crawl-automation/platform";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { ChannelId } from "../adapter.js";
import { channelErrors } from "../errors.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

/** One page download for one capture operation. */
export const HtmlCaptureSchema = z.strictObject({
  operationId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  url: z.url().max(4096),
  sourceId: z.string().min(1).max(200),
  listingId: z.string().min(1).max(200),
  variantId: z.string().min(1).max(200).nullable(),
});
export type HtmlCapture = z.infer<typeof HtmlCaptureSchema>;

/**
 * How a page was fetched. `options` and `creditCost` are recorded since the ScraperAPI client moved to platform;
 * earlier archives have neither and stay readable.
 */
export const FetchedViaSchema = z.strictObject({
  mode: z.literal("http"),
  routeId: z.string(),
  egressId: z.string(),
  provider: z.string(),
  options: ScraperApiOptionsSchema.optional(),
  creditCost: z.number().nonnegative().nullable().optional(),
  /** Where the page was finally read, when a same-site redirect moved it; absent when it was not moved. */
  finalUrl: z.url().max(4096).optional(),
});
export type FetchedVia = z.infer<typeof FetchedViaSchema>;

export interface ArchivedHtml {
  bytes: Uint8Array;
  source: ArtifactRef;
  capturedAt: string;
  /** Where the page was finally read, when a redirect moved it; null otherwise. */
  finalUrl: string | null;
}

/**
 * The original page bytes, committed to R2 and read back before anything parses them. A create-once request is
 * written before the paid download, so a lost answer never causes a second request. Keys and receipts are the
 * same as the per-channel archives before it (`v3/<channel>-html/<op>/…`, `<channel>-original-html/1`), so
 * earlier originals stay readable.
 */
export class OriginalHtmlArchive {
  readonly capture: HtmlCapture;
  readonly prefix: string;
  private readonly receipt;

  constructor(
    private readonly publication: RetainedPublication,
    private readonly target: { channel: ChannelId; capture: HtmlCapture; maxBytes: number },
  ) {
    this.capture = HtmlCaptureSchema.parse(target.capture);
    this.prefix = `v3/${target.channel}-html/${this.capture.operationId}`;
    this.receipt = z.strictObject({
      codec: z.literal(`${target.channel}-original-html/1`),
      capture: HtmlCaptureSchema,
      capturedAt: z.iso.datetime(),
      source: ArtifactRefSchema.refine(
        (ref) => ref.kind === "source-html" && ref.byteSize <= target.maxBytes,
      ),
      fetchedVia: FetchedViaSchema,
    });
  }

  /** Records the intent to download; a second attempt for the same operation is refused. */
  async beginDownload(signal: AbortSignal): Promise<void> {
    const key = `${this.prefix}/original-request.json`;
    const created = await this.publication.remote.create(
      key,
      encode(this.capture),
      "application/json",
      signal,
    );
    if (created !== "created") {
      throw channelErrors.create("CAPTURE.DOWNLOAD_UNRESOLVED", { details: { key } });
    }
  }

  /** The archived page, verified byte for byte; null when nothing is archived yet. */
  async inspect(signal: AbortSignal): Promise<ArchivedHtml | null> {
    const raw = await this.publication.remote.read(`${this.prefix}/original.json`, 65_536, signal);
    if (!raw) {
      return null;
    }
    const receipt = this.receipt.parse(JSON.parse(Buffer.from(raw).toString("utf8")));
    if (!isDeepStrictEqual(receipt.capture, this.capture)) {
      throw channelErrors.create("CAPTURE.ARCHIVE_IDENTITY", { details: { prefix: this.prefix } });
    }
    const bytes = await this.publication.remote.read(
      receipt.source.objectKey,
      receipt.source.byteSize,
      signal,
    );
    if (!bytes) {
      throw channelErrors.create("CAPTURE.ARCHIVE_MISSING", { details: { prefix: this.prefix } });
    }
    verifyBytes(receipt.source, bytes, this.target.maxBytes);
    if (!isDeepStrictEqual(receipt.source, this.sourceOf(bytes))) {
      throw channelErrors.create("CAPTURE.ARCHIVE_IDENTITY", { details: { prefix: this.prefix } });
    }
    const finalUrl = receipt.fetchedVia.finalUrl ?? null;
    return { bytes, source: receipt.source, capturedAt: receipt.capturedAt, finalUrl };
  }

  /** Commits the page and its receipt, then reads both back. An identical earlier archive is returned as is. */
  async save(
    bytes: Uint8Array,
    fetchedVia: FetchedVia,
    signal: AbortSignal,
  ): Promise<ArchivedHtml> {
    const source = this.sourceOf(bytes);
    const existing = await this.inspect(signal);
    if (existing) {
      if (!isDeepStrictEqual(existing.source, source)) {
        throw channelErrors.create("CAPTURE.ARCHIVE_CONFLICT", {
          details: { prefix: this.prefix },
        });
      }
      return existing;
    }
    const codec = `${this.target.channel}-original-html/1`;
    const receipt = {
      codec,
      capture: this.capture,
      capturedAt: new Date().toISOString(),
      source,
      fetchedVia,
    };
    await this.publication.publish(source.objectKey, bytes, "text/html", signal);
    await this.publication.publish(
      `${this.prefix}/original.json`,
      encode(this.receipt.parse(receipt)),
      "application/json",
      signal,
    );
    const saved = await this.inspect(signal);
    if (!saved || !isDeepStrictEqual(saved.source, source)) {
      throw channelErrors.create("CAPTURE.ARCHIVE_UNVERIFIED", {
        details: { prefix: this.prefix },
      });
    }
    return saved;
  }

  private sourceOf(bytes: Uint8Array): ArtifactRef {
    const { channel } = this.target;
    const capture = this.capture;
    const opHash = sha256(encode(capture.operationId));
    return ArtifactRefSchema.parse({
      schemaVersion: 1,
      artifactId: `html-${opHash}`,
      observationId: `${channel}-html-${opHash}`,
      sourceId: capture.sourceId,
      listingId: capture.listingId,
      variantId: capture.variantId,
      kind: "source-html",
      mediaType: "text/html",
      objectKey: `${this.prefix}/original.html`,
      byteSize: bytes.length,
      sha256: sha256(bytes),
      producer: {
        operationId: capture.operationId,
        module: `${channel}.http-original`,
        implementationVersion: `${channel}-html/1`,
      },
    });
  }
}
