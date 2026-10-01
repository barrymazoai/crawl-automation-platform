import {
  PreparedPageRecordSchema,
  PageTablesSchema,
  TextDocumentSchema,
  textObservation,
  type ArtifactRef,
  type Observation,
  type TextInput,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { checkedPageInput } from "../pages/page-input.js";
import { parsePage } from "../pages/page-parser.js";
import { recheckErrors } from "./errors.js";
import { assertRecheckIdentity, RecheckFiles } from "./verified-files.js";
import type { SavedAnswerDeps } from "./types.js";

/** Checks saved preparation again, including byte-exact sources and today's deterministic extraction. */
export class RecheckPreparation {
  private readonly files: RecheckFiles;
  constructor(private readonly deps: SavedAnswerDeps) {
    this.files = new RecheckFiles(deps.objects);
  }

  async text(input: TextInput, signal: AbortSignal) {
    if (input.source.kind !== "prepared") {
      throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
    }
    await this.document(input.source.document, textObservation(input), signal);
    const resolved = await this.deps.text.resolve(input, signal);
    assertRecheckIdentity(input.range, { start: 0, end: resolved.text.length });
    return resolved.text;
  }

  async document(ref: ArtifactRef, owner: Observation, signal: AbortSignal) {
    const document = TextDocumentSchema.parse(
      decodeJson(await this.files.artifact(ref, owner, signal)),
    );
    assertRecheckIdentity(textObservation(document), owner);
    assertRecheckIdentity(ref.producer.module, document.producer);
    const original = await this.files.artifact(document.source, owner, signal);
    if (document.producer === "page.prepare") {
      await this.page({ ref, document, original }, signal);
    } else if (document.producer === "label.core.prepare") {
      const policy = document.corePolicy && this.deps.labelCores[document.corePolicy];
      if (!policy || policy.extract(Buffer.from(original).toString("utf8")) !== document.text) {
        throw recheckErrors.create("RECHECK.PREPARATION_CHANGED");
      }
    } else {
      throw recheckErrors.create("RECHECK.RECEIPT_UNVERIFIED");
    }
    return { ref, document };
  }

  private async page(
    at: {
      ref: ArtifactRef;
      document: ReturnType<typeof TextDocumentSchema.parse>;
      original: Uint8Array;
    },
    signal: AbortSignal,
  ) {
    const key = `v3/pages/${at.ref.producer.operationId}/completion.json`;
    const record = PreparedPageRecordSchema.parse(await this.files.json(key, signal));
    const input = checkedPageInput(record.input);
    assertRecheckIdentity(input.operationId, at.ref.producer.operationId);
    assertRecheckIdentity(record.document, at.ref);
    assertRecheckIdentity(input.page, at.document.source);
    assertRecheckIdentity(textObservation(input), textObservation(at.document));
    const owner = textObservation(at.document);
    const tables = PageTablesSchema.parse(
      decodeJson(await this.files.artifact(record.tables, owner, signal)),
    );
    const current = parsePage(input, at.original, signal);
    assertRecheckIdentity(tables, current.tables);
    if (current.text !== at.document.text) {
      throw recheckErrors.create("RECHECK.PREPARATION_CHANGED");
    }
  }
}
