import { OcrRegistrationSchema, OcrOutputSchema, observationIdentity, assertProcessingResultMatches,
  type KeywordResult } from "@crawl-automation/v3-contracts";
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
