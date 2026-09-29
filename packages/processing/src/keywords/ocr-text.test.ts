import { describe, expect, it } from "vitest";
import type { OcrRegistration } from "@crawl-automation/v3-contracts";
import { MemoryStore } from "../testing/memory-store.js";
import { STORAGE_ID, ocrStepSetup, remoteArtifacts, signal } from "../testing/ocr-fixture.js";
import { OcrResults } from "../ocr/ocr-results.js";
import { LedgerOcrText, RemoteOcrText } from "./ocr-text.js";

const TEXT = "Supplement\nFacts";

async function ocrTextSetup(mode: "register" | "upload-only" = "register") {
  const fixture = ocrStepSetup(mode);
  fixture.api.recognize = async () => ({ text: TEXT, lines: [] });
  const outcome = await fixture.step.run(fixture.input, signal());
  const artifacts = remoteArtifacts(fixture.remote);
  const ledger = new LedgerOcrText({
    artifacts,
    results: fixture.results,
    registry: fixture.registry,
  });
  return { ...fixture, outcome, artifacts, ledger };
}

// Cases carried over from the former OCR evidence reader.
describe("OCR text for keyword screening", () => {
  it("screens only a registered, durable OCR result, and reads its text back for a selection", async () => {
    const fixture = await ocrTextSetup();
    const registration = (await fixture.registry.read(
      fixture.input.operationId,
    )) as OcrRegistration;
    const selection = await fixture.ledger.screen(registration, signal());
    expect(selection.status).toBe("matched");
    expect(await fixture.ledger.verifiedText(selection, signal())).toBe(TEXT);
    fixture.registry.data.clear();
    await expect(fixture.ledger.screen(registration, signal())).rejects.toMatchObject({
      code: "SCREEN.UPSTREAM_UNVERIFIED",
    });
  });

  it("never attributes another image to a valid OCR operation", async () => {
    const fixture = await ocrTextSetup();
    const registration = (await fixture.registry.read(
      fixture.input.operationId,
    )) as OcrRegistration;
    const selection = await fixture.ledger.screen(registration, signal());
    const other = { ...selection, image: { ...selection.image, artifactId: "other" } };
    await expect(fixture.ledger.verifiedText(other, signal())).rejects.toMatchObject({
      code: "SCREEN.SOURCE_CONFLICT",
    });
  });

  it("a missing ledger record is not an empty OCR text", async () => {
    const fixture = await ocrTextSetup();
    const registration = (await fixture.registry.read(
      fixture.input.operationId,
    )) as OcrRegistration;
    const selection = await fixture.ledger.screen(registration, signal());
    const empty = new LedgerOcrText({
      ...fixture,
      results: fixture.results,
      registry: { read: async () => null },
    });
    await expect(empty.verifiedText(selection, signal())).rejects.toMatchObject({
      code: "SCREEN.UPSTREAM_UNVERIFIED",
    });
  });

  it("a worker without a ledger reads the selected text from R2 alone", async () => {
    const mini = await ocrTextSetup();
    const registration = (await mini.registry.read(mini.input.operationId)) as OcrRegistration;
    const selection = await mini.ledger.screen(registration, signal());
    const results = new OcrResults({
      local: new MemoryStore(),
      remote: mini.remote,
      registry: null,
      storageId: STORAGE_ID,
    });
    const cloud = new RemoteOcrText({ artifacts: mini.artifacts, results, remote: mini.remote });
    expect(await cloud.verifiedText(selection, signal())).toBe(TEXT);
    await expect(
      cloud.verifiedText({ ...selection, ocrOperationId: "unknown-ocr" }, signal()),
    ).rejects.toMatchObject({
      code: "SCREEN.UPSTREAM_UNVERIFIED",
    });
  });
});
