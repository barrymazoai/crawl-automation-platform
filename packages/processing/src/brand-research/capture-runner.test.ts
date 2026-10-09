import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EgoAgentPage, runCodexCapture } from "@crawl-automation/platform";
import { createBrandResearchTasks } from "./index.js";
import { deps, family, page, research, subject } from "./fixtures.test-support.js";

vi.mock("@crawl-automation/platform", async (original) => {
  const actual = await original<typeof import("@crawl-automation/platform")>();
  return { ...actual, EgoAgentPage: { open: vi.fn() }, runCodexCapture: vi.fn() };
});
const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "brand-capture-"));
  roots.push(root);
  await writeFile(join(root, "SKILL.md"), "fixture skill");
  const close = vi.fn(async () => undefined);
  const opened = {
    targetId: "task-target",
    label: "task-page",
    preparationModule: () => "// fixture",
    close,
  };
  vi.mocked(EgoAgentPage.open).mockResolvedValue(opened as unknown as EgoAgentPage);
  const publish = vi.fn(async () => undefined);
  const settings = { ...deps(root), publication: { publish } };
  return { settings, tasks: createBrandResearchTasks(settings), close, publish };
}

async function writePage(cwd: string) {
  const { html, archiveKey: _archiveKey, ...receipt } = page(subject.brandUrl);
  await writeFile(join(cwd, receipt.path), html);
  await writeFile(join(cwd, "pages.jsonl"), `${JSON.stringify(receipt)}\n`);
}

describe("owned browser capture lifecycle", () => {
  it("uses analysis capture, selected model settings, host skills and exact-page cleanup", async () => {
    const opened = await fixture();
    vi.mocked(runCodexCapture).mockImplementation(async (settings, request) => {
      expect(settings.settings).toEqual(opened.settings.text.settings);
      expect(request.captureMode).toBe("analysis");
      expect(request.prompt).toContain("task-target");
      expect(JSON.parse(await readFile(join(request.cwd, "skills.json"), "utf8"))).toHaveLength(1);
      await writePage(request.cwd);
      return { status: "complete", result: family, reason: null, webSearchUsed: false };
    });
    const answer = await opened.tasks.familyCheck.check(subject, AbortSignal.timeout(3000));
    expect(answer.archiveKeys.some((key) => key.endsWith(".html"))).toBe(true);
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.publish.mock.invocationCallOrder[0]).toBeGreaterThan(
      opened.close.mock.invocationCallOrder[0] ?? 0,
    );
  });
  it("closes the page and archives prior evidence when the model fails", async () => {
    const opened = await fixture();
    vi.mocked(runCodexCapture).mockImplementation(async (_settings, request) => {
      await writePage(request.cwd);
      throw new Error("fixture model failure");
    });
    await expect(
      opened.tasks.familyCheck.check(subject, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.EXECUTION_FAILED" });
    expect(opened.close).toHaveBeenCalledOnce();
    expect(opened.publish).toHaveBeenCalledWith(
      expect.stringContaining("/pages/"),
      expect.any(Buffer),
      "text/html; charset=utf-8",
      expect.any(AbortSignal),
    );
  });
  it("retains evidence on cancellation with a fresh cleanup/publication signal", async () => {
    const opened = await fixture();
    const controller = new AbortController();
    vi.mocked(runCodexCapture).mockImplementation(async (_settings, request) => {
      await writePage(request.cwd);
      controller.abort();
      controller.signal.throwIfAborted();
    });
    await expect(opened.tasks.familyCheck.check(subject, controller.signal)).rejects.toMatchObject({
      code: "BRAND_RESEARCH.EXECUTION_FAILED",
    });
    expect(opened.close).toHaveBeenCalledOnce();
    const calls = opened.publish.mock.calls as unknown as [string, Buffer, string, AbortSignal][];
    expect(calls.every((call) => !call[3].aborted)).toBe(true);
  });
  it("does not call pending cleanup complete, even if the model succeeded", async () => {
    const opened = await fixture();
    opened.close.mockRejectedValue(new Error("user owns space"));
    vi.mocked(runCodexCapture).mockResolvedValue({
      status: "complete",
      result: family,
      reason: null,
      webSearchUsed: false,
    });
    await expect(
      opened.tasks.familyCheck.check(subject, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({
      code: "BRAND_RESEARCH.EXECUTION_FAILED",
      cause: expect.objectContaining({
        errors: [expect.objectContaining({ code: "BRAND_RESEARCH.CLEANUP_FAILED" })],
      }),
    });
    const calls = opened.publish.mock.calls as unknown as [string, Buffer][];
    const outcome = calls.find(([key]) => key.endsWith("/outcome.json"));
    expect(JSON.parse(outcome?.[1].toString() ?? "{}")).toHaveProperty("cleanup", "pending");
  });
  it("requests native search and refuses a research run that did not use it", async () => {
    const opened = await fixture();
    vi.mocked(runCodexCapture).mockImplementation(async (_settings, request) => {
      expect(request).toHaveProperty("webSearch", "live");
      return {
        status: "blocked",
        result: null,
        reason: "Native search unavailable",
        webSearchUsed: false,
      };
    });
    await expect(
      opened.tasks.researcher.research(subject, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.SEARCH_UNAVAILABLE" });
    expect(opened.close).toHaveBeenCalledOnce();
  });
  it("returns research only after citations have been published", async () => {
    const opened = await fixture();
    vi.mocked(runCodexCapture).mockImplementation(async (_settings, request) => {
      await writePage(request.cwd);
      return { status: "complete", result: research, reason: null, webSearchUsed: true };
    });
    expect(
      await opened.tasks.researcher.research(subject, AbortSignal.timeout(3000)),
    ).toMatchObject({ category: "nutrition" });
    expect(opened.close).toHaveBeenCalledOnce();
  });
  it("still cleans up on a malformed model answer", async () => {
    const opened = await fixture();
    vi.mocked(runCodexCapture).mockResolvedValue({ result: "wrong" });
    await expect(
      opened.tasks.familyCheck.check(subject, AbortSignal.timeout(3000)),
    ).rejects.toMatchObject({ code: "BRAND_RESEARCH.ANSWER_INVALID" });
    expect(opened.close).toHaveBeenCalledOnce();
  });
});
