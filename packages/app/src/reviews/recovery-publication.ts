import { sha256, recordRecovery, type ObjectStore } from "@crawl-automation/platform";
import { recheckErrors, type RecheckFile } from "@crawl-automation/processing";

/** Immutable derived files only. An uncertain write is read back once; never redownload or call a provider. */
export async function publishRecoveryFiles(
  objects: ObjectStore,
  files: RecheckFile[],
  signal: AbortSignal,
) {
  for (const file of files) {
    signal.throwIfAborted();
    if (file.bytes.length > 8 * 1024 * 1024) {
      throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED");
    }
    let saved = await objects.read(file.key, file.bytes.length, signal);
    if (!saved) {
      try {
        await objects.create(file.key, file.bytes, "application/json", signal);
      } catch (error) {
        recordRecovery(error, { operation: "reviews.recover", key: file.key });
      }
      saved = await objects.read(file.key, file.bytes.length, signal);
    }
    if (!saved || sha256(saved) !== sha256(file.bytes)) {
      throw recheckErrors.create("RECHECK.PUBLICATION_UNVERIFIED", { details: { key: file.key } });
    }
  }
}
