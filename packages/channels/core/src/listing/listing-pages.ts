import { createHash } from "node:crypto";
import {
  allowedTarget,
  type ObjectStore,
  type ScraperApiClient,
  type ScraperApiOptions,
} from "@crawl-automation/platform";
import type { ChannelId } from "../adapter.js";
import type { ScraperApiCaptureSettings } from "../capture/page-fetch.js";
import { brandScanErrors } from "./brand-scan.js";

/** One listing page to read for a scan: where it is archived (`label`) and what it answers with. */
export interface ListingPageRequest {
  scanId: string;
  channel: ChannelId;
  url: string;
  /** Unique within the scan, e.g. `page-2` or `family-GNCTotalLean`. */
  label: string;
  answer: "html" | "json";
  origins: readonly string[];
  maxBytes: number;
}

/** A listing page's text and where its original bytes are archived. */
export interface ListingPageRead {
  body: string;
  archiveKey: string;
  creditCost: number | null;
  fromArchive: boolean;
}

const MEDIA = { html: "text/html", json: "application/json" } as const;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function optionsFor(settings: ScraperApiCaptureSettings, channel: ChannelId): ScraperApiOptions {
  const own = Object.entries(settings.channels[channel] ?? {}).filter(
    ([, value]) => value !== undefined,
  );
  return { ...settings.defaults, ...Object.fromEntries(own) };
}

/** Refuses anything but a 200 answer of the expected type, uncompressed and non-empty. */
function checkAnswer(
  answer: { status: number; contentType: string | null; contentEncoding: string | null },
  expected: "html" | "json",
): void {
  if (answer.status === 404 || answer.status === 410) {
    throw brandScanErrors.create("BRAND_SCAN.NOT_FOUND", { details: { status: answer.status } });
  }
  if (answer.status !== 200) {
    throw brandScanErrors.create("BRAND_SCAN.HTTP_STATUS", { details: { status: answer.status } });
  }
  if (!(answer.contentType ?? "").toLowerCase().startsWith(MEDIA[expected])) {
    throw brandScanErrors.create(
      expected === "json" ? "BRAND_SCAN.NOT_JSON" : "BRAND_SCAN.NOT_HTML",
    );
  }
  const encoding = answer.contentEncoding?.trim().toLowerCase();
  if (encoding && encoding !== "identity") {
    throw brandScanErrors.create("BRAND_SCAN.ENCODING", { details: { encoding } });
  }
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw brandScanErrors.create("BRAND_SCAN.ENCODING", { cause: error });
  }
}

/**
 * Brand listing pages through ScraperAPI, archived byte for byte in R2 before they are parsed. A page already
 * archived for this scan is read from the archive, never fetched again.
 */
export class ListingPages {
  constructor(
    private readonly deps: {
      client: Pick<ScraperApiClient, "get" | "provider">;
      settings: ScraperApiCaptureSettings;
      remote: ObjectStore;
    },
  ) {}

  async read(request: ListingPageRequest, signal: AbortSignal): Promise<ListingPageRead> {
    const keys = this.keys(request);
    const archived = await this.archived(keys, request, signal);
    if (archived) {
      return {
        body: decode(archived.bytes),
        archiveKey: keys.body,
        creditCost: null,
        fromArchive: true,
      };
    }
    const page = await this.fetch(request, signal);
    checkAnswer(page, request.answer);
    await this.archive(keys, { request, page }, signal);
    return {
      body: decode(page.bytes),
      archiveKey: keys.body,
      creditCost: page.creditCost,
      fromArchive: false,
    };
  }

  private keys(request: ListingPageRequest) {
    const prefix = `v3/brand-scans/${request.scanId}/${request.label}`;
    return { body: `${prefix}.${request.answer}`, record: `${prefix}.record.json` };
  }

  private fetch(request: ListingPageRequest, signal: AbortSignal) {
    const target = allowedTarget(request.url, request.origins).href;
    const tooLarge = () =>
      brandScanErrors.create("BRAND_SCAN.PAGE_LIMIT", { details: { maxBytes: request.maxBytes } });
    const options = optionsFor(this.deps.settings, request.channel);
    return this.deps.client.get({ target, options, maxBytes: request.maxBytes, tooLarge }, signal);
  }

  /** The page bytes first, then the record naming their hash; both read back before the page is parsed. */
  private async archive(
    keys: { body: string; record: string },
    fetched: {
      request: ListingPageRequest;
      page: { url: string; bytes: Uint8Array; creditCost: number | null };
    },
    signal: AbortSignal,
  ): Promise<void> {
    const { request, page } = fetched;
    const record = {
      codec: "brand-scan-page/1",
      url: request.url,
      finalUrl: page.url,
      capturedAt: new Date().toISOString(),
      sha256: sha256(page.bytes),
      byteSize: page.bytes.byteLength,
      provider: this.deps.client.provider,
      creditCost: page.creditCost,
    };
    await this.writeOnce(keys.body, page.bytes, { mediaType: MEDIA[request.answer], signal });
    const recordBytes = Buffer.from(JSON.stringify(record));
    await this.writeOnce(keys.record, recordBytes, { mediaType: "application/json", signal });
  }

  private async writeOnce(
    key: string,
    bytes: Uint8Array,
    target: { mediaType: string; signal: AbortSignal },
  ): Promise<void> {
    await this.deps.remote.create(key, bytes, target.mediaType, target.signal);
    const saved = await this.deps.remote.read(key, bytes.byteLength, target.signal);
    if (!saved || sha256(saved) !== sha256(bytes)) {
      throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", { details: { key } });
    }
  }

  /** The archived page when both files exist and agree; a partial archive is refused, never refetched. */
  private async archived(
    keys: { body: string; record: string },
    request: ListingPageRequest,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array } | null> {
    const recordBytes = await this.deps.remote.read(keys.record, 65_536, signal);
    if (!recordBytes) {
      // A body without its record is an earlier download whose archive never finished: stop, never pay again.
      if (await this.deps.remote.read(keys.body, request.maxBytes, signal)) {
        throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", {
          details: { key: keys.body },
        });
      }
      return null;
    }
    const record = JSON.parse(decode(recordBytes)) as { sha256?: string };
    const bytes = await this.deps.remote.read(keys.body, request.maxBytes, signal);
    if (!bytes || sha256(bytes) !== record.sha256) {
      throw brandScanErrors.create("BRAND_SCAN.ARCHIVE_UNVERIFIED", {
        details: { key: keys.body },
      });
    }
    return { bytes };
  }
}
