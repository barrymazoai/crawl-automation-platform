import { z } from "zod";
import { ArtifactRefSchema, ObservationSchema, ExecutionIdSchema, Sha256Schema, VersionTagSchema, assertArtifactBelongsTo } from "./artifacts.js";
import { OcrRegistrationSchema } from "./registration.js";
import { LabelTextCandidateSchema } from "./label-extraction.js";
export const TextDocumentSchema = z.strictObject({ ...ObservationSchema.shape,
    producer: z.enum(["page.prepare", "pdf.text", "label.core.prepare"]), source: ArtifactRefSchema,
    corePolicy: z.enum(["gnc-label-core/1", "swanson-label-core/1"]).optional(),
    pageIndex: z.number().int().nonnegative().nullable(), text: z.string().min(1).max(200000),
}).refine(d => {
    try {
        assertArtifactBelongsTo(d.source, textObservation(d));
    }
    catch {
        return false;
    }
    if ((d.producer === "label.core.prepare") !== !!d.corePolicy) return false;
    return d.producer !== "pdf.text" ? d.source.kind === "source-html" && d.pageIndex === null : d.source.kind === "source-pdf" && d.pageIndex !== null;
}, "Prepared text must retain the correct source and page provenance");
export type TextDocument = z.infer<typeof TextDocumentSchema>;
export const TextSourceSchema = z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("prepared"), document: ArtifactRefSchema.refine(r => r.kind === "result-json" && ["page.prepare", "pdf.text", "label.core.prepare"].includes(r.producer.module)) }),
    z.strictObject({ kind: z.literal("ocr"), registration: OcrRegistrationSchema }),
]);
export const TextCompatibilitySchema = z.strictObject({ schemaVersion: z.literal(1), module: z.literal("codex.text"),
    implementationVersion: VersionTagSchema, policyVersion: VersionTagSchema, resultSchemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    configFingerprint: Sha256Schema });
