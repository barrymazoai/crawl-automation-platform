import type { FileHandle } from "node:fs/promises";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { artifactErrors } from "./artifact-errors.js";
import { verifyBytes } from "./integrity.js";
import { logStorageRecovery } from "./storage-logger.js";

export async function readFileCopy(
  file: FileHandle,
  ref: ArtifactRef,
  options: { maxBytes: number; signal: AbortSignal },
): Promise<Uint8Array> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size !== ref.byteSize) {
    throw artifactErrors.create("ARTIFACT.INTEGRITY");
  }
  // One extra byte detects growth after stat without an unbounded allocation.
  const bytes = Buffer.alloc(ref.byteSize + 1);
  let offset = 0;
  while (offset < bytes.length) {
    options.signal.throwIfAborted();
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) {
      break;
    }
    offset += bytesRead;
  }
  const value = bytes.subarray(0, offset);
  verifyBytes(ref, value, options.maxBytes);
  const now = new Date();
  await file.utimes(now, now).catch((error: unknown) => {
    logStorageRecovery("Could not refresh verified local evidence age", error, {
      operationId: ref.producer.operationId,
    });
  });
  return value;
}
