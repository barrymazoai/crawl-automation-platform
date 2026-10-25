import type { AgentWarning } from "./agent-result.js";
import type { CaptureFile } from "./archive.js";
import type { MovedOriginal } from "./moved-original.js";

export interface AgentCaptureOutput {
  root: string;
  prefix: string;
  files: CaptureFile[];
  evidenceFiles: CaptureFile[];
  manifestKey: string;
  requireDetailCoverage?: boolean;
  captureContract?: "dtc-materials/1";
  /** The model's own doubt; a catalog with one is never read as complete. */
  agentWarning?: AgentWarning;
  /** Host-verified moved page, present only for a product capture. */
  moved?: MovedOriginal;
}
