import { assessLabelCandidate, labelImageIntegrityFindings, LabelImageCandidateSchema } from "@crawl-automation/v3-contracts";

/** One line per Review, readable without opening R2: which stage, which rule, and where it fired. */
export type ReasonItem = { stage: string; code: string; detail?: string };
export type QueueReason = { summary: string; items: ReasonItem[] };
type Record_ = { failure?: { stage?: unknown; code?: unknown; evidenceKey?: unknown }; rawError?: { details?: unknown };
  candidate?: { value?: unknown } | null; inspection?: { input?: { file?: { objectKey?: unknown } } } };

const text = (v: unknown, n = 160) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : undefined;
const imageOf = (key: unknown) => typeof key === "string" ? key.match(/\/(chp-[0-9a-f]{8})/)?.[1] : undefined;

function detailOf(r: Record_): string | undefined {
  const stage = String(r.failure?.stage ?? ""), details = r.rawError?.details as Record<string, unknown> | undefined;
  if (stage === "amazon.browser" || stage === "amazon.file") {
    const facts = details?.causeDetails && typeof details.causeDetails === "object" ? Object.entries(details.causeDetails as object).map(([k, v]) => `${k}=${v}`).join(" ") : "";
    return [text(details?.causeCode, 80), facts].filter(Boolean).join(" ") || undefined;
  }
  if (stage === "product.label.assembly") {
    // The product-level decision. Its candidate is the merge output, which keeps every image's extraction, so the
    // exact failing rows can be recomputed here without changing what the assembly writes.
    const provenance = ((r.candidate?.value as { result?: { provenance?: unknown[] } } | undefined)?.result?.provenance ?? []) as { id?: string; kind?: string; candidate?: unknown }[];
    const lines: string[] = [];
    for (const p of provenance) {
      if (p.kind !== "image") continue;
      const parsed = LabelImageCandidateSchema.safeParse(p.candidate);
      if (!parsed.success) continue;
      const found = [...labelImageIntegrityFindings(parsed.data), ...assessLabelCandidate(parsed.data).findings].filter(f => f.code !== "LABEL.CORE_MISSING");
      if (found.length) lines.push(`${p.id}: ${found.slice(0, 2).map(f => `${f.code} ${f.detail}`).join("; ")}`);
      // A clean but partial image explains a label split across images: one holds the formula, another the ingredients.
      else if (parsed.data.formula || parsed.data.otherIngredients)
        lines.push(`${p.id}: clean but partial (${parsed.data.formula ? "formula" : "no formula"}, ${parsed.data.otherIngredients ? "Other Ingredients" : "no Other Ingredients"}); no single image is complete`);
    }
    const codes = ((r.rawError?.details as { codes?: unknown } | undefined)?.codes ?? []) as string[];
    return [codes.length ? `codes ${codes.join(",")}` : "", ...lines.slice(0, 3)].filter(Boolean).join(" | ") || undefined;
  }
  if (stage === "channel.label-input") {
    // Which step stopped preparation: the manifest's own code, and any source whose state never resolved.
    const failures = ((details?.failures ?? []) as { sourceId?: string; code?: string }[]).map(f => `${f.sourceId}: ${f.code}`);
    const states = (details?.states ?? []) as { id?: string; status?: string }[];
    const unresolved = states.filter(s => s.status === "unresolved" || s.status === "rejected").map(s => `${s.id} ${s.status}`);
    return [...failures, ...(unresolved.length ? [`unresolved sources: ${unresolved.slice(0, 6).join(", ")}`] : [])].join("; ") || undefined;
  }
  if (stage === "ocr.file") return imageOf(r.inspection?.input?.file?.objectKey) ? `image ${imageOf(r.inspection?.input?.file?.objectKey)} has no text` : undefined;
  if (stage === "codex.vision") {
    const parsed = LabelImageCandidateSchema.safeParse(r.candidate?.value);
    if (!parsed.success) return undefined;
    // Recompute with the same rules that rejected it; the model's own explanation follows when it gave one.
    const findings = [...labelImageIntegrityFindings(parsed.data), ...assessLabelCandidate(parsed.data).findings];
    const own = parsed.data.issues.map(i => text((i as { detail?: unknown }).detail, 120)).filter(Boolean)[0];
    const shown = findings.slice(0, 2).map(f => `${f.code}: ${f.detail}`).join("; ");
    return [shown, own && !shown.includes(own) && `model: ${own}`].filter(Boolean).join(" | ") || undefined;
  }
  if (stage === "codex.text") {
    const raw = (r.candidate?.value as { rawResponse?: unknown } | undefined)?.rawResponse;
    try { const issue = JSON.parse(String(raw)).issues?.[0]; return issue ? `model: ${issue.code}${issue.detail ? ` ${text(issue.detail, 120)}` : ""}` : undefined; }
    catch { return undefined; }
  }
  return undefined;
}

/** Built at settlement from the product result and the request's Review records. Never throws: a reason that cannot be
 * built must not block settlement, so anything unexpected is summarised by code alone. */
export function queueReviewReason(product: { status?: unknown; code?: unknown } | undefined, records: readonly unknown[]): QueueReason {
  const items: ReasonItem[] = [];
  for (const raw of records.slice(0, 40)) {
    const r = raw as Record_;
    if (typeof r?.failure?.code !== "string") continue;
    let detail: string | undefined;
    try { detail = detailOf(r); } catch { detail = undefined; }
    items.push({ stage: String(r.failure.stage ?? "?"), code: r.failure.code, ...(detail ? { detail: detail.slice(0, 400) } : {}) });
  }
  // The product's own code decides; image-level Reviews explain it. Capture and label rule failures lead the summary.
  // A marketing image with no panel (VISION.LABEL_CORE_MISSING) is expected noise, so it goes last.
  const rank = (i: ReasonItem) => i.stage.startsWith("amazon.") ? 0 : i.stage === "product.label.assembly" || i.stage === "channel.label-input" ? 1 : i.code === "VISION.LABEL_CORE_MISSING" ? 5
    : i.stage === "codex.vision" ? 2 : i.stage === "ocr.file" ? 3 : 4;
  const ordered = [...items].sort((a, b) => rank(a) - rank(b));
  const decisive = items.find(i => i.stage === "product.label.assembly") ?? items.find(i => i.stage.startsWith("amazon."));
  const head = typeof product?.code === "string" ? product.code : decisive ? `${decisive.code} (product ${String(product?.status ?? "missing")})` : `product ${String(product?.status ?? "missing")}`;
  const lines = ordered.filter(i => i.detail).slice(0, 3).map(i => `${i.code} — ${i.detail}`);
  const codes = [...new Set(items.map(i => i.code))];
  const summary = [head, ...(lines.length ? lines : codes.length ? [codes.join(", ")] : [])].join(" | ").slice(0, 700);
  return { summary, items: ordered.slice(0, 12) };
}
