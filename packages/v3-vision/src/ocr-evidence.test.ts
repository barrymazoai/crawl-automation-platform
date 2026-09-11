import { expect, it } from "vitest";
import { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { setup, signal } from "../../v3-results/src/testing.fixture.js";
import { RegisteredOcrEvidence } from "./ocr-evidence.js";
async function fixture() {
  const f = await setup(); f.output.text = "Supplement\nFacts";
  const record = await f.handoff.capture(f.input, f.output, signal());
  const evidence = new RegisteredOcrEvidence(new ArtifactResolver(f.local, f.remote), f.handoff, f.registry);
  return { ...f, record, evidence };
}
it("only screens after both durability and registration are verified", async () => {
  const f = await fixture();
  await expect(f.evidence.screen(f.record, signal())).rejects.toThrow("SCREEN.UPSTREAM_UNVERIFIED");
  await f.handoff.uploadMissing(f.input, signal());
  await expect(f.evidence.screen(f.record, signal())).rejects.toThrow("SCREEN.UPSTREAM_UNVERIFIED");
  await f.handoff.register(f.input, signal());
  const selected = await f.evidence.screen(f.record, signal());
  expect(selected.status).toBe("matched"); expect(await f.evidence.verifiedText(selected, signal())).toBe(f.output.text);
});
it("cannot attribute another image/variant to a valid OCR operation", async () => {
  const f = await fixture(); await f.handoff.uploadMissing(f.input, signal()); await f.handoff.register(f.input, signal());
  const selected = await f.evidence.screen(f.record, signal());
  await expect(f.evidence.verifiedText({ ...selected, image: { ...selected.image, artifactId: "other" } }, signal())).rejects.toThrow("SCREEN.SOURCE_CONFLICT");
});
it("a missing registry record is not an empty/no-match OCR result", async () => {
  const f = await fixture(); await f.handoff.uploadMissing(f.input, signal()); await f.handoff.register(f.input, signal());
  const selected = await f.evidence.screen(f.record, signal());
  const missing = new RegisteredOcrEvidence(new ArtifactResolver(f.local, f.remote), f.handoff, { read: async () => null });
  await expect(missing.verifiedText(selected, signal())).rejects.toThrow("SCREEN.UPSTREAM_UNVERIFIED");
});
