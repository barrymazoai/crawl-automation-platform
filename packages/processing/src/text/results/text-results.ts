import type { ObjectStore } from "@crawl-automation/platform";
import type { TextInput, TextOutput, TextRecord } from "@crawl-automation/v3-contracts";
import type { ResultRegistry } from "../../results/result-kind.js";
import { encodeJson } from "../../results/result-record.js";
import { ResultStore } from "../../results/result-store.js";
import { textLimits } from "../limits.js";
import type { TextSource } from "../ports.js";
import { claimTextIntent } from "../step/text-intent.js";
import { textResultKind } from "./text-kind.js";
import { textKeys } from "./text-record.js";

export interface TextResultsDeps {
  local: ObjectStore;
  remote: ObjectStore;
  /** Null for a cloud-mode worker: it keeps evidence locally and remotely but never touches the ledger. */
  registry: ResultRegistry<TextRecord> | null;
  evidence: TextSource;
  storageId: string;
}

/** A text task's result files and ledger entry: the shared result store, plus the text step's own files. */
export class TextResults extends ResultStore<TextInput, TextOutput, TextRecord> {
  constructor(private readonly textDeps: TextResultsDeps) {
    super({ ...textDeps, kind: textResultKind(textDeps.evidence) });
  }

  /** The task's verified source text. */
  resolveSource(input: TextInput, signal: AbortSignal) {
    return this.textDeps.evidence.resolve(input, signal);
  }

  /** Claims the only right to call the model for this task (see claimIntent). */
  claimIntent(input: TextInput, nodeId: string, signal: AbortSignal): Promise<void> {
    const claim = { input, storageId: this.textDeps.storageId, nodeId };
    return claimTextIntent(this.textDeps.remote, claim, signal);
  }

  /** Keeps the model's raw answer before it is checked, so a failed check can still be inspected. */
  async retainResponse(input: TextInput, rawResponse: string): Promise<void> {
    const entry = { key: textKeys.response(input), bytes: encodeJson({ input, rawResponse }) };
    await this.put(this.textDeps.local, entry, AbortSignal.timeout(textLimits.retentionMs));
  }
}
