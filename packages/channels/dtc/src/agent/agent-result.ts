import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dtcAgentErrors } from "./errors.js";
import type { AgentCaptureRequest } from "./request.js";

export const ResultSchema = z.strictObject({
  status: z.enum(["complete", "needs_review", "failed"]),
  summary: z.string(),
  reasonCode: z.string().nullable(),
});
export type AgentResult = z.infer<typeof ResultSchema>;

/** The model's own doubt about a product capture, kept with the handoff instead of stopping it. */
export interface AgentWarning {
  status: "needs_review";
  reasonCode: string | null;
  summary: string;
}

export async function verifyAgentResult(
  result: AgentResult,
  at: { mode: AgentCaptureRequest["mode"]; outDir: string; prefix: string },
): Promise<AgentWarning | null> {
  // Partial site analyses still pass the full analysis/evidence validation after archiving.
  if (at.mode === "analysis" && result.status === "needs_review") {
    const analysis = JSON.parse(await readFile(join(at.outDir, "analysis.json"), "utf8"));
    z.object({ state: z.literal("needs-review") }).parse(analysis);
    return null;
  }
  // A product capture with doubts continues when host verification of its retained materials passes
  // (owner 2026-10-05): only a wrong product or missing/corrupt materials stop it.
  if (at.mode === "product" && result.status === "needs_review") {
    return {
      status: "needs_review",
      reasonCode: result.reasonCode,
      summary: result.summary.slice(0, 2000),
    };
  }
  if (result.status !== "complete") {
    throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW", {
      details: { result, prefix: at.prefix },
    });
  }
  return null;
}
