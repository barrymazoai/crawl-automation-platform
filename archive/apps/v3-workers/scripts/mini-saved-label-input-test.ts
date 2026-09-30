import assert from "node:assert/strict";
import test from "node:test";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { LabelProductManifestSchema, parseTextInput } from "@crawl-automation/v3-contracts";
import { renewSavedLabelManifest } from "./saved-label-input.js";

assert.match(hostname(), /^barrydeMac-mini(?:\.|$)/, "Runtime tests belong on Mac mini");
const snapshot = JSON.parse(await readFile(new URL("./saved-gnc-manifest.json", import.meta.url), "utf8"));
const original = LabelProductManifestSchema.parse(snapshot.result.manifest);
const compatibility = snapshot.result.input.text, vision = snapshot.result.input.visionConfigFingerprint;
const generate = () => renewSavedLabelManifest(original, "saved-test-new-generation", compatibility, vision);

test("fresh deterministic operations preserve observation, sources and keyword evidence", () => {
  const before = JSON.stringify(original), next = generate();
  assert.deepEqual(next, generate()); assert.equal(JSON.stringify(original), before);
  assert.deepEqual(next.observation, original.observation);
  assert.notEqual(next.operationId, original.operationId);
  for (const [index, source] of next.sources.entries()) {
    const old = original.sources[index]!;
    assert.equal(source.id, old.id); assert.equal(source.required, old.required);
    if (source.kind === "text" && old.kind === "text") {
      assert.notEqual(source.task.operationId, old.task.operationId);
      assert.deepEqual(source.task.source, old.task.source); assert.deepEqual(source.task.range, old.task.range);
      parseTextInput(source.task, s => createHash("sha256").update(s).digest("hex"));
    } else if (source.kind === "image" && old.kind === "image") {
      assert.notEqual(source.task.input.operationId, old.task.input.operationId);
      assert.deepEqual(source.task.input.selection, old.task.input.selection);
    } else assert.fail("Source kind changed");
  }
});
test("rejects reuse of original manifest generation", () => {
  assert.throws(() => renewSavedLabelManifest(original, original.operationId, compatibility, vision), /SAVED_GENERATION_REQUIRED/);
});
test("rejects legacy text protocol and invalid vision fingerprint", () => {
  assert.throws(() => renewSavedLabelManifest(original, "fresh", { ...compatibility, resultSchemaVersion: 2 }, vision));
  assert.throws(() => renewSavedLabelManifest(original, "fresh", compatibility, "not-a-sha"));
});
test("rejects changed observation and duplicate source identities", () => {
  assert.throws(() => renewSavedLabelManifest({ ...original, observation: { ...original.observation, listingId: "another" } }, "fresh", compatibility, vision));
  assert.throws(() => renewSavedLabelManifest({ ...original, sources: [original.sources[0], original.sources[0]] }, "fresh", compatibility, vision));
});
