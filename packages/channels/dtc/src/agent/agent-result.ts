import { access, readFile } from "node:fs/promises";
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
  // Partial site analyses still pass the full analysis/evidence validation after archiving. The model's own doubt does
  // not overrule an analysis it wrote as completed (Sambucol, 2026-10-09: "2 regional links not verified separately",
  // analysis.json state completed with the brand verified); the host's analysis checks decide.
  if (at.mode === "analysis" && result.status === "needs_review") {
    const analysis = JSON.parse(await readFile(join(at.outDir, "analysis.json"), "utf8"));
    z.object({ state: z.enum(["needs-review", "completed"]) }).parse(analysis);
    return null;
  }
  // A product capture with doubts continues when host verification of its retained materials passes
  // (owner 2026-10-05): only a wrong product or missing/corrupt materials stop it. A catalog with doubts that
  // still produced catalog.json is read as a partial scan (owner 2026-10-06); without it, it stays a Review.
  const keptCatalog =
    at.mode === "catalog" &&
    (await access(join(at.outDir, "catalog.json")).then(
      () => true,
      () => false,
    ));
  if ((at.mode === "product" || keptCatalog) && result.status === "needs_review") {
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
