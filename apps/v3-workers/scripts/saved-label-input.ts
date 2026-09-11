// Acceptance-only generation from immutable prepared evidence; never resume old failed operations.
import { createHash } from "node:crypto";
import { LabelProductManifestSchema, TextCompatibilitySchema, textFingerprint, type TextCompatibility } from "@crawl-automation/v3-contracts";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export function renewSavedLabelManifest(raw: unknown, operationId: string, compatibility: TextCompatibility, visionFingerprint: string) {
  const old = LabelProductManifestSchema.parse(raw), text = TextCompatibilitySchema.parse(compatibility);
  if (operationId === old.operationId || text.resultSchemaVersion !== 3) throw Error("SAVED_GENERATION_REQUIRED");
  return LabelProductManifestSchema.parse({ ...old, operationId, sources: old.sources.map(source => {
    const nextId = `gncl-${hash(JSON.stringify([operationId, source.id]))}`;
    if (source.kind === "image") return { ...source, task: { configFingerprint: visionFingerprint,
      input: { ...source.task.input, operationId: nextId } } };
    const { inputFingerprint: _old, ...unsigned } = source.task;
    const next = { ...unsigned, ...text, operationId: nextId };
    return { ...source, task: { ...next, inputFingerprint: textFingerprint(next, hash) } };
  }) });
}