export type TextCompatibility = z.infer<typeof TextCompatibilitySchema>;
export const TextInputSchema = z.strictObject({ ...ObservationSchema.shape, ...TextCompatibilitySchema.shape,
    operationId: ExecutionIdSchema, inputFingerprint: Sha256Schema, source: TextSourceSchema,
    // Half-open UTF-16 code-unit offsets into the original decoded text, not bytes or code points.
    range: z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive().max(200000) }).refine(r => r.end > r.start),
}).superRefine((input, ctx) => {
    if (input.resultSchemaVersion === 3 && (input.implementationVersion !== "codex-text/3" || !["label-text/1", "label-text/2", "label-text/3", "label-text/4"].includes(input.policyVersion)))
        ctx.addIssue({ code: "custom", message: "Label text requires its explicit implementation and policy" });
    const source = input.source;
    const ref = source.kind === "prepared" ? source.document : source.registration.result;
    if (ref.producer.operationId === input.operationId)
        ctx.addIssue({ code: "custom", message: "Text cannot depend on its own operation" });
    try {
        assertArtifactBelongsTo(ref, textObservation(input));
    }
    catch {
        ctx.addIssue({ code: "custom", message: "Text source ownership mismatch" });
    }
    if (source.kind === "ocr") {
        const upstream = source.registration.input;
        if (upstream.requestId !== input.requestId || upstream.brandId !== input.brandId || upstream.operationId === input.operationId)
            ctx.addIssue({ code: "custom", message: "OCR source request/brand/operation mismatch" });
    }
});
export type TextInput = z.infer<typeof TextInputSchema>;
export function textFingerprint(input: Omit<TextInput, "inputFingerprint">, hash: (text: string) => string): string {
    const parsed = TextInputSchema.parse({ ...input, inputFingerprint: "0".repeat(64) });
    const { inputFingerprint: _ignored, ...material } = parsed;
    return Sha256Schema.parse(hash(JSON.stringify(["v3:codex-text:1", material])));
}
export function parseTextInput(raw: unknown, hash: (text: string) => string): TextInput {
    const input = TextInputSchema.parse(raw);
    if (textFingerprint(input, hash) !== input.inputFingerprint)
        throw Error("TEXT.INPUT_CONFLICT");
    return input;
}
export function textObservation(input: z.infer<typeof ObservationSchema>) { return ObservationSchema.parse(Object.fromEntries(Object.keys(ObservationSchema.shape).map(key => [key, input[key as keyof typeof input]]))); }
export function textIdentity(input: TextInput) {
    return { schemaVersion: input.schemaVersion, module: input.module, operationId: input.operationId, requestId: input.requestId,
        observationId: input.observationId, implementationVersion: input.implementationVersion, policyVersion: input.policyVersion,
        resultSchemaVersion: input.resultSchemaVersion, configFingerprint: input.configFingerprint, inputFingerprint: input.inputFingerprint };
}
const quote = z.strictObject({ text: z.string().min(1).max(20000), start: z.number().int().nonnegative(), end: z.number().int().positive().max(200000) });
export const TextCandidateV1Schema = z.strictObject({
    formula: z.strictObject({ servingSize: quote.nullable(), nutrients: z.array(z.strictObject({ name: quote, amount: quote.nullable(), dailyValue: quote.nullable() })).min(1).max(200) }).nullable(),
    ingredients: z.strictObject({ items: z.array(quote).min(1).max(300) }).nullable(),
});
/** V1 is readable evidence only; V2 keeps ingredient roles and their formula parent. */
export const TextCandidateV2Schema = z.strictObject({
    schemaVersion: z.literal(2),
    formula: TextCandidateV1Schema.shape.formula,
    ingredients: z.strictObject({ items: z.array(z.strictObject({ ...quote.shape,
        role: z.enum(["blend_component", "other"]), parentNutrientIndex: z.number().int().nonnegative().nullable(),
    })).min(1).max(300) }).nullable(),
}).superRefine((candidate, ctx) => {
    for (const item of candidate.ingredients?.items ?? []) {
        if (item.role === "other" ? item.parentNutrientIndex !== null :
            item.parentNutrientIndex === null || !candidate.formula?.nutrients[item.parentNutrientIndex])
            ctx.addIssue({ code: "custom", message: "Ingredient role/parent mismatch" });
    }
});
export const TextCandidateSchema = z.union([TextCandidateV1Schema, TextCandidateV2Schema]);
export type TextCandidate = z.infer<typeof TextCandidateSchema>;
/** New execution result; deliberately not added to legacy product-candidate readers. */
export const TextCandidateV3Schema = LabelTextCandidateSchema.extend({ schemaVersion: z.literal(3) });
export type TextCandidateV3 = z.infer<typeof TextCandidateV3Schema>;
export const TextResultCandidateSchema = z.union([TextCandidateV1Schema, TextCandidateV2Schema, TextCandidateV3Schema]);
/** Extractive candidates only. Normalization and product eligibility belong to the next module. */
export function assertTextQuotes(candidate: TextCandidate | TextCandidateV3, input: TextInput, fullText: string) {
    const quotes = "codec" in candidate ? [
        ...(candidate.formula?.servingSize ? [candidate.formula.servingSize] : []),
        ...(candidate.formula?.servingsPerContainer ? [candidate.formula.servingsPerContainer] : []),
        ...(candidate.formula?.columns.flatMap(c => [...(c.heading ? [c.heading] : []), ...c.rows.flatMap(r =>
            [r.name, ...(r.amount ? [r.amount] : []), ...(r.dailyValue ? [r.dailyValue] : [])])]) ?? []),
        ...(candidate.otherIngredients ? [candidate.otherIngredients.heading, ...candidate.otherIngredients.items] : []),
        ...candidate.exclusions.map(e => e.quote),
    ] : [...(candidate.formula?.servingSize ? [candidate.formula.servingSize] : []),
        ...(candidate.formula?.nutrients.flatMap(n => [n.name, ...(n.amount ? [n.amount] : []), ...(n.dailyValue ? [n.dailyValue] : [])]) ?? []),
        ...(candidate.ingredients?.items ?? [])];
    for (const q of quotes)
        if (q.start < input.range.start || q.end > input.range.end || q.end <= q.start || fullText.slice(q.start, q.end) !== q.text)
            throw Error("TEXT.CITATION_INVALID");
}
export const TextOutputSchema = z.strictObject({ ...TextCompatibilitySchema.shape,
    operationId: ExecutionIdSchema, requestId: ExecutionIdSchema, observationId: ExecutionIdSchema, inputFingerprint: Sha256Schema,
    provider: VersionTagSchema, rawResponse: z.string().min(1).max(250000), candidate: TextResultCandidateSchema })
    .refine(o => o.resultSchemaVersion === ("schemaVersion" in o.candidate ? o.candidate.schemaVersion : 1), "Candidate version mismatch");
