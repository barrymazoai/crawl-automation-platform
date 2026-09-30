import { randomUUID } from "node:crypto";
import {
  appErrors,
  EvidenceCaptureResultSchema,
  EvidenceTestPrefixSchema,
  type EvidenceCaptureRequest,
  type EvidenceCaptureResult,
} from "@crawl-automation/app";
import { sha256, type ObjectStore } from "@crawl-automation/platform";
import { ObjectKeySchema } from "@crawl-automation/v3-contracts";

export interface EvidenceTarget {
  url: string;
  externalId: string;
  variantId: string | null;
}

export interface EvidenceReservation {
  directory: string;
  captureId: string;
  request: EvidenceCaptureRequest;
  target: EvidenceTarget;
}

export interface EvidenceDownload {
  bytes: Uint8Array;
  finalUrl: string;
  status: number;
  capturedAt: string;
  fetchedVia: unknown;
}

/** Immutable objects in a store scoped to testPrefix, with full bucket keys returned to callers. */
export class EvidenceArchive {
  private readonly prefix: string;

  constructor(
    private readonly remote: ObjectStore,
    testPrefix: string,
  ) {
    this.prefix = EvidenceTestPrefixSchema.parse(testPrefix);
  }

  /** An intent is written once before spending credits; an unknown write never starts a download. */
  async reserve(
    request: EvidenceCaptureRequest,
    target: EvidenceTarget,
    signal: AbortSignal,
  ): Promise<EvidenceReservation> {
    const directory = ObjectKeySchema.parse(`${request.channel}/${target.externalId}`);
    const captureId = randomUUID();
    const reservation = { directory, captureId, request, target };
    const bytes = Buffer.from(JSON.stringify(reservation));
    await this.create(
      `${directory}/${captureId}.request.json`,
      { bytes, type: "application/json" },
      signal,
    );
    return reservation;
  }

  /** Saves originals and provenance before any parsing, then verifies both objects byte for byte. */
  async save(
    reservation: EvidenceReservation,
    download: EvidenceDownload,
    signal: AbortSignal,
  ): Promise<EvidenceCaptureResult> {
    const stamp = download.capturedAt.replaceAll(":", "-");
    const key = ObjectKeySchema.parse(
      `${reservation.directory}/${stamp}-${reservation.captureId}.html`,
    );
    const result = EvidenceCaptureResultSchema.parse({
      key: `${this.prefix}/${key}`,
      sha256: sha256(download.bytes),
      size: download.bytes.byteLength,
      capturedAt: download.capturedAt,
      finalUrl: download.finalUrl,
      status: download.status,
    });
    const manifestKey = key.replace(/\.html$/, ".json");
    const manifest = Buffer.from(
      JSON.stringify({
        codec: "test-page/1",
        ...result,
        ...reservation,
        fetchedVia: download.fetchedVia,
      }),
    );
    await this.create(key, { bytes: download.bytes, type: "text/html" }, signal);
    await this.create(manifestKey, { bytes: manifest, type: "application/json" }, signal);
    await this.verify(key, download.bytes, signal);
    await this.verify(manifestKey, manifest, signal);
    return result;
  }

  private async create(
    key: string,
    object: { bytes: Uint8Array; type: string },
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.remote.create(key, object.bytes, object.type, signal);
    if (result !== "created") {
      throw appErrors.create("EVIDENCE.ARCHIVE_CONFLICT", {
        details: { key: `${this.prefix}/${key}` },
      });
    }
  }

  private async verify(key: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
    const saved = await this.remote.read(key, bytes.byteLength, signal);
    if (!saved || saved.byteLength !== bytes.byteLength || sha256(saved) !== sha256(bytes)) {
      throw appErrors.create("EVIDENCE.ARCHIVE_UNVERIFIED", {
        details: { key: `${this.prefix}/${key}` },
      });
    }
  }
}
