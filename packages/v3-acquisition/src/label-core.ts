import { parseDocument } from "htmlparser2";
import { isDeepStrictEqual as equal } from "node:util";
import { ArtifactRefSchema, ObservationSchema, TextDocumentSchema, LabelCoreInputSchema, LabelCoreOutcomeSchema, textObservation, assertArtifactBelongsTo, type ArtifactRef, type Observation } from "@crawl-automation/v3-contracts";
import { sha256, type ArtifactResolver, type ObjectStore } from "@crawl-automation/v3-artifacts";
type Node = { type: string; name?: string; attribs?: Record<string, string>; data?: string; children?: Node[] };
const omitted = new Set(["script", "style", "template", "noscript"]);
const blocks = new Set(["table", "tr", "td", "th", "p", "div", "br", "h4", "li"]);
const normalize = (s: string) => s.replace(/[\t\r \u00a0]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const hasClass = (n: Node, name: string) => n.attribs?.class?.split(/\s+/).includes(name) ?? false;
function find(nodes: Node[], predicate: (n: Node) => boolean): Node[] {
  return nodes.flatMap(n => omitted.has(n.name ?? "") ? [] : [...(predicate(n) ? [n] : []), ...find(n.children ?? [], predicate)]);
}
function text(n: Node): string {
  if (omitted.has(n.name ?? "")) return "";
  if (n.type === "text") return n.data ?? "";
  const body = (n.children ?? []).map(text).join("");
  return blocks.has(n.name ?? "") ? `\n${body}\n` : body;
}
/** Pure, SKU-fragment-scoped GNC preparation; not a generic page cleaner or a model. */
export function extractGncLabelCore(html: string): string {
  if (Buffer.byteLength(html) > 2 * 1024 * 1024) throw Error("LABEL_CORE.SOURCE_LIMIT");
  const document = parseDocument(html) as Node;
  // Bound traversal before recursive selection/text extraction, including adversarial nesting.
  const pending = [{ node: document, depth: 0 }]; let count = 0;
  while (pending.length) { const { node, depth } = pending.pop()!;
    if (++count > 50000 || depth > 100) throw Error("LABEL_CORE.SOURCE_LIMIT");
    pending.push(...(node.children ?? []).map(node => ({ node, depth: depth + 1 })));
  }
  const labels = find(document.children ?? [], n => hasClass(n, "product-nutrition-description"));
  if (labels.length !== 1) throw Error("LABEL_CORE.LABEL_SCOPE_AMBIGUOUS");
  // Exactly one outer table; nested layout tables remain part of its evidence.
  const outerTables: Node[] = [];
  const tables = (n: Node) => { if (n.name === "table") outerTables.push(n); else (n.children ?? []).forEach(tables); };
  tables(labels[0]!);
  if (outerTables.length !== 1) throw Error("LABEL_CORE.TABLE_SCOPE_AMBIGUOUS");
  const facts = normalize(text(outerTables[0]!));
  if (!/serving\s+size/i.test(facts) || !/amounts?\s+per\s+serving/i.test(facts)) throw Error("LABEL_CORE.TABLE_UNVERIFIED");
  const sections = find(labels[0]!.children ?? [], n => hasClass(n, "pdp-details-accordion__section"));
  const other = sections.filter(n => find(n.children ?? [], h => h.name === "h4").some(h => /^other\s+ingredients\s*:?$/i.test(normalize(text(h)))));
  if (other.length !== 1) throw Error("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  const content = find(other[0]!.children ?? [], n => hasClass(n, "pdp-details-accordion__section-content"));
  if (content.length !== 1 || !normalize(text(content[0]!))) throw Error("LABEL_CORE.INGREDIENT_SCOPE_AMBIGUOUS");
  // Do not rewrite ingredient words, doses, group names or footer text.
  const result = `${facts}\n\n${normalize(text(other[0]!))}`;
  if (result.length > 200000) throw Error("LABEL_CORE.OUTPUT_LIMIT");
  return result;
}
/** Input artifact references in, durable text document out. Original HTML remains immutable evidence. */
export class LabelCorePreparation {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">, private readonly remote: ObjectStore) {}
  async run(rawOwner: Observation, rawSource: ArtifactRef, signal: AbortSignal) {
    return this.prepare(rawOwner, rawSource, signal, true);
  }
  async inspect(rawOwner: Observation, rawSource: ArtifactRef, signal: AbortSignal) {
    return this.prepare(rawOwner, rawSource, signal, false);
  }
  private async prepare(rawOwner: Observation, rawSource: ArtifactRef, signal: AbortSignal, publish: boolean) {
    signal.throwIfAborted();
    const owner = ObservationSchema.parse(rawOwner), source = assertArtifactBelongsTo(rawSource, owner);
    if (source.kind !== "source-html" || source.producer.module !== "gnc.product-input") throw Error("LABEL_CORE.SOURCE_UNSUPPORTED");
    const html = new TextDecoder("utf-8", { fatal: true }).decode((await this.artifacts.resolve(source, owner, signal)).bytes);
    const document = TextDocumentSchema.parse({ ...owner, producer: "label.core.prepare", corePolicy: "gnc-label-core/1", source, pageIndex: null, text: extractGncLabelCore(html) });
    const bytes = Buffer.from(JSON.stringify(document)), hash = sha256(bytes), operationId = `core-${sha256(Buffer.from(JSON.stringify([owner, source, document.corePolicy])))}`;
    const ref = ArtifactRefSchema.parse({ ...source, kind: "result-json", mediaType: "application/json", artifactId: operationId,
      objectKey: `v3/label-core/${operationId}/document.json`, byteSize: bytes.length, sha256: hash,
      producer: { operationId, module: "label.core.prepare", implementationVersion: "gnc-label-core/1" } });
    let prior = await this.remote.read(ref.objectKey, 1048576, signal);
    if (!prior && publish) {
      // Deterministic, content-addressed pure preparation. Re-publication never re-executes OCR/models.
      try { await this.remote.create(ref.objectKey, bytes, "application/json", signal); } catch { /* Readback only. */ }
      prior = await this.remote.read(ref.objectKey, 1048576, signal);
    }
    if (!prior || sha256(prior) !== hash || !equal(TextDocumentSchema.parse(JSON.parse(Buffer.from(prior).toString("utf8"))), document)) throw Error("LABEL_CORE.HANDOFF_UNVERIFIED");
    return { document, ref };
  }
}
/** Atomic worker boundary. Full page remains an independent packaging input. */
export class PrepareLabelCore {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">, private readonly core: Pick<LabelCorePreparation, "run" | "inspect">) {}
  run(raw: unknown, signal: AbortSignal) { return this.resolve(raw, signal, true); }
  inspect(raw: unknown, signal: AbortSignal) { return this.resolve(raw, signal, false); }
  private async resolve(raw: unknown, signal: AbortSignal, publish: boolean) {
    signal.throwIfAborted();
    const input = LabelCoreInputSchema.parse(raw);
    const bytes = (await this.artifacts.resolve(input.fullDocument, input.owner, signal)).bytes;
    const full = TextDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (full.producer !== "page.prepare" || full.pageIndex !== null || !equal(textObservation(full), input.owner)) throw Error("LABEL_CORE.IDENTITY_CONFLICT");
    const result = await this.core[publish ? "run" : "inspect"](input.owner, full.source, signal);
    return LabelCoreOutcomeSchema.parse({ status: "prepared", input, document: result.ref, range: { start: 0, end: result.document.text.length } });
  }
}
