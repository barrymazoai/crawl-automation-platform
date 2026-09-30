import { describe, expect, it } from "vitest";
import type {
  OcrRegistration,
  SavedEvidenceSource,
  VisionTask,
} from "@crawl-automation/v3-contracts";
import { KeywordScreening, keywordKey } from "../keywords/keyword-screening.js";
import { LedgerOcrText } from "../keywords/ocr-text.js";
import { hashString } from "../results/result-record.js";
import { defined } from "../testing/defined.js";
import { MemoryReviews } from "../testing/memory-ledgers.js";
import { MemoryStore } from "../testing/memory-store.js";
import { ocrStepSetup, remoteArtifacts } from "../testing/ocr-fixture.js";
import { pageSetup } from "../testing/page-fixture.js";
import { SavedSourceEvidence } from "./saved-sources.js";

const signal = () => AbortSignal.timeout(10_000);
const visionFingerprint = (task: VisionTask) =>
  hashString(JSON.stringify(["vision-input/1", task.input, task.configFingerprint]));
const noOcr = { read: async () => null };
const noImage = async () => Promise.reject(new Error("not an image"));
const noScreen = { screen: noImage, verifiedText: noImage };

async function savedPage(html = "<p>Other ingredients: Water</p>") {
  const setup = pageSetup(html);
  const source: Extract<SavedEvidenceSource, { kind: "page" }> = {
    id: "page",
    kind: "page",
    required: true,
    plan: setup.plan,
  };
  const receipt = await setup.preparation.run(setup.input, signal());
  const prepared = await setup.text.run({ plan: setup.plan, receipt }, signal());
  const deps = {
    remote: setup.remote,
    pages: setup.evidence,
    reviews: setup.reviews,
    ocr: noOcr,
    screen: noScreen,
    visionFingerprint,
  };
  return { ...setup, source, prepared, resolver: new SavedSourceEvidence(deps) };
}

async function savedImage(text: string) {
  const setup = ocrStepSetup();
  setup.api.recognize = async () => ({ text, lines: [] });
  await setup.step.run(setup.input, signal());
  const screen = new LedgerOcrText({
    artifacts: remoteArtifacts(setup.remote),
    results: setup.results,
    registry: setup.registry,
  });
  const record = defined(await setup.registry.read(setup.input.operationId)) as OcrRegistration;
  const selection = await screen.screen(record, signal());
  await new KeywordScreening({
    text: screen,
    local: new MemoryStore(),
    remote: setup.remote,
    reviews: new MemoryReviews(),
  }).run(record, signal());
  const deps = {
    remote: setup.remote,
    pages: { inspect: async () => null },
    ocr: setup.registry,
    screen,
    reviews: new MemoryReviews(),
    visionFingerprint,
  };
  const source: SavedEvidenceSource = {
    id: "label",
    kind: "ocr-image",
    required: true,
    task: setup.input,
    visionOperationId: "vision-operation",
    configFingerprint: "a".repeat(64),
  };
  return { ...setup, selection, source, resolver: new SavedSourceEvidence(deps) };
}

