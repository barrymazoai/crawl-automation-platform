import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { artifactBuildId, RoleRegistry, workerProcess } from "@crawl-automation/v3-worker-runtime";
import { FileCopies, ArtifactResolver } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal, OcrResultHandoff, validateRecord, recordHash } from "@crawl-automation/v3-results";
import { parseRecord, digest } from "@crawl-automation/v3-review";
import type { OcrRegistration, ReviewRecord } from "@crawl-automation/v3-contracts";
import { createOcrRole, MultipartOcr, OcrIntents } from "../../src/index.js";
import { FixtureObjects } from "./store.js";

const buildId = await artifactBuildId([fileURLToPath(import.meta.url)]);
const role = createOcrRole({ buildId, compatibility: "fixture-v1", testOnly: true, prepare: async config => {
  const settings = JSON.parse(await readFile(process.env.V3_OCR_FIXTURE_CONFIG!, "utf8")) as { root: string; endpoint: string };
  const remote = new FixtureObjects(join(settings.root, "objects"));
  const local = await FileCopies.open(join(settings.root, config.hostId, "cache"));
  const journal = await FileCompletionJournal.open(join(settings.root, config.hostId, "journal"));
  const registry = {
    read: async (id: string): Promise<OcrRegistration | null> => { const b = await remote.read(`registry/${id}`, 65536, new AbortController().signal); return b ? validateRecord(JSON.parse(b.toString())) : null; },
    register: async (r: OcrRegistration) => {
      await remote.create(`registry/${r.input.operationId}`, Buffer.from(JSON.stringify(r)), "application/json", new AbortController().signal);
      const old = await registry.read(r.input.operationId); if (!old || recordHash(old) !== recordHash(r)) throw Error("fixture registry conflict");
    },
  };
  const reviews = {
    read: async (id: string): Promise<ReviewRecord | null> => { const b = await remote.read(`reviews/${id}`, 2097152, new AbortController().signal); return b ? parseRecord(JSON.parse(b.toString())) : null; },
    append: async (r: ReviewRecord) => {
      await remote.create(`reviews/${r.reviewId}`, Buffer.from(JSON.stringify(r)), "application/json", new AbortController().signal);
      return { reviewId: r.reviewId, recordHash: digest(r), registered: true as const };
    },
  };
  const provider = new MultipartOcr({ endpoint: settings.endpoint, provider: "fixture-service/1", allowLoopbackHttp: true, timeoutMs: 500 });
  return { dependencies: { provider, artifacts: new ArtifactResolver(local, remote), intents: new OcrIntents(remote, config.hostId, "fixture/1"),
    results: new OcrResultHandoff("fixture/1", local, remote, journal, registry), reviews },
    dispose: async () => { await provider.close(); console.log(JSON.stringify({ event: "OCR_DISPOSED", pid: process.pid })); } };
} });
workerProcess(new RoleRegistry("test", [role])).catch(() => { console.error("OCR_FIXTURE_STARTUP_REJECTED"); process.exitCode = 1; });
