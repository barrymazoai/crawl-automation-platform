import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CodexTextModel } from "../text/model/codex-text-model.js";
import { checkedAnswer } from "./answer.js";
import type { BrandResearchDeps } from "./settings.js";

/** Adapter: each task gets a fresh, tool-free app-server turn and closes its client in all outcomes. */
export async function textAnswer<Answer>(
  deps: BrandResearchDeps,
  request: { task: string; prompt: string; schema: z.ZodType<Answer> },
  signal: AbortSignal,
): Promise<Answer> {
  signal.throwIfAborted();
  const model = await CodexTextModel.open(deps.text, deps.environment);
  try {
    const raw = await model.interpret(
      {
        operationId: `brand-${request.task}-${randomUUID()}`,
        prompt: request.prompt,
        outputSchema: z.toJSONSchema(request.schema),
      },
      signal,
    );
    return checkedAnswer(request.schema, raw, request.task);
  } finally {
    await model.close();
  }
}
