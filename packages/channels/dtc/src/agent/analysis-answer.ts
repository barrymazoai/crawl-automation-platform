/** Mechanical slips in the agent's site-analysis answer, read as what they name. */

/**
 * Saved files are named relative to the capture directory. The agent sometimes prefixes that directory itself
 * ("capture/entry-01.html", arigoy.com 2026-10-28); the prefix names the same file.
 */
export function capturePath(path: string): string {
  return path.startsWith("capture/") ? path.slice("capture/".length) : path;
}

/** The agent sometimes nests its whole verification under method (reachsupps.com 2026-10-28); its method is kept. */
export function methodText(method: unknown): unknown {
  return method && typeof method === "object" ? (method as { method?: unknown }).method : method;
}

/**
 * The agent sometimes writes a reason as an object ({code, message, …}; bloodsugarfriendly.com 2026-10-20, an Ego
 * screenshot timeout) instead of a sentence. Its words are kept as text, so the answer is not lost as unreadable.
 */
export function withTextReasons(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { reasons?: unknown }).reasons)) {
    return raw;
  }
  return { ...raw, reasons: (raw as { reasons: unknown[] }).reasons.map(reasonText) };
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") {
    return reason;
  }
  const { code, message } = (reason ?? {}) as { code?: unknown; message?: unknown };
  if (typeof message === "string") {
    return typeof code === "string" ? `${code}: ${message}` : message;
  }
  return JSON.stringify(reason);
}
