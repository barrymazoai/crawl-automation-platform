import { parseOcrInput, observationIdentity, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { ArtifactResolver, verifyBytes, type LocalCopies, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { digest, matchInput, prepare, recordHash, validateRecord, verifyCompletion } from "./codec.js";
import { ResultError, type CompletionJournal, type ResultFacts, type ResultRegistry } from "./ports.js";
/** No provider, Workflow, queue or Review consumer is reachable from this module. */
export class OcrResultHandoff {
    constructor(private readonly storageId: string, private readonly local: LocalCopies, private readonly remote: ObjectStore, private readonly journal: CompletionJournal, private readonly registry: ResultRegistry) { }
    async capture(input: unknown, output: unknown, signal: AbortSignal): Promise<OcrRegistration> {
        signal.throwIfAborted();
        const prepared = prepare(input, output, this.storageId);
        const old = await this.journal.read(prepared.record.input.operationId);
        if (old && recordHash(validateRecord(old)) !== recordHash(prepared.record))
            throw new ResultError("RESULT.CONFLICT");
        await this.local.retain(prepared.record.result, prepared.resultBytes, signal);
        await this.local.retain(prepared.record.completion, prepared.completionBytes, signal);
        await this.journal.create(prepared.record);
        signal.throwIfAborted();
        return prepared.record;
    }
    async inspect(inputRaw: unknown, signal: AbortSignal): Promise<ResultFacts> {
        signal.throwIfAborted();
        const input = parseOcrInput(inputRaw, digest);
        // Ledger read is from the configured primary, never a lagging read replica.
        const registered = await this.registry.read(input.operationId), saved = await this.journal.read(input.operationId);
        signal.throwIfAborted();
        if (registered && saved && recordHash(validateRecord(registered)) !== recordHash(validateRecord(saved)))
            throw new ResultError("RESULT.CONFLICT");
        const raw = registered ?? saved;
        if (!raw)
            return { computedLocal: false, artifactDurable: false, resultRegistered: false, record: null };
        const record = validateRecord(raw);
        matchInput(record, input, this.storageId);
        let computedLocal = false;
        try {
            const result = await this.local.read(record.result, signal), completion = await this.local.read(record.completion, signal);
            if (result && completion) {
                verifyCompletion(record, result, completion);
                computedLocal = true;
            }
        }
        catch {
            signal.throwIfAborted(); /* Bad cache is not proof, but remote may still verify. */
        }
        const data = [];
        for (const ref of [record.input.file, record.result, record.completion]) {
            const bytes = await this.remote.read(ref.objectKey, ref.byteSize, signal);
            if (bytes) {
                try {
                    verifyBytes(ref, bytes, 32 * 1024 * 1024);
                }
                catch {
                    throw new ResultError("RESULT.INTEGRITY");
                }
            }
            data.push(bytes);
        }
        const artifactDurable = data.every(Boolean);
        if (artifactDurable)
            verifyCompletion(record, data[1]!, data[2]!);
        // An immutable DB row alone does not make missing/tampered evidence usable.
        if (registered && !artifactDurable)
            throw new ResultError("RESULT.NOT_DURABLE");
        signal.throwIfAborted();
        return { computedLocal, artifactDurable, resultRegistered: !!registered, record };
    }
    async uploadMissing(input: unknown, signal: AbortSignal): Promise<ResultFacts> {
        const before = await this.inspect(input, signal);
        if (before.artifactDurable)
            return before;
        if (!before.record || !before.computedLocal)
            throw new ResultError("RESULT.INCOMPLETE");
        const record = before.record, resolver = new ArtifactResolver(this.local, this.remote);
        for (const ref of [record.input.file, record.result, record.completion]) {
            const existing = await this.remote.read(ref.objectKey, ref.byteSize, signal);
            if (existing) {
                verifyBytes(ref, existing, 32 * 1024 * 1024);
                continue;
            }
            const bytes = await this.local.read(ref, signal);
            if (!bytes)
                throw new ResultError("RESULT.INCOMPLETE");
            await resolver.publish(ref, observationIdentity(record.input), bytes, signal);
        }
        return this.inspect(input, signal);
    }
    async register(input: unknown, signal: AbortSignal): Promise<ResultFacts> {
        const before = await this.inspect(input, signal);
        if (before.resultRegistered)
            return before;
        if (!before.artifactDurable || !before.record)
            throw new ResultError("RESULT.NOT_DURABLE");
        signal.throwIfAborted();
        try {
            await this.registry.register(before.record);
        }
        catch (error) {
            if (error instanceof ResultError && error.code === "RESULT.CONFLICT")
                throw error;
            throw new ResultError("RESULT.REGISTRATION_UNKNOWN");
        }
        // A response or row count is not final success: fresh readback + evidence validation.
        const after = await this.inspect(input, signal);
        if (!after.resultRegistered)
            throw new ResultError("RESULT.REGISTRATION_UNKNOWN");
        return after;
    }
}
