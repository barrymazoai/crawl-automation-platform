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
      "Switch the job list to the release",
      "Restart the jobs that changed",
      "Check the jobs are healthy",
    ]);
  });

  it("upgrades the database only when asked, with a backup first, before the switch", () => {
    const steps = titles(true);
    const switchAt = steps.indexOf("Switch the job list to the release");
    expect(steps.slice(switchAt - 5, switchAt)).toEqual([
      "Check V3_DATABASE_URL is set",
      "Database status",
      "Back up the database",
      "Upgrade the database",
      "Database status after the upgrade",
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
