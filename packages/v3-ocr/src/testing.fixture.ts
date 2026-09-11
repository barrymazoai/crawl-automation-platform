import { FileCopies, ArtifactResolver, sha256 } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, OcrResultHandoff } from "@crawl-automation/v3-results";
import { MemoryObjects, MemoryRegistry, fixture } from "../../v3-results/src/testing.fixture.js";
import { digest, parseRecord } from "@crawl-automation/v3-review";
import { fingerprintOcrInput, type ReviewRecord, type OcrInput } from "@crawl-automation/v3-contracts";
import type { OcrProvider } from "./ports.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrIntents } from "./intent.js";
import { OcrFileModule, type OcrDependencies } from "./module.js";

export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOuoAAAAASUVORK5CYII=", "base64");
export const signal = () => new AbortController().signal;
export class MemoryReviews {
  records = new Map<string, ReviewRecord>(); lost = false; unavailable = false;
  async read(id: string) { if (this.unavailable) throw Error("synthetic unavailable"); return this.records.get(id) ?? null; }
  async append(raw: ReviewRecord) {
    if (this.unavailable) throw Error("synthetic unavailable");
    const record = parseRecord(raw); this.records.set(record.reviewId, record);
    if (this.lost) throw Error("synthetic lost acknowledgement");
    return { reviewId: record.reviewId, recordHash: digest(record), registered: true as const };
  }
}
export async function setup() {
  const input: OcrInput = { ...fixture().input, resultSchemaVersion: 2 };
  input.file.sha256 = sha256(png); input.file.byteSize = png.length;
  input.inputFingerprint = fingerprintOcrInput(input, s => sha256(Buffer.from(s)));
  const root = await mkdtemp(join(tmpdir(), "v3-ocr-unit-"));
  const local = await FileCopies.open(join(root, "cache")), remote = new MemoryObjects(), registry = new MemoryRegistry(), reviews = new MemoryReviews();
  await local.retain(input.file, png, signal());
  const journal = await FileCompletionJournal.open(join(root, "journal"));
  const results = new OcrResultHandoff("fixture/1", local, remote, journal, registry);
  let calls = 0;
  const provider: OcrProvider = { provider: "fixture/1", supported: { module: input.module, schemaVersion: input.schemaVersion, resultSchemaVersion: input.resultSchemaVersion,
    implementationVersion: input.implementationVersion, policyVersion: input.policyVersion, configFingerprint: input.configFingerprint },
    recognize: async () => { calls++; return { text: "  Synthetic recognized text\nIngredients: test only.  ", lines: [] }; }, close: async () => {} };
  const deps: OcrDependencies = { provider, artifacts: new ArtifactResolver(local, remote), results, reviews, intents: new OcrIntents(remote, "test-node", "fixture/1") };
  return { input, root, local, remote, registry, journal, results, reviews, provider, deps, calls: () => calls, module: new OcrFileModule(deps) };
}
