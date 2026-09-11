import { TextRecordSchema, TextOutputSchema, textIdentity, parseTextInput, assertTextQuotes, type TextRecord, type TextOutput, type TextInput, type ArtifactRef } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes, type ObjectStore } from "@crawl-automation/v3-artifacts";
import { TextError, type TextFacts, type TextRegistry, type QueryPort } from "./ports.js";
import { TextEvidence } from "./evidence.js";
import { decodeTextResult } from "./protocol.js";
export const hashText = (s: string) => sha256(Buffer.from(s));
const encode = (v: unknown) => Buffer.from(JSON.stringify(v));
const decode = (b: Uint8Array) => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(b));
export function textRecord(raw: unknown): TextRecord {
    const record = TextRecordSchema.parse(raw);
    parseTextInput(record.input, hashText);
    return record;
}
const hashRecord = (r: unknown) => sha256(encode(textRecord(r)));
export class PostgresTextRegistry implements TextRegistry {
    constructor(private readonly db: QueryPort) { }
    async read(id: string) {
        const rows = (await this.db.query("SELECT record,record_hash FROM public.processing_result WHERE operation_id=$1", [id])).rows;
        if (!rows[0])
            return null;
        const r = textRecord(rows[0].record);
        if (r.input.operationId !== id || hashRecord(r) !== rows[0].record_hash)
            throw new TextError("TEXT.RESULT_INTEGRITY");
        return r;
    }
    async register(raw: TextRecord) {
        const record = textRecord(raw), hash = hashRecord(record);
        await this.db.query("INSERT INTO public.processing_result(operation_id,record_hash,record) VALUES ($1,$2,$3::jsonb) ON CONFLICT(operation_id) DO NOTHING", [record.input.operationId, hash, JSON.stringify(record)]);
        const saved = await this.read(record.input.operationId);
        if (!saved || hashRecord(saved) !== hash)
            throw new TextError("TEXT.RESULT_CONFLICT");
    }
}
export class TextHandoff {
    constructor(readonly local: ObjectStore, readonly remote: ObjectStore, readonly registry: TextRegistry, readonly evidence: TextEvidence, readonly storageId: string) { }
    journalKey(input: TextInput) { return `text-completions/${input.operationId}.json`; }
    responseKey(input: TextInput) { return `text-responses/${input.operationId}.json`; }
    /** Recover only a retained typed output; raw response alone lacks original provider metadata. */
    private async recoveryOutput(input: TextInput, signal: AbortSignal) {
        parseTextInput(input, hashText);
        const bytes = await this.local.read(`text-operations/${input.operationId}/${input.inputFingerprint}/result.json`, 524288, signal);
        if (!bytes) throw new TextError("TEXT.HANDOFF_INCOMPLETE", "executed");
        const output = TextOutputSchema.parse(decode(bytes)), identity = textIdentity(input);
        for (const key of Object.keys(identity) as (keyof typeof identity)[]) if (output[key] !== identity[key]) throw new TextError("TEXT.RESULT_CONFLICT");
        const source = await this.evidence.resolve(input, signal);
        if (JSON.stringify(decodeTextResult(input, source.text, output.rawResponse)) !== JSON.stringify(output.candidate)) throw new TextError("TEXT.RESULT_INTEGRITY");
        assertTextQuotes(output.candidate, input, source.text);
        return output;
    }
    async inspectRecovery(input: TextInput, signal: AbortSignal) {
        const facts = await this.inspect(input, signal);
        if (facts.record) return { computed: facts.computedLocal, durable: facts.artifactDurable, registered: facts.resultRegistered };
        await this.recoveryOutput(input, signal);
        return { computed: true, durable: false, registered: false };
    }
    async uploadRecoveredResponse(input: TextInput, signal: AbortSignal) {
        const facts = await this.inspect(input, signal);
        if (!facts.record) await this.capture(input, await this.recoveryOutput(input, signal), signal);
        await this.uploadMissing(input, signal);
    }
    async retainResponse(input: TextInput, rawResponse: string) {
        await this.put(this.local, this.responseKey(input), encode({ input, rawResponse }), AbortSignal.timeout(10000));
    }
    private async put(store: ObjectStore, key: string, bytes: Uint8Array, signal: AbortSignal) {
        // Unknown acknowledgment is read back, never repeated here.
        try {
            await store.create(key, bytes, "application/json", signal);
        }
        catch { /* independent verification below */ }
        const saved = await store.read(key, bytes.length, signal);
        if (!saved || sha256(saved) !== sha256(bytes))
            throw new TextError("TEXT.HANDOFF_UNKNOWN", "executed");
    }
    private prepare(input: TextInput, output: TextOutput) {
        const bytes = encode(TextOutputSchema.parse(output));
        if (bytes.length > 524288)
            throw new TextError("TEXT.OUTPUT_LIMIT", "executed");
        const prefix = `text-operations/${input.operationId}/${input.inputFingerprint}`;
        const ref = (suffix: string, data: Uint8Array): ArtifactRef => ({ schemaVersion: 1, artifactId: `text-${suffix}-${hashText(input.operationId)}`,
            observationId: input.observationId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId,
            kind: "result-json", mediaType: "application/json", sha256: sha256(data), byteSize: data.length, objectKey: `${prefix}/${suffix}.json`,
            producer: { operationId: input.operationId, module: input.module, implementationVersion: input.implementationVersion } });
        const result = ref("result", bytes), manifest = encode({ ...textIdentity(input), resultKey: result.objectKey,
            resultSha256: result.sha256, resultByteSize: result.byteSize, complete: true });
        return { record: textRecord({ schemaVersion: 1, storageId: this.storageId, input, result, completion: ref("completion", manifest) }), bytes, manifest };
    }
    async capture(input: TextInput, output: TextOutput, signal: AbortSignal) {
        parseTextInput(input, hashText);
        const parsed = TextOutputSchema.parse(output), identity = textIdentity(input);
        for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
            if (parsed[key] !== identity[key])
                throw new TextError("TEXT.RESULT_INTEGRITY", "executed");
        }
        const sourceText = (await this.evidence.resolve(input, signal)).text;
        assertTextQuotes(parsed.candidate, input, sourceText);
        if (JSON.stringify(decodeTextResult(input, sourceText, parsed.rawResponse)) !== JSON.stringify(parsed.candidate))
            throw new TextError("TEXT.RESULT_INTEGRITY", "executed");
        const p = this.prepare(input, output);
        await this.put(this.local, p.record.result.objectKey, p.bytes, signal);
        await this.put(this.local, p.record.completion.objectKey, p.manifest, signal);
        await this.put(this.local, this.journalKey(input), encode(p.record), signal);
    }
    async inspect(input: TextInput, signal: AbortSignal): Promise<TextFacts> {
        const saved = await this.registry.read(input.operationId), journal = await this.local.read(this.journalKey(input), 524288, signal);
        const localRecord = journal ? textRecord(decode(journal)) : null;
        if (saved && localRecord && hashRecord(saved) !== hashRecord(localRecord))
            throw new TextError("TEXT.RESULT_CONFLICT");
        const record = saved ?? localRecord;
        if (!record)
            return { computedLocal: false, artifactDurable: false, resultRegistered: false, record: null };
        if (JSON.stringify(record.input) !== JSON.stringify(input) || record.storageId !== this.storageId)
            throw new TextError("TEXT.RESULT_CONFLICT");
        const source = await this.evidence.resolve(input, signal);
        const verify = async (store: ObjectStore) => {
            const [result, completion] = await Promise.all([store.read(record.result.objectKey, 524288, signal), store.read(record.completion.objectKey, 65536, signal)]);
            if (!result || !completion)
                return false;
            verifyBytes(record.result, result, 524288);
            verifyBytes(record.completion, completion, 65536);
            const output = TextOutputSchema.parse(decode(result));
            if (JSON.stringify(textIdentity(input)) !== JSON.stringify(Object.fromEntries(Object.keys(textIdentity(input)).map(k => [k, output[k as keyof TextOutput]]))))
                throw new TextError("TEXT.RESULT_INTEGRITY");
            assertTextQuotes(output.candidate, input, source.text);
            if (JSON.stringify(decodeTextResult(input, source.text, output.rawResponse)) !== JSON.stringify(output.candidate))
                throw new TextError("TEXT.RESULT_INTEGRITY");
            const expected = { ...textIdentity(input), resultKey: record.result.objectKey, resultSha256: record.result.sha256, resultByteSize: record.result.byteSize, complete: true };
            if (JSON.stringify(decode(completion)) !== JSON.stringify(expected))
                throw new TextError("TEXT.RESULT_INTEGRITY");
            return true;
        };
        let computedLocal = false;
        try {
            computedLocal = await verify(this.local);
        }
        catch {
            signal.throwIfAborted();
        }
        let artifactDurable = await verify(this.remote);
        for (const ref of source.refs) {
            const bytes = await this.remote.read(ref.objectKey, Math.min(ref.byteSize, 8388608), signal);
            if (!bytes)
                artifactDurable = false;
            else
                verifyBytes(ref, bytes, 8388608);
        }
        if (saved && !artifactDurable)
            throw new TextError("TEXT.RESULT_NOT_DURABLE");
        return { computedLocal, artifactDurable, resultRegistered: !!saved, record };
    }
    async uploadMissing(input: TextInput, signal: AbortSignal) {
        const facts = await this.inspect(input, signal);
        if (facts.artifactDurable)
            return;
        if (!facts.computedLocal || !facts.record)
            throw new TextError("TEXT.HANDOFF_INCOMPLETE", "executed");
        // Source evidence must already be durable; this module never fabricates/publishes upstream results.
        for (const ref of (await this.evidence.resolve(input, signal)).refs) {
            const data = await this.remote.read(ref.objectKey, Math.min(ref.byteSize, 8388608), signal);
            if (!data)
                throw new TextError("TEXT.SOURCE_NOT_DURABLE", "executed");
            verifyBytes(ref, data, 8388608);
        }
        for (const ref of [facts.record.result, facts.record.completion]) {
            const saved = await this.remote.read(ref.objectKey, ref.byteSize, signal);
            if (saved) {
                verifyBytes(ref, saved, 524288);
                continue;
            }
            const bytes = await this.local.read(ref.objectKey, ref.byteSize, signal);
            if (!bytes)
                throw new TextError("TEXT.HANDOFF_INCOMPLETE", "executed");
            await this.put(this.remote, ref.objectKey, bytes, signal);
        }
    }
    async register(input: TextInput, signal: AbortSignal) {
        const facts = await this.inspect(input, signal);
        if (!facts.artifactDurable || !facts.record)
            throw new TextError("TEXT.HANDOFF_INCOMPLETE", "executed");
        if (!facts.resultRegistered)
            await this.registry.register(facts.record);
        const after = await this.inspect(input, signal);
        if (!after.resultRegistered)
            throw new TextError("TEXT.HANDOFF_UNKNOWN", "executed");
        return after;
    }
}
