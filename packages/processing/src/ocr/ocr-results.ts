import type { ObjectStore } from "@crawl-automation/platform";
import type { OcrInput, OcrOutput, OcrRegistration } from "@crawl-automation/v3-contracts";
import type { ResultFacts, ResultRegistry } from "../results/result-kind.js";
import { ResultRecovery } from "../results/result-recovery.js";
import { ResultStore } from "../results/result-store.js";
import { ocrResultKind } from "./ocr-kind.js";

export interface OcrResultsDeps {
  local: ObjectStore;
  remote: ObjectStore;
  /** Null for a cloud-mode worker: it keeps results locally and in R2 but never touches the ledger. */
  registry: ResultRegistry<OcrRegistration> | null;
  storageId: string;
}

export type OcrFacts = ResultFacts<OcrRegistration>;

/** OCR results: the shared result store with the OCR kind, plus reading and registering what R2 holds. */
export class OcrResults extends ResultStore<OcrInput, OcrOutput, OcrRegistration> {
  private readonly recovery: ResultRecovery<OcrInput, OcrOutput, OcrRegistration>;

  constructor(deps: OcrResultsDeps) {
    const storeDeps = { ...deps, kind: ocrResultKind };
    super(storeDeps);
    this.recovery = new ResultRecovery(this, storeDeps);
  }

  /** Read-only: the record rebuilt from R2 alone, for a worker without a ledger. */
  inspectRemote(input: unknown, signal: AbortSignal): Promise<OcrFacts> {
    return this.recovery.inspectRemote(input, signal);
  }

  /** Registers what a cloud worker left in R2, after rebuilding and checking every byte of it. */
  registerFromRemote(input: unknown, signal: AbortSignal): Promise<OcrFacts> {
    return this.recovery.registerFromRemote(input, signal);
  }
}
