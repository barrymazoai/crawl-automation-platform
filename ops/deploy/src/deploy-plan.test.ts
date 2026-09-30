import { describe, expect, it } from "vitest";
import { deployPlan, releaseSource } from "./deploy-plan.js";
import { COMMIT, serverOne } from "./testing.js";

const titles = (migrate: boolean) =>
  deployPlan(serverOne(), { commit: COMMIT, migrate }).map((step) => step.title);

describe("deploy plan", () => {
  it("clones main fresh, installs locked, builds each app once, then switches, restarts and checks", () => {
    expect(titles(false)).toEqual([
      "Check the release directory is new",
      "Clone origin",
      "Check the commit is on main",
      "Check out the commit",
      "Install locked dependencies",
      "Build api",
      "Build worker",
      "Write the PM2 file, replace changed jobs and wait for ready",
    ]);
  });

  it("upgrades the database only when asked, with a backup first, before the switch", () => {
    const steps = titles(true);
    const switchAt = steps.indexOf("Write the PM2 file, replace changed jobs and wait for ready");
    expect(steps.slice(switchAt - 2, switchAt)).toEqual([
      "Check V3_DATABASE_URL is set",
      "Validate, back up, migrate and recheck the database",
    ]);
  });

  it("puts each release in its own directory under the machine's root", () => {
    expect(releaseSource(serverOne(), COMMIT)).toBe(`/srv/crawler/releases/${COMMIT}/source`);
  });

  it.each([
    ["a short commit", "68adac2"],
    ["a branch name", "main"],
  ])("refuses %s", (_case, commit) => {
    expect(() => deployPlan(serverOne(), { commit, migrate: false })).toThrow(
      expect.objectContaining({ code: "DEPLOY.COMMIT_INVALID" }),
    );
  });

  it("refuses --migrate without migration settings", () => {
    expect(() =>
      deployPlan(serverOne({ migrations: undefined }), { commit: COMMIT, migrate: true }),
    ).toThrow(expect.objectContaining({ code: "DEPLOY.MIGRATIONS_NOT_CONFIGURED" }));
  });
});
