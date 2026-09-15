import { OcrRegistrationSchema, OcrOutputSchema, OcrIntentSchema, observationIdentity, assertProcessingResultMatches,
  type KeywordResult } from "@crawl-automation/v3-contracts";
import type { ObjectStore } from "@crawl-automation/v3-artifacts";
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";
import type { OcrResultHandoff, ResultRegistry } from "@crawl-automation/v3-results";
import { screenKeywords, verifySelection } from "./keywords.js";
/** Business adapter: registered OCR only, not a file pathname or unverified caller text. */
export class RegisteredOcrEvidence {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">,
    private readonly handoff: Pick<OcrResultHandoff, "inspect">,
    private readonly registry: Pick<ResultRegistry, "read">) {}
  private async read(raw: unknown, signal: AbortSignal) {
    const registration = OcrRegistrationSchema.parse(raw), owner = observationIdentity(registration.input);
    const facts = await this.handoff.inspect(registration.input, signal);
    if (!facts.resultRegistered || !facts.artifactDurable || JSON.stringify(facts.record) !== JSON.stringify(registration))
      throw Error("SCREEN.UPSTREAM_UNVERIFIED");
    const resolved = await this.artifacts.resolve(registration.result, owner, signal);
    const output = OcrOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes)));
    assertProcessingResultMatches(registration.input, output, "output");
    return { registration, owner, text: output.text };
  }
  async screen(registration: unknown, signal: AbortSignal) {
    const r = await this.read(registration, signal);
    return screenKeywords({ observation: r.owner, image: r.registration.input.file,
      ocrOperationId: r.registration.input.operationId, text: r.text });
  }
  async verifiedText(selection: KeywordResult, signal: AbortSignal) {
    const raw = await this.registry.read(selection.ocrOperationId);
    if (!raw) throw Error("SCREEN.UPSTREAM_UNVERIFIED");
    const r = await this.read(raw, signal);
    if (JSON.stringify(r.owner) !== JSON.stringify(selection.observation) || JSON.stringify(r.registration.input.file) !== JSON.stringify(selection.image))
      throw Error("SCREEN.SOURCE_CONFLICT");
    verifySelection(selection, r.text); return r.text;
  }
}

/** Cloud mode: a worker without a ledger verifies the selected OCR text from remote evidence only. The OCR input is
 * recovered from the retained intent object, the result is rebuilt and hash-verified from remote bytes, and the text
 * must match the selection's own OCR text digest. The selection itself came through the workflow from the Mini. */
export class RemoteOcrEvidence {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">,
    private readonly handoff: Pick<OcrResultHandoff, "inspectRemote">, private readonly store: Pick<ObjectStore, "read">) {}
  async verifiedText(selection: KeywordResult, signal: AbortSignal) {
    const bytes = await this.store.read(`ocr-intents/${selection.ocrOperationId}.json`, 65536, signal);
    if (!bytes) throw Error("SCREEN.UPSTREAM_UNVERIFIED");
    let input;
    try { input = OcrIntentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).input; }
    catch { throw Error("SCREEN.UPSTREAM_UNVERIFIED"); }
    const facts = await this.handoff.inspectRemote(input, signal);
    if (!facts.artifactDurable || !facts.record) throw Error("SCREEN.UPSTREAM_UNVERIFIED");
    const registration = OcrRegistrationSchema.parse(facts.record), owner = observationIdentity(registration.input);
    if (registration.input.operationId !== selection.ocrOperationId || JSON.stringify(owner) !== JSON.stringify(selection.observation) ||
      JSON.stringify(registration.input.file) !== JSON.stringify(selection.image)) throw Error("SCREEN.SOURCE_CONFLICT");
    const resolved = await this.artifacts.resolve(registration.result, owner, signal);
    const output = OcrOutputSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes)));
    assertProcessingResultMatches(registration.input, output, "output");
    verifySelection(selection, output.text); return output.text;
  }
}
