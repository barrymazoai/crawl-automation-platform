import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EgoAgentPage } from "@crawl-automation/platform";
import { brandResearchErrors } from "./errors.js";
import type { ResearchWorkspace } from "./workspace.js";

export interface CaptureCleanup {
  page: EgoAgentPage | undefined;
  workspace: ResearchWorkspace;
  failures: unknown[];
}

export async function closeCapture(input: CaptureCleanup) {
  let cleanup = input.page ? "pending" : "no_page_returned";
  try {
    await input.page?.close();
    if (input.page) {
      cleanup = "verified_absent";
    }
  } catch (cause) {
    input.failures.push(brandResearchErrors.create("BRAND_RESEARCH.CLEANUP_FAILED", { cause }));
  }
  const outcome = {
    cleanup,
    targetId: input.page?.targetId ?? null,
    observedAt: new Date().toISOString(),
    failures: input.failures.map((cause) => String(cause).slice(0, 2000)),
  };
  await writeFile(join(input.workspace.cwd, "outcome.json"), JSON.stringify(outcome), {
    flag: "wx",
    mode: 0o600,
  });
}
