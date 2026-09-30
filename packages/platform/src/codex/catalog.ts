import { z } from "zod";
import { CodexModelSettingsSchema, type CodexModelSettings } from "@crawl-automation/v3-contracts";
import type { CodexRpc } from "./codex-rpc.js";
import { codexFailure } from "./errors.js";

const token = z.string().min(1).max(200);
const model = z.object({
  id: token,
  model: CodexModelSettingsSchema.shape.model,
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: CodexModelSettingsSchema.shape.reasoningEffort }))
    .max(50),
  inputModalities: z.array(token).max(20),
});
const page = z.object({
  data: z.array(model).max(100),
  nextCursor: z.string().min(1).max(4096).nullable(),
});
type CatalogModel = z.infer<typeof model>;
export type CodexModality = "text" | "image";

function findMatch(entries: CatalogModel[], name: string, previous?: CatalogModel) {
  let match = previous;
  for (const entry of entries) {
    // IDs, display names, upgrades and defaults are not replacements for the wire model name.
    if (entry.model === name) {
      if (match) {
        throw codexFailure("TEXT.CODEX_CATALOG_AMBIGUOUS", "not_executed");
      }
      match = entry;
    }
  }
  return match;
}

function assertCapabilities(
  match: CatalogModel | undefined,
  settings: CodexModelSettings,
  modalities: readonly CodexModality[],
): void {
  if (!match) {
    throw codexFailure("TEXT.CODEX_MODEL_UNAVAILABLE", "not_executed");
  }
  for (const modality of modalities) {
    if (!match.inputModalities.includes(modality)) {
      const code =
        modality === "text" ? "TEXT.CODEX_TEXT_UNSUPPORTED" : "TEXT.CODEX_IMAGE_UNSUPPORTED";
      throw codexFailure(code, "not_executed");
    }
  }
  if (
    !match.supportedReasoningEfforts.some(
      (option) => option.reasoningEffort === settings.reasoningEffort,
    )
  ) {
    throw codexFailure("TEXT.CODEX_EFFORT_UNSUPPORTED", "not_executed");
  }
}

export async function assertCatalog(
  rpc: Pick<CodexRpc, "request">,
  settings: CodexModelSettings,
  options: { signal: AbortSignal; modalities: readonly CodexModality[] },
): Promise<void> {
  let cursor: string | null = null;
  let match: CatalogModel | undefined;
  const cursors = new Set<string>();
  for (let count = 0; count < 20; count++) {
    options.signal.throwIfAborted();
    const result = page.parse(
      await rpc.request("model/list", { cursor, limit: 100, includeHidden: true }, options.signal),
    );
    match = findMatch(result.data, settings.model, match);
    if (result.nextCursor === null) {
      assertCapabilities(match, settings, options.modalities);
      options.signal.throwIfAborted();
      return;
    }
    if (cursors.has(result.nextCursor)) {
      throw codexFailure("TEXT.CODEX_CATALOG_CURSOR_LOOP", "not_executed");
    }
    cursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw codexFailure("TEXT.CODEX_CATALOG_LIMIT", "not_executed");
}
