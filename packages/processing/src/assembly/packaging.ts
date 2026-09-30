import { isDeepStrictEqual } from "node:util";
import type { ArtifactResolver } from "@crawl-automation/platform";
import {
  ArtifactRefSchema,
  ObservationSchema,
  PackagingClaimSchema,
  PackagingFactsSchema,
  TextDocumentSchema,
  assertArtifactBelongsTo,
  textObservation,
  type ArtifactRef,
  type Observation,
  type PackagingClaim,
  type PackagingFacts,
  type TextDocument,
} from "@crawl-automation/v3-contracts";
import { decodeJson } from "../results/result-record.js";
import { assemblyFailure } from "./assembly-errors.js";
import { byText, words } from "./merge-state.js";

type Line = { text: string; start: number };
type Field = PackagingClaim["field"];

const MAX_DOCUMENTS = 100;
const LABEL_LINE = /^\s*(Serving Size|Servings Per Container)\s*:?\s*(.*?)\s*$/i;
const PACK_MENTION = /\b(?:\d+(?:\.\d+)?\s*[- ]?\s*packs?\b|pack\s+of\s+\d+(?:\.\d+)?\b)/gi;
const QUANTITY = /^(?:about\s+|approximately\s+)?\d/i;

/**
 * Packaging facts read from explicit labels in the full page documents: never a guessed unit, never multiplied
 * package quantities. Every original claim is kept, in a fixed order.
 */
export function extractPackagingFacts(
  owner: unknown,
  documents: { ref: unknown; document: unknown }[],
): PackagingFacts {
  const observation = ObservationSchema.parse(owner);
  if (!documents.length || documents.length > MAX_DOCUMENTS) {
    throw assemblyFailure("PACKAGING.SOURCE_LIMIT");
  }
  const seen = new Set<string>();
  const claims: PackagingClaim[] = [];
  for (const entry of documents) {
    const { ref, document } = ownDocument(observation, entry);
    if (seen.has(ref.objectKey)) {
      throw assemblyFailure("PACKAGING.DUPLICATE_SOURCE");
    }
    seen.add(ref.objectKey);
    claims.push(...documentClaims(ref, document));
  }
  claims.sort(
    (left, right) =>
      byText(left.document.objectKey, right.document.objectKey) ||
      left.quote.start - right.quote.start,
  );
  return packagingFacts(observation, claims);
}

/** The facts over every claim: a field is observed, unknown or in conflict; conflicts and pack mentions warn. */
function packagingFacts(observation: Observation, claims: PackagingClaim[]): PackagingFacts {
  const servingSize = resolved(claims, "servingSize");
  const servingsPerContainer = resolved(claims, "servingsPerContainer");
  const unresolvedPackMentions = claims.filter((claim) => claim.field === "packMention");
  const countConflict = servingsPerContainer.status === "conflict";
  const warnings = [
    ...(countConflict ? ["PACKAGING.SERVINGS_PER_CONTAINER_CONFLICT"] : []),
    ...(unresolvedPackMentions.length ? ["PACKAGING.PACK_MEANING_UNRESOLVED"] : []),
  ];
  const blockingIssues =
    servingSize.status === "conflict" ? ["PACKAGING.SERVING_SIZE_CONFLICT"] : [];
  return PackagingFactsSchema.parse({
    codec: "packaging-facts/1",
    observation,
    productComposition: "unknown",
    containerCount: null,
    servingSize,
    servingsPerContainer,
    unresolvedPackMentions,
    warnings,
    blockingIssues,
  });
}

function ownDocument(observation: Observation, entry: { ref: unknown; document: unknown }) {
  const ref = ArtifactRefSchema.parse(entry.ref);
  const document = TextDocumentSchema.parse(entry.document);
  assertArtifactBelongsTo(ref, observation);
  const own =
    ref.kind === "result-json" &&
    ["page.prepare", "pdf.text"].includes(ref.producer.module) &&
    isDeepStrictEqual(textObservation(document), observation);
  if (!own) {
    throw assemblyFailure("PACKAGING.SOURCE_IDENTITY_CONFLICT");
  }
  return { ref, document };
}

