import { isDeepStrictEqual } from "node:util";
import { RetainedPublication, sha256, verifyBytes } from "@crawl-automation/platform";
import { ArtifactRefSchema, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { ChannelId } from "../adapter.js";
import { channelErrors } from "../errors.js";

import {
  HtmlCaptureSchema,
  FetchedViaSchema,
  SavedHtmlOriginalSchema,
  type HtmlCapture,
  type FetchedVia,
  type ArchivedHtml,
  type SavedHtmlOriginal,
  type HtmlCaptureRequest,
} from "./html-capture-model.js";
export { HtmlCaptureSchema, FetchedViaSchema } from "./html-capture-model.js";
export type { HtmlCapture, FetchedVia, ArchivedHtml } from "./html-capture-model.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

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
    return {
      bytes,
      source: receipt.source,
      capturedAt: receipt.capturedAt,
      url: receipt.capture.url,
      finalUrl,
    };
  }

  /** Reads the producer's original receipt and bytes, retaining every provenance field. */
  async reuse(original: SavedHtmlOriginal, signal: AbortSignal): Promise<ArchivedHtml> {
    const sameListing =
      original.channel === this.target.channel &&
      original.capture.listingId === this.capture.listingId &&
      original.capture.variantId === this.capture.variantId;
    if (!sameListing) {
      throw channelErrors.create("CAPTURE.ARCHIVE_IDENTITY");
    }
    const producer = new OriginalHtmlArchive(this.publication, {
      ...this.target,
      capture: original.capture,
    });
    const saved = await producer.inspect(signal);
    if (!saved) {
      throw channelErrors.create("CAPTURE.ARCHIVE_MISSING");
    }
    if (!isDeepStrictEqual(producer.reference(saved), original)) {
      throw channelErrors.create("CAPTURE.ARCHIVE_IDENTITY");
    }
    return saved;
  }

  /** A reference to this archive's producer, never a new capture of reused bytes. */
  reference(saved: ArchivedHtml): SavedHtmlOriginal {
    const { source, capturedAt, finalUrl } = saved;
    return SavedHtmlOriginalSchema.parse({
      channel: this.target.channel,
      capture: this.capture,
      source,
      capturedAt,
      finalUrl,
    });
  }

  /** Recover publication whose producer lost its database completion write. */
  async inspectPrevious(
    request: HtmlCaptureRequest,
    signal: AbortSignal,
  ): Promise<SavedHtmlOriginal | null> {
    if (
      request.channel !== this.target.channel ||
      request.capture.listingId !== this.capture.listingId ||
      request.capture.variantId !== this.capture.variantId
    ) {
      throw channelErrors.create("CAPTURE.ARCHIVE_IDENTITY");
    }
    const producer = new OriginalHtmlArchive(this.publication, {
      ...this.target,
      capture: request.capture,
    });
    const saved = await producer.inspect(signal);
    return saved ? producer.reference(saved) : null;
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
