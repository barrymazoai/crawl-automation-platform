import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { KeywordResultSchema, OcrResponseSchema } from "@crawl-automation/v3-contracts";
const root = resolve(process.argv[2]!);
const report = z.object({ samples: z.array(z.object({ id: z.string(), selection: KeywordResultSchema })) }).parse(JSON.parse(await readFile(join(root, "report.json"), "utf8")));
for (const s of report.samples) {
  const operationId = s.id + "-vision";
  // Verify retained source/result linkage and re-run current decoding; no provider or storage writes.
  const intent = JSON.parse(await readFile(join(root, "evidence", "v3", "vision", operationId, "intent.json"), "utf8"));
  const response = JSON.parse(await readFile(join(root, "evidence", "v3", "vision", operationId, "response.json"), "utf8"));
  const { digest, validateVision, verifySelection } = await import("../src/index.js");
  if (intent.fingerprint !== response.fingerprint || digest(response.raw) !== response.sha256 || JSON.stringify(intent.input.selection) !== JSON.stringify(s.selection)) throw Error("REPLAY_INTEGRITY");
  const ocr = OcrResponseSchema.parse(JSON.parse(await readFile(join(root, "evidence", "pilot", s.id, "ocr.json"), "utf8")));
  verifySelection(s.selection, ocr.text);
  const image = await readFile(join(root, "evidence", s.selection.image.objectKey));
  if (digest(image) !== s.selection.image.sha256 || image.length !== s.selection.image.byteSize) throw Error("IMAGE_CHANGED");
  const output = validateVision(response.raw), c = output.candidate;
  console.log(JSON.stringify({ id: s.id, status: output.status, code: output.code,
    columns: c.formula?.columns.map(c => ({ heading: c.heading, rows: c.nutrients.map(n => [n.name.text, n.amount?.text, n.dailyValue?.text]) })),
    blendCount: c.ingredients.filter(i => i.role === "blend_component").length,
    otherIngredients: c.ingredients.filter(i => i.role === "other").map(i => i.name),
    modelCalls: 0, rawSha256: response.sha256 }));
}
