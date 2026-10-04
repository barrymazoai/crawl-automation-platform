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
export async function verifyAgentResult(
  result: z.infer<typeof ResultSchema>,
  at: { mode: AgentCaptureRequest["mode"]; outDir: string; prefix: string },
) {
  // Partial site analyses still pass the full analysis/evidence validation after archiving.
  if (at.mode === "analysis" && result.status === "needs_review") {
    const analysis = JSON.parse(await readFile(join(at.outDir, "analysis.json"), "utf8"));
    z.object({ state: z.literal("needs-review") }).parse(analysis);
    return;
  }
  if (result.status !== "complete") {
    throw dtcAgentErrors.create("DTC.CAPTURE_REVIEW", {
      details: { result, prefix: at.prefix },
    });
  }
}