// Cases carried over from the former saved-source resolver.
describe("saved sources", () => {
  it("a saved page resolves only its exact published text task, without parsing or writing", async () => {
    const page = await savedPage();
    const writes = page.remote.writes;
    if (page.prepared.status !== "prepared") {
      throw new Error(JSON.stringify(page.prepared));
    }
    const task = page.prepared.task;
    expect(
      await page.resolver.resolve(page.source, { id: "page", status: "registered" }, signal()),
    ).toEqual({
      status: "resolved",
      source: { id: "page", kind: "text", required: true, task },
    });
    expect(
      await page.resolver.resolve(page.source, { id: "page", status: "unresolved" }, signal()),
    ).toMatchObject({ status: "resolved" });
    expect(page.remote.writes).toBe(writes);
  });

  it.each(["source", "task", "tables"])(
    "damage to a saved page's %s is never verified preparation",
    async (kind) => {
      const page = await savedPage();
      const keys: Record<string, string> = {
        source: page.input.page.objectKey,
        task: `v3/page-text-inputs/${page.source.plan.textOperationId}.json`,
        tables: `v3/pages/${page.input.operationId}/tables.json`,
      };
      page.remote.data.set(defined(keys[kind]), Buffer.from("{}"));
      expect(
        await page.resolver.resolve(page.source, { id: "page", status: "registered" }, signal()),
      ).toEqual({
        status: "review",
        code: "SAVED.PREPARATION_UNVERIFIED",
      });
    },
  );

  it("a page failure stays a failure even for an optional source; a forged Review is refused", async () => {
    const page = await savedPage("<script>nothing</script>");
    if (page.prepared.status !== "review") {
      throw new Error(JSON.stringify(page.prepared));
    }
    page.source.required = false;
    const state = { id: "page", status: "review" as const, reviewId: page.prepared.reviewId };
    expect(await page.resolver.resolve(page.source, state, signal())).toEqual({
      status: "review",
      code: "PROCESSING.PAGE_EMPTY",
    });
    defined(page.records.get(state.reviewId)).failure.inputFingerprint = "c".repeat(64);
    await expect(page.resolver.resolve(page.source, state, signal())).rejects.toMatchObject({
      code: "SAVED.IDENTITY_CONFLICT",
    });
    await expect(
      page.resolver.resolve(page.source, { ...state, reviewId: "missing" }, signal()),
    ).rejects.toMatchObject({
      code: "SAVED.REVIEW_UNVERIFIED",
    });
  });

  it("a page can never be reported as not matched", async () => {
    const page = await savedPage();
    await expect(
      page.resolver.resolve(page.source, { id: "page", status: "not_matched" }, signal()),
    ).rejects.toMatchObject({
      code: "SAVED.RECEIPT_INVALID",
    });
  });

  it("an unmatched image needs verified OCR and its kept keyword decision; a false success is refused", async () => {
    const image = await savedImage("Marketing only");
    const writes = image.remote.writes;
    expect(
      await image.resolver.resolve(image.source, { id: "label", status: "not_matched" }, signal()),
    ).toEqual({ status: "not_matched" });
    expect(image.remote.writes).toBe(writes);
    await expect(
      image.resolver.resolve(image.source, { id: "label", status: "registered" }, signal()),
    ).rejects.toMatchObject({
      code: "SAVED.RECEIPT_INVALID",
    });
    image.remote.data.delete(keywordKey(image.selection));
    expect(
      await image.resolver.resolve(image.source, { id: "label", status: "not_matched" }, signal()),
    ).toMatchObject({ status: "review" });
  });

  it("a matched image resolves its pinned vision task and can never be skipped", async () => {
    const image = await savedImage("Supplement Facts");
    expect(
      await image.resolver.resolve(image.source, { id: "label", status: "unresolved" }, signal()),
    ).toMatchObject({
      status: "resolved",
      source: {
        kind: "image",
        task: { input: { operationId: "vision-operation", selection: image.selection } },
      },
    });
    await expect(
      image.resolver.resolve(image.source, { id: "label", status: "not_matched" }, signal()),
    ).rejects.toMatchObject({
      code: "SAVED.RECEIPT_INVALID",
    });
  });

  it("a PDF source is skipped, never read and never a Review (no PDF, owner 2026-09-30)", async () => {
    const page = await savedPage();
    const pdf = {
      id: "pdf-page",
      kind: "pdf-text",
      required: true,
    } as unknown as SavedEvidenceSource;
    for (const status of ["registered", "unresolved", "not_matched"] as const) {
      expect(await page.resolver.resolve(pdf, { id: "pdf-page", status }, signal())).toEqual({
        status: "not_matched",
      });
    }
  });
});
