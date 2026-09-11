import { z } from "zod";
import { ObservationSchema, ExecutionIdSchema, KeywordResultSchema, type KeywordResult } from "@crawl-automation/v3-contracts";
const manifest = z.strictObject({ observation: ObservationSchema, closed: z.boolean(),
  imageIds: z.array(ExecutionIdSchema).max(1000).refine(a => new Set(a).size === a.length) });
/** Workflow-safe decision. No filesystem, network, calls, timers, or implicit vision fallback. */
export function imageProductDecision(rawManifest: unknown, rawResults: unknown[]) {
  const m = manifest.parse(rawManifest), results = rawResults.map(r => KeywordResultSchema.parse(r));
  const ids = new Set<string>();
  for (const r of results) {
    if (JSON.stringify(r.observation) !== JSON.stringify(m.observation) || !m.imageIds.includes(r.image.artifactId) || ids.has(r.image.artifactId))
      throw Error("SCREEN.PRODUCT_CONFLICT");
    ids.add(r.image.artifactId);
  }
  const selected: KeywordResult[] = results.filter(r => r.status === "matched");
  // Callers may dispatch each selected image immediately; terminal no-match requires a closed, complete set.
  if (!m.closed || results.length !== m.imageIds.length) return { status: "pending" as const, selected };
  if (!selected.length) return { status: "review" as const, selected, code: "SCREEN.NO_LABEL_EVIDENCE", automaticRetry: false as const };
  return { status: "selected" as const, selected };
}
