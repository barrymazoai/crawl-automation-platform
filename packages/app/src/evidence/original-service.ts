import { verifyBytes, type ObjectStore } from "@crawl-automation/platform";
import { appErrors } from "../errors.js";
import {
  EvidenceOriginalInputSchema,
  type EvidenceOriginalInput,
  type EvidenceOriginalResult,
  type OriginalCaptureReader,
} from "./original-model.js";

/** Reads retained originals only; it has no capture or storage-write capability. */
export class OriginalEvidenceService {
  constructor(
    private readonly deps: {
      captures: OriginalCaptureReader;
      objects: Pick<ObjectStore, "read"> | undefined;
    },
  ) {}

  async original(input: EvidenceOriginalInput): Promise<EvidenceOriginalResult> {
    const record = await this.deps.captures.find(EvidenceOriginalInputSchema.parse(input));
    if (!record) {
      throw appErrors.create("EVIDENCE.NOT_FOUND");
    }
    if (!this.deps.objects) {
      throw appErrors.create("EVIDENCE.READ_NOT_CONFIGURED");
    }
    const { source, capture, channel, capturedAt } = record.original;
    const bytes = await this.deps.objects.read(
      source.objectKey,
      source.byteSize,
      AbortSignal.timeout(60_000),
    );
    if (!bytes) {
      throw appErrors.create("EVIDENCE.NOT_FOUND", { details: { key: source.objectKey } });
    }
    verifyBytes(source, bytes, source.byteSize);
    return {
      operationId: record.operationId,
      channel,
      listingId: capture.listingId,
      variantId: capture.variantId,
      capturedAt,
      url: capture.url,
      sha256: source.sha256,
      byteSize: source.byteSize,
      mediaType: source.mediaType,
      html: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    };
  }
}
