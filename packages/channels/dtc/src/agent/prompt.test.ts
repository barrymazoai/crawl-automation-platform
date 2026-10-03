import { expect, it } from "vitest";
import { capturePrompt } from "./prompt.js";

it.each(["product", "catalog", "analysis"] as const)(
  "scopes the native instructions to %s",
  (mode) => {
    const prompt = capturePrompt({
      mode,
      operationId: "test",
      url: "https://shop.example/collections/all",
      scope: {},
      cwd: "/tmp/task",
      outDir: "/tmp/task/capture",
      skillRoot: "/skills/crawl-products",
      egoSkillPath: "/skills/ego/SKILL.md",
      profileDir: "/tmp/profiles",
      cliPath: "/bin/ego-browser",
      taskSpaceId: 6,
      label: "p1",
      targetId: "owned",
    });
    expect(prompt).toContain(`captureMode:${JSON.stringify(mode)}`);
    expect(prompt).toContain("禁止调用 task.finish()");
    expect(prompt).toContain("Ego skill 中成功时 finish 的默认步骤在本宿主中不适用");
    if (mode === "product") {
      expect(prompt).toContain("runHarvest(browser, tab, plan,");
      expect(prompt).toContain("observedGalleryUrls");
    } else {
      expect(prompt).not.toContain("runHarvest(browser, tab, plan,");
      expect(prompt).toContain("禁止调用 runHarvest");
    }
    if (mode === "catalog") {
      expect(prompt).toContain("实际零增长复核记录");
    }
  },
);