export type TextOutput = z.infer<typeof TextOutputSchema>;
export const TextRecordSchema = z.strictObject({ schemaVersion: z.literal(1), storageId: VersionTagSchema,
    input: TextInputSchema, result: ArtifactRefSchema, completion: ArtifactRefSchema,
}).superRefine((r, ctx) => {
    for (const ref of [r.result, r.completion]) {
        try {
            assertArtifactBelongsTo(ref, textObservation(r.input));
        }
        catch {
            ctx.addIssue({ code: "custom", message: "Output ownership mismatch" });
        }
        if (ref.kind !== "result-json" || ref.producer.module !== r.input.module || ref.producer.operationId !== r.input.operationId || ref.producer.implementationVersion !== r.input.implementationVersion)
            ctx.addIssue({ code: "custom", message: "Output producer mismatch" });
    }
    const upstream = r.input.source.kind === "prepared" ? [r.input.source.document] : [r.input.source.registration.input.file, r.input.source.registration.result, r.input.source.registration.completion];
    const refs = [...upstream, r.result, r.completion];
    if (new Set(refs.map(f => f.objectKey)).size !== refs.length || new Set(refs.map(f => f.artifactId)).size !== refs.length)
        ctx.addIssue({ code: "custom", message: "Output artifacts must be distinct from source evidence" });
});
export type TextRecord = z.infer<typeof TextRecordSchema>;
export const TextActivityOutcomeSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("registered"), operationId: ExecutionIdSchema, result: ArtifactRefSchema, completion: ArtifactRefSchema }),
    z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, reviewId: ExecutionIdSchema, code: z.string().regex(/^TEXT\.[A-Z_]+$/), automaticRetry: z.literal(false) }),
]);
export type TextActivityOutcome = z.infer<typeof TextActivityOutcomeSchema>;
/** A small receipt is not proof of durable, correctly attributed evidence. */
export const TextReceiptInputSchema = z.strictObject({ input: TextInputSchema, outcome: TextActivityOutcomeSchema.nullable() });
export type TextReceiptInput = z.infer<typeof TextReceiptInputSchema>;
export const TextReceiptOutcomeSchema = z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("registered"), registration: TextRecordSchema }),
    z.strictObject({ status: z.literal("review"), operationId: ExecutionIdSchema, reviewId: ExecutionIdSchema,
        code: z.string().regex(/^(TEXT|TEXT_RECEIPT)\.[A-Z_]+$/), automaticRetry: z.literal(false) }),
]);
export type TextReceiptOutcome = z.infer<typeof TextReceiptOutcomeSchema>;
export const PreparedTextWorkflowInputSchema = z.strictObject({
    task: TextInputSchema.refine(t => t.source.kind === "prepared" && [2, 3].includes(t.resultSchemaVersion),
        "Prepared text workflow requires a prepared document and V2 or explicit V3 extraction"),
    queues: z.strictObject({ text: z.string().min(1).max(255), receipts: z.string().min(1).max(255) }),
});
export function textActivityOptions(taskQueue: string) {
    return { taskQueue, startToCloseTimeout: "5 minutes" as const, scheduleToCloseTimeout: "15 minutes" as const,
        heartbeatTimeout: "10 seconds" as const, retry: { maximumAttempts: 1 } };
}
