import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexTextModel } from "../text/model/codex-text-model.js";
import { createBrandResearchTasks } from "./index.js";
import { brand, deps } from "./fixtures.test-support.js";
import { checkedDependencies } from "./settings.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function fixture(response: string) {
  const close = vi.fn(async () => undefined);
  const interpret = vi.fn(async () => response);
  const model = { close, interpret } as unknown as CodexTextModel;
  const open = vi.spyOn(CodexTextModel, "open").mockResolvedValue(model);
  const settings = deps(tmpdir());
  return { tasks: createBrandResearchTasks(settings), settings, open, interpret, close };
}

describe("tool-free task adapters", () => {
  it("uses the existing client once per round and closes each owned client", async () => {
    const opened = fixture(
      JSON.stringify({ action: "give_up", note: "No organization tied to this brand." }),
    );
    await opened.tasks.apolloJudge.next(
      { brand, rounds: [], searchesLeft: 0 },
      AbortSignal.timeout(3000),
    );
    expect(opened.open).toHaveBeenCalledWith(opened.settings.text, opened.settings.environment);
    expect(opened.interpret).toHaveBeenCalledOnce();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.interpret).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: expect.any(Object),
        prompt: expect.stringContaining("no browser, tools"),
      }),
      expect.any(AbortSignal),
    );
  });
  it("uses a separate turn for ownership and validates its output", async () => {
    const opened = fixture(
      JSON.stringify({ verdict: "independent", confidence: 0.9, reason: "No clue" }),
    );
    await expect(
      opened.tasks.reviewer.review(
        { brand, clues: [], checkedUrls: [] },
        AbortSignal.timeout(3000),
      ),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.ANSWER_INVALID" });
    expect(opened.close).toHaveBeenCalledOnce();
  });
  it("closes even when decoding fails or the provider throws", async () => {
    const opened = fixture("invalid JSON");
    const input = {
      titles: ["Sales Director"],
      taxonomy: { functions: ["Sales"], levels: ["Director"] },
    };
    await expect(
      opened.tasks.titles.classify(input, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.ANSWER_INVALID" });
    opened.interpret.mockRejectedValueOnce(new Error("provider failed"));
    await expect(opened.tasks.titles.classify(input, AbortSignal.timeout(3000))).rejects.toThrow(
      "provider failed",
    );
    expect(opened.close).toHaveBeenCalledTimes(2);
  });
  it("does not spend a turn on an empty title batch", async () => {
    const opened = fixture("{}");
    expect(
      await opened.tasks.titles.classify(
        { titles: [], taxonomy: { functions: ["Sales"], levels: ["VP"] } },
        AbortSignal.timeout(3000),
      ),
    ).toEqual([]);
    expect(opened.open).not.toHaveBeenCalled();
  });
  it("takes capture model/effort from text configuration rather than hard-coding or borrowing the DTC model", () => {
    const settings = deps(tmpdir());
    settings.capture = {
      ...settings.capture,
      settings: { ...settings.capture.settings, model: "dtc-other", reasoningEffort: "high" },
    };
    expect(checkedDependencies(settings).capture.settings).toEqual(settings.text.settings);
    expect(() => checkedDependencies({ ...settings, workRoot: "relative" })).toThrow(
      expect.objectContaining({ code: "BRAND_RESEARCH.SETTINGS_INVALID" }),
    );
  });
});
