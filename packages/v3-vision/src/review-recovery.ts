import { VisionTaskSchema } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import { VisionModule, type VisionDependencies } from "./module.js";

/** Read-only inspection for explicit Review recovery. No execution or publication capability. */
export async function inspectSavedVisionReview(raw: unknown, dependencies: {
  remote: ObjectStore;
  local: ObjectStore;
  verifiedOcrText: VisionDependencies["verifiedOcrText"];
}, signal: AbortSignal) {
  const task = VisionTaskSchema.parse(raw);
  const denied = async (): Promise<never> => { throw Error("VISION.RECOVERY_EXECUTION_DENIED"); };
  const outcome = await new VisionModule({
    provider: { fingerprint: task.configFingerprint, extractionProtocol: task.input.extractionProtocol, interpret: denied },
    store: { read: (...args) => dependencies.remote.read(...args), create: denied },
    localEvidence: { read: (...args) => dependencies.local.read(...args), create: denied },
    verifiedOcrText: dependencies.verifiedOcrText,
    resolve: denied,
  }).run(task.input, signal);
  // An absent, corrupt or unpublished response must not become a new quality diagnosis.
  if (!outcome.replayed || outcome.status !== "review" || !outcome.candidate ||
      outcome.code === "VISION.HANDOFF_PENDING") throw Error("VISION.RECOVERY_NOT_QUALITY_REVIEW");
  return outcome;
}
