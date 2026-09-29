import type { LabelAssemblyDeps } from "@crawl-automation/processing";
import { verifyBytes } from "@crawl-automation/v3-artifacts";
import { TextCandidateV3Schema, TextOutputSchema } from "@crawl-automation/v3-contracts";
import { assemblyFailure } from "@crawl-automation/processing";
import type { LabelStores } from "./label-stores.js";

const RESULT_LIMIT = 524_288;

/**
 * Re-verifies a registered label source's original evidence for assembly: a vision answer through its result files,
 * a text answer through its ledger record, its R2 result file and the source text it quotes.
 */
export function labelSourceReader(stores: LabelStores): LabelAssemblyDeps["readSource"] {
  return async (source, signal) => {
    if (source.kind === "image") {
      const read = await stores.visionRecovery.readLabelCandidate(source.task, signal);
      return { id: source.id, kind: "image", ...read };
    }
    const facts = await stores.textResults.inspect(source.task, signal);
    const record = facts.record;
    if (!facts.artifactDurable || !facts.resultRegistered || !record) {
      throw assemblyFailure("LABEL_PRODUCT.TEXT_UNVERIFIED");
    }
    const bytes = await stores.remote.read(record.result.objectKey, RESULT_LIMIT, signal);
    if (!bytes) {
      throw assemblyFailure("LABEL_PRODUCT.TEXT_UNVERIFIED");
    }
    verifyBytes(record.result, bytes, RESULT_LIMIT);
    const output = TextOutputSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    const fullText = (await stores.textEvidence.resolve(source.task, signal)).text;
    return {
      id: source.id,
      kind: "text",
      record,
      candidate: TextCandidateV3Schema.parse(output.candidate),
      fullText,
    };
  };
}
