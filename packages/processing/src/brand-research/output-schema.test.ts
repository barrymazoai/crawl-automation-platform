import { ApolloStepSchema, ReviewerVerdictSchema } from "@crawl-automation/v3-contracts";
import { expect, it } from "vitest";
import { wrappedOutput } from "./output-schema.js";

it("sends an object root with no oneOf, which the provider refuses", () => {
  for (const { jsonSchema } of [
    wrappedOutput(ApolloStepSchema),
    wrappedOutput(ReviewerVerdictSchema),
  ]) {
    const text = JSON.stringify(jsonSchema);
    expect(jsonSchema).toMatchObject({ type: "object", required: ["answer"] });
    expect(text).not.toContain('"oneOf"');
    expect(text).toContain('"anyOf"');
  }
  const { wrapper } = wrappedOutput(ApolloStepSchema);
  expect(wrapper.safeParse({ answer: { action: "give_up", note: "none" } }).success).toBe(true);
});
