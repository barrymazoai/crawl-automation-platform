import { CompletionSchema, OcrOutputSchema, OcrRegistrationSchema, assertProcessingResultMatches, parseOcrInput, processingIdentity, type OcrInput, type OcrRegistration } from "@crawl-automation/v3-contracts";
import { sha256, verifyBytes } from "@crawl-automation/v3-artifacts";
import { ResultError } from "./ports.js";
export const digest = (text: string) => sha256(Buffer.from(text));
export const recordHash = (record: OcrRegistration) => digest(JSON.stringify(OcrRegistrationSchema.parse(record)));
export function validateRecord(raw: unknown): OcrRegistration {
    try {
        const record = OcrRegistrationSchema.parse(raw);
        parseOcrInput(record.input, digest);
        if ([record.input.file, record.result, record.completion].some(ref => ref.byteSize > 32 * 1024 * 1024))
            throw new ResultError("RESULT.INTEGRITY");
        return record;
    }
    catch {
        throw new ResultError("RESULT.INTEGRITY");
    }
}
export function matchInput(record: OcrRegistration, input: OcrInput, storageId: string) {
    // Match canonical input INCLUDING evidence location; no implicit relocation/reuse.
    if (record.storageId !== storageId || JSON.stringify(record.input) !== JSON.stringify(input))
        throw new ResultError("RESULT.CONFLICT");
}
export const operationKey = (input: OcrInput) => `operations/${input.operationId}/${input.inputFingerprint}`;
/** Deterministic registration record for already serialized result/completion bytes; keys and ids derive from the input only. */
export function recordFor(input: OcrInput, storageId: string, resultBytes: Uint8Array, completionBytes: Uint8Array): OcrRegistration {
    const key = operationKey(input);
    const ref = (suffix: string, data: Uint8Array) => ({ schemaVersion: 1 as const, artifactId: `${suffix}-${digest(input.operationId)}`,
        observationId: input.observationId, sourceId: input.sourceId, listingId: input.listingId, variantId: input.variantId,
        kind: "result-json" as const, mediaType: "application/json" as const, sha256: sha256(data), byteSize: data.length, objectKey: `${key}/${suffix}.json`,
        producer: { operationId: input.operationId, module: input.module, implementationVersion: input.implementationVersion } });
    return validateRecord({ schemaVersion: 1, storageId, input, result: ref("result", resultBytes), completion: ref("completion", completionBytes) });
}
export function prepare(inputRaw: unknown, outputRaw: unknown, storageId: string) {
    const input = parseOcrInput(inputRaw, digest), output = OcrOutputSchema.parse(outputRaw);
    assertProcessingResultMatches(input, output, "output");
    const resultBytes = Buffer.from(JSON.stringify(output));
    const key = operationKey(input);
    const completion = CompletionSchema.parse({ ...processingIdentity(input), resultKey: `${key}/result.json`, resultSha256: sha256(resultBytes), resultByteSize: resultBytes.length, complete: true });
    const completionBytes = Buffer.from(JSON.stringify(completion));
    return { record: recordFor(input, storageId, resultBytes, completionBytes), resultBytes, completionBytes };
}
/** Rebuild and fully verify a registration from bytes retained remotely by a worker without ledger access. */
export function rebuild(inputRaw: unknown, resultBytes: Uint8Array, completionBytes: Uint8Array, storageId: string): OcrRegistration {
    const input = parseOcrInput(inputRaw, digest);
    const record = recordFor(input, storageId, resultBytes, completionBytes);
    verifyCompletion(record, resultBytes, completionBytes);
    return record;
}
export function verifyCompletion(record: OcrRegistration, result: Uint8Array, manifest: Uint8Array) {
    try {
        verifyBytes(record.result, result, 32 * 1024 * 1024);
        verifyBytes(record.completion, manifest, 32 * 1024 * 1024);
        const output = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result));
        const completion = CompletionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)));
        assertProcessingResultMatches(record.input, output, "output");
        assertProcessingResultMatches(record.input, completion, "completion");
        if (completion.resultKey !== record.result.objectKey || completion.resultSha256 !== record.result.sha256 || completion.resultByteSize !== record.result.byteSize)
            throw Error();
    }
    catch {
        throw new ResultError("RESULT.INTEGRITY");
    }
}