function documentClaims(ref: ArtifactRef, document: TextDocument): PackagingClaim[] {
  const lines: Line[] = [...document.text.matchAll(/[^\r\n]+/g)].map((match) => ({
    text: match[0],
    start: match.index,
  }));
  const claims: PackagingClaim[] = [];
  const add = (field: Field, value: string, span: { start: number; end: number }) =>
    claims.push(
      PackagingClaimSchema.parse({
        document: ref,
        field,
        value: words(value),
        quote: {
          start: span.start,
          end: span.end,
          text: document.text.slice(span.start, span.end),
        },
      }),
    );
  for (const [index, line] of lines.entries()) {
    labelClaim(lines, index, add);
    // Source words are kept as written; neither syntax proves bundle composition or servings per container.
    for (const match of line.text.matchAll(PACK_MENTION)) {
      const start = line.start + match.index;
      add("packMention", match[0], { start, end: start + match[0].length });
    }
  }
  return claims;
}

/** A "Serving Size" / "Servings Per Container" line with its value inline or on the next non-empty line. */
function labelClaim(
  lines: Line[],
  index: number,
  add: (field: Field, value: string, span: { start: number; end: number }) => void,
): void {
  const line = lines[index];
  const label = line ? LABEL_LINE.exec(line.text) : null;
  if (!line || !label) {
    return;
  }
  const field: Field = /^serving size$/i.test(label[1] ?? "")
    ? "servingSize"
    : "servingsPerContainer";
  const found = labelValue(lines, { index, inline: (label[2] ?? "").trim() });
  // The next section's title is never turned into a quantity; unknown stays unknown.
  if (found && QUANTITY.test(found.value)) {
    add(field, found.value, { start: line.start, end: found.end });
  }
}

/** The value on the label's own line, else on the next non-empty line, with where its quote ends. */
function labelValue(lines: Line[], at: { index: number; inline: string }) {
  const line = lines[at.index];
  if (!line) {
    return null;
  }
  if (at.inline) {
    return { value: at.inline, end: line.start + line.text.length };
  }
  const next = lines.slice(at.index + 1).find((candidate) => candidate.text.trim());
  return next ? { value: next.text.trim(), end: next.start + next.text.length } : null;
}

function resolved(claims: PackagingClaim[], field: "servingSize" | "servingsPerContainer") {
  const selected = claims.filter((claim) => claim.field === field);
  const values = [...new Set(selected.map((claim) => words(claim.value)))];
  const status = values.length === 0 ? "unknown" : values.length === 1 ? "observed" : "conflict";
  return { status, value: values.length === 1 ? values[0] : null, claims: selected };
}

/** Loads the full page documents through the artifact resolver (hash-verified), with their original sources. */
export class PackagingEvidence {
  constructor(private readonly artifacts: Pick<ArtifactResolver, "resolve">) {}

  async inspect(owner: unknown, refs: unknown[], signal: AbortSignal): Promise<PackagingFacts> {
    const observation = ObservationSchema.parse(owner);
    if (!refs.length || refs.length > MAX_DOCUMENTS) {
      throw assemblyFailure("PACKAGING.SOURCE_LIMIT");
    }
    const documents = [];
    for (const raw of refs) {
      const ref = ArtifactRefSchema.parse(raw);
      assertArtifactBelongsTo(ref, observation);
      const resolvedDocument = await this.artifacts.resolve(ref, observation, signal);
      const document = TextDocumentSchema.parse(decodeJson(resolvedDocument.bytes));
      if (document.producer !== ref.producer.module) {
        throw assemblyFailure("PACKAGING.SOURCE_IDENTITY_CONFLICT");
      }
      // The derived text is not enough: its original source is reverified as well.
      await this.artifacts.resolve(document.source, observation, signal);
      documents.push({ ref, document });
    }
    return extractPackagingFacts(observation, documents);
  }
}
