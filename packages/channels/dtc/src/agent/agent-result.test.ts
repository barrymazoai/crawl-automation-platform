import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { verifyAgentResult } from "./agent-result.js";

async function analysis(state: string) {
  const outDir = await mkdtemp(join(tmpdir(), "dtc-analysis-"));
  await writeFile(join(outDir, "analysis.json"), JSON.stringify({ state }));
  return { mode: "analysis" as const, outDir, prefix: "v3/test" };
}
const doubt = {
  status: "needs_review" as const,
  summary: "2 regional links not verified",
  reasonCode: "partial",
};

it("keeps a completed analysis when the model only voices a doubt (Sambucol, 2026-10-09)", async () => {
  await expect(verifyAgentResult(doubt, await analysis("completed"))).resolves.toBeNull();
  await expect(verifyAgentResult(doubt, await analysis("needs-review"))).resolves.toBeNull();
});

it("still refuses an analysis file in any other state", async () => {
  await expect(verifyAgentResult(doubt, await analysis("failed"))).rejects.toThrow();
});
