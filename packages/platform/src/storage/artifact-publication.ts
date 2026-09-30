import { recordRecovery } from "../logger/recovery.js";
import { withCause } from "../errors/with-cause.js";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import { errorCodeOf } from "../errors/error-code.js";
import { artifactErrors } from "./artifact-errors.js";
import { verifyBytes } from "./integrity.js";
import type { ObjectStore } from "./object-store.js";

/** One conditional PUT and one verification GET, including when the PUT receipt is lost. */
export async function publishArtifact(
  remote: ObjectStore,
  input: { ref: ArtifactRef; bytes: Uint8Array; maxBytes: number },
  signal: AbortSignal,
): Promise<void> {
  const { ref, bytes, maxBytes } = input;
  try {
    await remote.create(ref.objectKey, bytes, ref.mediaType, signal);
  } catch (error) {
    signal.throwIfAborted();
    recordRecovery(error, { operation: "artifact.publish" });
    if (errorCodeOf(error) !== "ARTIFACT.UPLOAD_UNKNOWN") {
      throw error;
    }
  }
  const actual = await readPublication(remote, ref, signal);
  try {
    verifyBytes(ref, actual, maxBytes);
  } catch (error) {
    throw withCause(artifactErrors.create("ARTIFACT.KEY_CONFLICT"), error);
  }
}

async function readPublication(remote: ObjectStore, ref: ArtifactRef, signal: AbortSignal) {
  let actual;
  try {
    actual = await remote.read(ref.objectKey, ref.byteSize, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (errorCodeOf(error) === "ARTIFACT.TOO_LARGE") {
      throw withCause(artifactErrors.create("ARTIFACT.KEY_CONFLICT"), error);
    }
    throw withCause(artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN"), error);
  }
  if (!actual) {
    throw artifactErrors.create("ARTIFACT.UPLOAD_UNKNOWN");
  }
  return actual;
}
