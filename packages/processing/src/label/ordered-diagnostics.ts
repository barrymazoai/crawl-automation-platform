import { sha256 } from "@crawl-automation/platform";
import { z } from "zod";
import { OrderedProgressSchema } from "./ordered-model.js";

/** Immutable per-prefix report: no workflow input/result change and no mutable latest pointer. */
export function orderedProgressKey(input: { operationId: string }, states: unknown[]) {
  const attempted = states.filter(
    (state) =>
      !(typeof state === "object" && state && "status" in state && state.status === "not_started"),
  );
  const canonical = OrderedProgressSchema.shape.states.parse(attempted);
  const digest = sha256(Buffer.from(JSON.stringify(canonical)));
  return `v3/channel-labels/${input.operationId}/progress/${digest}.json`;
}

export const OrderedDiagnosticsSchema = z.object({
  request: OrderedProgressSchema,
  outcomes: z
    .array(
      z.object({
        sourceId: z.string(),
        status: z.string(),
        code: z.string().nullable(),
        codes: z.array(z.string()),
        missing: z.array(z.string()),
        evidenceKeys: z.array(z.string()),
      }),
    )
    .max(100),
  codes: z.array(z.string()),
});
