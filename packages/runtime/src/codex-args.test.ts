import { describe, expect, it } from "vitest";
import { CodexProcessRunner } from "./index.js";

const input = { cwd: "/repo", schemaPath: "/s.json", outputPath: "/out/x.json", addDirectories: ["/job"] };

describe("codex exec 参数", () => {
  it("给了 serviceTier 才传 -c service_tier（Fast mode）", () => {
    const args = CodexProcessRunner.buildArgs({ model: "gpt-5.6-luna", reasoningEffort: "medium", serviceTier: "fast" }, input);
    const i = args.indexOf("service_tier=\"fast\"");
    expect(i).toBeGreaterThan(0);
    expect(args[i - 1]).toBe("-c");
    expect(args).toContain("model_reasoning_effort=\"medium\"");
  });

  it("不给 serviceTier 就不传，沿用 Codex 默认档", () => {
    const args = CodexProcessRunner.buildArgs({ model: "gpt-5.6-luna", reasoningEffort: "medium" }, input);
    expect(args.some((a) => a.startsWith("service_tier="))).toBe(false);
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--add-dir");
  });
});
