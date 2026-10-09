import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CodexTextModel } from "../text/model/codex-text-model.js";
import { checkedAnswer } from "./answer.js";
import { wrappedOutput } from "./output-schema.js";
import type { BrandTextDeps } from "./settings.js";

/** Adapter: each task gets a fresh, tool-free app-server turn and closes its client in all outcomes. */
export async function textAnswer<Answer>(
  deps: BrandTextDeps,
  request: { task: string; prompt: string; schema: z.ZodType<Answer> },
  signal: AbortSignal,
): Promise<Answer> {
  signal.throwIfAborted();
  const { wrapper, jsonSchema } = wrappedOutput(request.schema);
  const model = await CodexTextModel.open(deps.text, deps.environment);
  try {
    const raw = await model.interpret(
      {
        operationId: `brand-${request.task}-${randomUUID()}`,
        prompt: request.prompt,
        outputSchema: jsonSchema,
      },
      signal,
    );
    return checkedAnswer(wrapper, raw, request.task).answer;
  } finally {
    await model.close();
  }
}
