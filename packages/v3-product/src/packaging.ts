import { isDeepStrictEqual } from "node:util";
import { ObservationSchema, TextDocumentSchema, ArtifactRefSchema, PackagingClaimSchema, PackagingFactsSchema,
  textObservation, assertArtifactBelongsTo, type PackagingClaim } from "@crawl-automation/v3-contracts";
import type { ArtifactResolver } from "@crawl-automation/v3-artifacts";

const normalize = (s: string) => s.replace(/\s+/gu, " ").trim();
/** Deterministic parsing of explicit labels; never infer a missing unit or multiply package quantities. */
export function extractPackagingFacts(owner: unknown, documents: { ref: unknown; document: unknown }[]) {
  const observation = ObservationSchema.parse(owner), claims: PackagingClaim[] = [];
  if (!documents.length || documents.length > 100) throw Error("PACKAGING.SOURCE_LIMIT");
  const seen = new Set<string>();
  for (const entry of documents) {
    const ref = ArtifactRefSchema.parse(entry.ref), document = TextDocumentSchema.parse(entry.document);
    assertArtifactBelongsTo(ref, observation);
    if (ref.kind !== "result-json" || !["page.prepare", "pdf.text"].includes(ref.producer.module) ||
        !isDeepStrictEqual(textObservation(document), observation)) throw Error("PACKAGING.SOURCE_IDENTITY_CONFLICT");
    if (seen.has(ref.objectKey)) throw Error("PACKAGING.DUPLICATE_SOURCE");
    seen.add(ref.objectKey);
    const lines = [...document.text.matchAll(/[^\r\n]+/g)].map(m => ({ text: m[0], start: m.index! }));
    const add = (field: PackagingClaim["field"], value: string, start: number, end: number) => {
      claims.push(PackagingClaimSchema.parse({ document: ref, field, value: normalize(value),
        quote: { start, end, text: document.text.slice(start, end) } }));
    };
    for (const [index, line] of lines.entries()) {
      const label = /^\s*(Serving Size|Servings Per Container)\s*:?\s*(.*?)\s*$/i.exec(line.text);
      if (label) {
        const field = /^serving size$/i.test(label[1]!) ? "servingSize" : "servingsPerContainer";
        const inline = label[2]!.trim(), next = lines.slice(index + 1).find(l => l.text.trim());
        const value = inline || next?.text.trim() || "";
        // Refuse to turn the next section title into a quantity; preserve unknown instead.
        if (/^(?:about\s+|approximately\s+)?\d/i.test(value)) {
          const end = inline ? line.start + line.text.length : next!.start + next!.text.length;
          add(field, value, line.start, end);
        }
      }
      // Keep source words verbatim. Neither syntax proves bundle composition or servings/container.
      for (const match of line.text.matchAll(/\b(?:\d+(?:\.\d+)?\s*[- ]?\s*packs?\b|pack\s+of\s+\d+(?:\.\d+)?\b)/gi)) {
        const start = line.start + match.index!;
        add("packMention", match[0], start, start + match[0].length);
      }
    }
  }
  // Fixed order for concurrent-source completion order independence; all original claims remain.
  claims.sort((a, b) => (a.document.objectKey < b.document.objectKey ? -1 : a.document.objectKey > b.document.objectKey ? 1 : 0) || a.quote.start - b.quote.start);
  const resolve = (field: "servingSize" | "servingsPerContainer") => {
    const selected = claims.filter(c => c.field === field), values = [...new Set(selected.map(c => normalize(c.value)))];
    return { status: values.length === 0 ? "unknown" : values.length === 1 ? "observed" : "conflict",
      value: values.length === 1 ? values[0]! : null, claims: selected };
  };
  const servingSize = resolve("servingSize"), servingsPerContainer = resolve("servingsPerContainer");
  const unresolvedPackMentions = claims.filter(c => c.field === "packMention");
  return PackagingFactsSchema.parse({ codec: "packaging-facts/1", observation, productComposition: "unknown", containerCount: null,
    servingSize, servingsPerContainer, unresolvedPackMentions,
    warnings: [...(servingsPerContainer.status === "conflict" ? ["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"] : []),
      ...(unresolvedPackMentions.length ? ["PACKAGING.PACK_MEANING_UNRESOLVED"] : [])],
    blockingIssues: servingSize.status === "conflict" ? ["PACKAGING.SERVING_SIZE_CONFLICT"] : [] });
}

/** Runtime entry loads hash-verified documents through the shared artifact resolver, not caller filenames. */
export class PackagingEvidence {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">) {}
  async inspect(owner: unknown, refs: unknown[], signal: AbortSignal) {
    const observation = ObservationSchema.parse(owner);
    if (!refs.length || refs.length > 100) throw Error("PACKAGING.SOURCE_LIMIT");
    const documents = [];
    for (const raw of refs) {
      const ref = ArtifactRefSchema.parse(raw);
      assertArtifactBelongsTo(ref, observation);
      const resolved = await this.artifacts.resolve(ref, observation, signal);
      const document = TextDocumentSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(resolved.bytes)));
      if (document.producer !== ref.producer.module) throw Error("PACKAGING.SOURCE_IDENTITY_CONFLICT");
      // The derived text is not enough: retain and reverify its original source as well.
      await this.artifacts.resolve(document.source, observation, signal);
      documents.push({ ref, document });
    }
    return extractPackagingFacts(observation, documents);
  }
}
