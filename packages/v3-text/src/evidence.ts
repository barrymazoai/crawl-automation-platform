import { TextDocumentSchema, OcrOutputSchema, assertProcessingResultMatches, textObservation, type TextInput, type ArtifactRef } from "@crawl-automation/v3-contracts";
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import type { OcrResultHandoff } from "@crawl-automation/v3-results";
import { TextError } from "./ports.js";
import { extractGncLabelCore, extractSwansonLabelCore } from "@crawl-automation/v3-acquisition";
export class TextEvidence {
    constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">, private readonly ocr: Pick<OcrResultHandoff, "inspect">) { }
    async resolve(input: TextInput, signal: AbortSignal): Promise<{
        text: string;
        refs: ArtifactRef[];
    }> {
        const owner = textObservation(input);
        let text: string, refs: ArtifactRef[];
        try {
            if (input.source.kind === "ocr") {
                const expected = input.source.registration, facts = await this.ocr.inspect(expected.input, signal);
                if (!facts.resultRegistered || !facts.artifactDurable || JSON.stringify(facts.record) !== JSON.stringify(expected))
                    throw new TextError("TEXT.UPSTREAM_UNVERIFIED", "not_executed");
                const result = await this.artifacts.resolve(expected.result, owner, signal);
                const output = OcrOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)));
                assertProcessingResultMatches(expected.input, output, "output");
                text = output.text;
                refs = [expected.input.file, expected.result, expected.completion];
            }
            else {
                const ref = input.source.document, bytes = (await this.artifacts.resolve(ref, owner, signal)).bytes;
                const doc = TextDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
                if (JSON.stringify(textObservation(doc)) !== JSON.stringify(owner) || doc.producer !== ref.producer.module)
                    throw new TextError("TEXT.SOURCE_CONFLICT", "not_executed");
                const original = await this.artifacts.resolve(doc.source, owner, signal);
                if (doc.producer === "label.core.prepare" && (doc.source.producer.module !== (doc.corePolicy==="swanson-label-core/1"?"channel.product-input":"gnc.product-input") ||
                    ref.producer.implementationVersion !== doc.corePolicy ||
                    doc.corePolicy==="swanson-label-core/1"&&doc.source.producer.implementationVersion!=="channel-plan/1" ||
                    doc.text !== (doc.corePolicy==="swanson-label-core/1"?extractSwansonLabelCore:extractGncLabelCore)(new TextDecoder("utf-8", { fatal: true }).decode(original.bytes))))
                    throw new TextError("TEXT.SOURCE_CONFLICT", "not_executed");
                text = doc.text;
                refs = [ref, doc.source];
            }
            if (text.length > 200000 || input.range.end > text.length || !text.slice(input.range.start, input.range.end).trim())
                throw new TextError("TEXT.RANGE_INVALID", "not_executed");
            // Never split an astral character at a range boundary.
            for (const offset of [input.range.start, input.range.end])
                if (offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset] ?? ""))
                    throw new TextError("TEXT.RANGE_INVALID", "not_executed");
            return { text, refs };
        }
        catch (e) {
            if (e instanceof TextError)
                throw e;
            throw new TextError("TEXT.EVIDENCE_UNAVAILABLE", "not_executed");
        }
    }
}
