import { z } from "zod";

/**
 * The provider's structured output takes an object at the root and refuses `oneOf` anywhere (seen 2026-10-09:
 * "In context=(), 'oneOf' is not permitted"). Zod writes a discriminated union as `oneOf`; each branch here already
 * excludes the others by its literal tag, so `anyOf` means the same. The answer is wrapped as `{ answer }`.
 */
export function wrappedOutput<Answer>(schema: z.ZodType<Answer>) {
  const wrapper = z.object({ answer: schema });
  return { wrapper, jsonSchema: withoutOneOf(z.toJSONSchema(wrapper)) as object };
}

function withoutOneOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutOneOf);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key === "oneOf" ? "anyOf" : key,
      withoutOneOf(item),
    ]),
  );
}
