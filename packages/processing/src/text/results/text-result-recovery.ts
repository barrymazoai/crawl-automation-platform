import type { TextInput, TextOutput, TextRecord } from "@crawl-automation/v3-contracts";
import { ResultRecovery } from "../../results/result-recovery.js";
import { textResultKind } from "./text-kind.js";
import type { TextResults, TextResultsDeps } from "./text-results.js";

/** The shared result recovery for text results, under the names the text workers call. */
export class TextResultRecovery extends ResultRecovery<TextInput, TextOutput, TextRecord> {
  constructor(results: TextResults, deps: TextResultsDeps) {
    super(results, { ...deps, kind: textResultKind(deps.evidence) });
  }

  uploadRecoveredResponse(input: TextInput, signal: AbortSignal): Promise<void> {
    return this.uploadRecovered(input, signal).then(() => undefined);
  }
}
