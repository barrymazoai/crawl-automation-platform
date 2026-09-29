import { verifyBytes } from "@crawl-automation/v3-artifacts";
import type { ArtifactRef } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/platform";
import { textLimits } from "../limits.js";

/** The artifact is in R2 with exactly its recorded bytes; missing is false, damaged is an error. */
export async function isDurable(
  remote: ObjectStore,
  ref: ArtifactRef,
  signal: AbortSignal,
): Promise<boolean> {
  const maxBytes = Math.min(ref.byteSize, textLimits.sourceBytes);
  const bytes = await remote.read(ref.objectKey, maxBytes, signal);
  if (!bytes) {
    return false;
  }
  verifyBytes(ref, bytes, textLimits.sourceBytes);
  return true;
}

/** Checks every artifact, even after a missing one, so a damaged one is always reported. */
export async function allDurable(
  remote: ObjectStore,
  refs: readonly ArtifactRef[],
  signal: AbortSignal,
): Promise<boolean> {
  let durable = true;
  for (const ref of refs) {
    if (!(await isDurable(remote, ref, signal))) {
      durable = false;
    }
  }
  return durable;
}
