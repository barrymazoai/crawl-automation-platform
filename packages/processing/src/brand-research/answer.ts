import { z } from "zod";
import { brandResearchErrors } from "./errors.js";

/** Zod is the sole wire decoder; malformed JSON and schema failures are never fallback answers. */
export function checkedAnswer<Answer>(
  schema: z.ZodType<Answer>,
  raw: unknown,
  task: string,
): Answer {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch (cause) {
      throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", {
        cause,
        details: { task, reason: "invalid_json" },
      });
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw brandResearchErrors.create("BRAND_RESEARCH.ANSWER_INVALID", {
      cause: parsed.error,
      details: { task, issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) },
    });
  }
  return parsed.data;
}
