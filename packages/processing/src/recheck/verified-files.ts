import { isDeepStrictEqual } from "node:util";
import { verifyBytes } from "@crawl-automation/platform";
import {
  assertArtifactBelongsTo,
  type ArtifactRef,
  type Observation,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { reviewDigest } from "../step/review-record.js";
import { recheckErrors } from "./errors.js";
import type { SavedAnswerDeps } from "./types.js";

export function assertRecheckIdentity(actual: unknown, expected: unknown): void {
  if (!isDeepStrictEqual(actual, expected)) {
    throw recheckErrors.create("RECHECK.IDENTITY_CONFLICT");
  }
}

/** Reads only; never fills an absent object by invoking its producer. */
export class RecheckFiles {
  constructor(private readonly objects: SavedAnswerDeps["objects"]) {}

  async bytes(key: string, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    const bytes = await this.objects.read(key, 32 * 1024 * 1024, signal);
    if (!bytes) {
      throw recheckErrors.create("RECHECK.EVIDENCE_UNAVAILABLE", { details: { key } });
    }
    return bytes;
  }

  async json(key: string, signal: AbortSignal): Promise<unknown> {
    return decodeJson(await this.bytes(key, signal));
  }

  async artifact(ref: ArtifactRef, owner: Observation, signal: AbortSignal) {
    assertArtifactBelongsTo(ref, owner);
    const bytes = await this.bytes(ref.objectKey, signal);
    verifyBytes(ref, bytes, 32 * 1024 * 1024);
    return bytes;
  }
}

export const recheckDigest = reviewDigest;
