import { sha256, type RetainedPublication } from "@crawl-automation/platform";
import {
  ChannelProductEvidenceSchema,
  DtcGalleryTaskSchema,
  DtcGalleryRefSchema,
  type DtcGalleryRef,
} from "@crawl-automation/v3-contracts";
export class GalleryStore {
  constructor(readonly publication: RetainedPublication) {}
  async task(ref: DtcGalleryRef, signal: AbortSignal) {
    return DtcGalleryTaskSchema.parse(await this.read(ref, signal));
  }
  async read(ref: DtcGalleryRef, signal: AbortSignal): Promise<unknown> {
    const bytes = await this.publication.remote.read(ref.objectKey, ref.byteSize, signal);
    if (!bytes || bytes.length !== ref.byteSize || sha256(bytes) !== ref.sha256) {
      throw new Error("DTC.GALLERY_INTEGRITY");
    }
    return JSON.parse(Buffer.from(bytes).toString());
  }

  async save(key: string, value: unknown, signal: AbortSignal): Promise<DtcGalleryRef> {
    const bytes = Buffer.from(JSON.stringify(value));
    const ref = DtcGalleryRefSchema.parse({
      objectKey: key,
      sha256: sha256(bytes),
      byteSize: bytes.length,
    });
    await this.publication.publish(key, bytes, "application/json", signal);
    return ref;
  }
}
export function galleryEvidence(raw: unknown) {
  return ChannelProductEvidenceSchema.parse(
    raw && typeof raw === "object" && "evidence" in raw ? raw.evidence : raw,
  );
}
