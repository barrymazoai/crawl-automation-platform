import { randomUUID } from "node:crypto";
import { TextCompatibilitySchema, TextOutputSchema, TextInputSchema, ReviewRecordSchema, parseTextInput, textIdentity, textObservation, type TextInput, type TextOutput, type TextActivityOutcome } from "@crawl-automation/v3-contracts";
import { inspectRegistration, type ReviewWriter, type PrivateReviewReader } from "@crawl-automation/v3-review";
import { TextHandoff, hashText } from "./handoff.js";
import { TextError, type TextProvider } from "./ports.js";
import { textProtocolPrompt, textOutputSchema, decodeTextResult } from "./protocol.js";
export interface TextDependencies {
    provider: TextProvider;
    handoff: TextHandoff;
    reviews: ReviewWriter & PrivateReviewReader;
    nodeId: string;
    /** "register" (default) writes the ledger; "upload-only" is cloud mode: evidence is retained locally and
     * remotely, the Mini receipt registers it, and Reviews go to the injected (remote) store. */
    mode?: "register" | "upload-only";
}
export function textPrompt(input: TextInput, fullText: string) {
    return textProtocolPrompt(input, fullText);
}
export class TextModule {
    constructor(private readonly deps: TextDependencies) {
        const p = deps.provider.policy;
        if (p.executionRetries !== 0 || p.internalModelRequests !== "codex-managed" || p.toolAccess !== "runtime-profile" || p.modelFallback !== false || p.networkSwitching !== false)
            throw new TextError("TEXT.PROVIDER_POLICY", "not_executed");
    }
    async run(raw: unknown, signal: AbortSignal): Promise<TextActivityOutcome> {
        let input: TextInput;
        try {
            input = parseTextInput(raw, hashText);
            const expected = TextCompatibilitySchema.parse(this.deps.provider.supported);
            for (const key of Object.keys(expected) as (keyof typeof expected)[])
                if (expected[key] !== input[key])
                    throw Error();
        }
        catch {
            throw new TextError("TEXT.INVALID_INPUT", "not_executed");
        }
        const h = this.deps.handoff, key = `text-intents/${input.operationId}.json`;
        let fact: "not_executed" | "executed" | "unknown" = "not_executed", response: string | null = null, output: TextOutput | null = null;
        const uploadOnly = this.deps.mode === "upload-only";
        const done = (r: Awaited<ReturnType<TextHandoff["inspect"]>>): TextActivityOutcome | null => r.resultRegistered && r.artifactDurable && r.record
            ? { status: "registered", operationId: input.operationId, result: r.record.result, completion: r.record.completion }
            : uploadOnly && r.artifactDurable && r.record
                ? { status: "uploaded", operationId: input.operationId, result: r.record.result, completion: r.record.completion } : null;
        try {
            signal.throwIfAborted();
            const previous = await h.inspect(input, signal);
            const completed = done(previous);
            if (completed)
                return completed;
            if (previous.record)
                throw new TextError("TEXT.HANDOFF_INCOMPLETE", "executed");
            const source = await h.evidence.resolve(input, signal), nonce = randomUUID();
            const intent = { schemaVersion: 1, input, storageId: h.storageId, nodeId: this.deps.nodeId, nonce };
            fact = "unknown";
            let claimed;
            try {
                claimed = await h.remote.create(key, Buffer.from(JSON.stringify(intent)), "application/json", signal);
            }
            catch {
                throw new TextError("TEXT.INTENT_UNKNOWN");
            }
            const bytes = await h.remote.read(key, 524288, signal);
            const saved = bytes ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null;
            if (!saved || saved.storageId !== h.storageId || JSON.stringify(TextInputSchema.parse(saved.input)) !== JSON.stringify(input))
                throw new TextError("TEXT.INTENT_CONFLICT");
            if (claimed !== "created" || saved.nonce !== nonce)
                throw new TextError("TEXT.EXECUTION_UNKNOWN");
            signal.throwIfAborted();
            response = await this.deps.provider.interpret({ operationId: input.operationId, prompt: textPrompt(input, source.text), outputSchema: textOutputSchema(input) }, signal);
            fact = "executed";
            if (Buffer.byteLength(response) > 250000) {
                response = null;
                throw new TextError("TEXT.OUTPUT_LIMIT", "executed");
            }
            await h.retainResponse(input, response);
            const candidate = decodeTextResult(input, source.text, response);
            output = TextOutputSchema.parse({ ...textIdentity(input), provider: this.deps.provider.provider, rawResponse: response, candidate });
            await h.capture(input, output, AbortSignal.timeout(10000));
            signal.throwIfAborted();
            await h.uploadMissing(input, signal);
            const registered = done(uploadOnly ? await h.inspect(input, signal) : await h.register(input, signal));
            if (!registered)
                throw new TextError("TEXT.HANDOFF_UNKNOWN", "executed");
            return registered;
        }
        catch (e) {
            try {
                const found = done(await h.inspect(input, AbortSignal.timeout(10000)));
                if (found)
                    return found;
            }
            catch { /* absence not proven */ }
            const code = e instanceof TextError ? e.code : signal.aborted ? "TEXT.CANCELLED" : "TEXT.UNCLASSIFIED";
            if (e instanceof TextError && fact !== "executed")
                fact = e.executionFact;
            const review = ReviewRecordSchema.parse({ schemaVersion: 1, reviewId: `text-${randomUUID()}`, occurredAt: new Date().toISOString(),
                failure: { schemaVersion: 1, requestId: input.requestId, observationId: input.observationId, operationId: input.operationId,
                    inputFingerprint: input.inputFingerprint, stage: "codex.text", category: "PROCESSING", code, executionFact: fact,
                    evidenceKey: key, blockedBy: input.source.kind === "ocr" && fact === "not_executed" ? input.source.registration.input.operationId : null, automaticRetry: false },
                observation: textObservation(input), rawError: { name: "TextStageError", message: code, stack: null, details: { code, executionFact: fact } },
                candidate: output ? { schema: "text-output/1", value: output } : response !== null ? { schema: "text-raw-response/1", value: { rawResponse: response } } : null,
                inspection: { kind: "none" } });
            try {
                await this.deps.reviews.append(review);
            }
            catch {
                if (!(await inspectRegistration(this.deps.reviews, review)).registered)
                    throw new TextError("TEXT.REVIEW_UNKNOWN");
            }
            if (!(await inspectRegistration(this.deps.reviews, review)).registered)
                throw new TextError("TEXT.REVIEW_UNKNOWN");
            return { status: "review", operationId: input.operationId, reviewId: review.reviewId, code, automaticRetry: false };
        }
    }
}
