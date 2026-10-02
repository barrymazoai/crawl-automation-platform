import { expect, it } from "vitest";
import { ResourceDecisionSchema } from "./resources.js";

it("accepts explicit browser infrastructure waits and preserves the old decision reasons", () => {
  for (const reason of ["unhealthy", "capacity", "browser:BROWSER.UNAVAILABLE", "browser:BROWSER.USER_CONTROL", "browser:BROWSER.SPACE_MISSING", "browser:BROWSER.TIMEOUT"]) {
    expect(ResourceDecisionSchema.parse({permitId: "permit-one", status: "waiting", reason}).reason).toBe(reason);
  }
  expect(ResourceDecisionSchema.safeParse({permitId: "permit-one", status: "waiting", reason: "browser:arbitrary page verdict"}).success).toBe(false);
});
