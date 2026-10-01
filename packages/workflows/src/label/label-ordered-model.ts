import { z } from "zod";
import type { Walk } from "./label-image-first.js";

export const SourceFailureSchema = z.strictObject({
  sourceId: z.string(),
  code: z.string(),
  executionFact: z.string(),
});

export interface OrderedWalk extends Walk {
  ordered: true;
  complete: boolean;
  reason?: z.infer<typeof SourceFailureSchema>;
}
