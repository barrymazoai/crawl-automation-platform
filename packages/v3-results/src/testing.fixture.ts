import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintOcrInput, processingIdentity, type OcrInput, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { ArtifactError, FileCopies, sha256, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { FileCompletionJournal } from "./file-journal.js";
import { OcrResultHandoff } from "./handoff.js";
import { ResultError, type ResultRegistry } from "./ports.js";
import { digest, recordHash } from "./codec.js";
export const signal = () => new AbortController().signal;
export function fixture() {
    const id = randomUUID(), bytes = Buffer.from("89504e470d0a1a0a", "hex");
    const unsigned = { schemaVersion: 1 as const, requestId: `req-${id}`, observationId: `obs-${id}`, operationId: `op-${id}`, module: "ocr.file" as const,
        brandId: "brand-test", sourceId: "source-test", listingId: `listing-${id}`, variantId: null, implementationVersion: "ocr/1", policyVersion: "policy/1", resultSchemaVersion: 1 as const, configFingerprint: "a".repeat(64),
        file: { schemaVersion: 1 as const, artifactId: `source-${id}`, observationId: `obs-${id}`, sourceId: "source-test", listingId: `listing-${id}`, variantId: null,
            kind: "source-image" as const, mediaType: "image/png" as const, objectKey: `sources/${id}.png`, sha256: sha256(bytes), byteSize: bytes.length,
            producer: { operationId: `capture-${id}`, module: "capture", implementationVersion: "capture/1" } } };
    const input: OcrInput = { ...unsigned, inputFingerprint: fingerprintOcrInput(unsigned, digest) };
    return { input, bytes, output: { ...processingIdentity(input), text: "synthetic OCR text", provider: "fake/1" } };
}
export class MemoryObjects implements ObjectStore {
    data = new Map<string, Uint8Array>();
    reads = 0;
    writes = 0;
    unknown = false;
    unavailable = false;
    async read(key: string, max: number) { this.reads++; if (this.unavailable)
        throw new ArtifactError("ARTIFACT.UNAVAILABLE"); const b = this.data.get(key); if (b && b.length > max)
        throw new ArtifactError("ARTIFACT.TOO_LARGE"); return b ?? null; }
    async create(key: string, bytes: Uint8Array) { this.writes++; if (this.data.has(key))
        return "exists" as const; this.data.set(key, bytes); if (this.unknown)
        throw new ArtifactError("ARTIFACT.UPLOAD_UNKNOWN"); return "created" as const; }
}
export class MemoryRegistry implements ResultRegistry {
    data = new Map<string, OcrRegistration>();
    reads = 0;
    writes = 0;
    loseAfterCommit = false;
    async read(id: string) { this.reads++; return this.data.get(id) ?? null; }
    async register(record: OcrRegistration) {
        this.writes++;
        const old = this.data.get(record.input.operationId);
        if (old && recordHash(old) !== recordHash(record))
            throw new ResultError("RESULT.CONFLICT");
        this.data.set(record.input.operationId, record);
        if (this.loseAfterCommit)
            throw new ResultError("RESULT.REGISTRATION_UNKNOWN");
    }
}
export async function setup(registry: ResultRegistry = new MemoryRegistry()) {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "v3-result-"));
    const local = await FileCopies.open(join(root, "cache")), journal = await FileCompletionJournal.open(join(root, "journal")), remote = new MemoryObjects();
    await local.retain(f.input.file, f.bytes, signal());
    remote.data.set(f.input.file.objectKey, f.bytes);
    return { ...f, root, local, journal, remote, registry, handoff: new OcrResultHandoff("fixture-r2/1", local, remote, journal, registry) };
}
