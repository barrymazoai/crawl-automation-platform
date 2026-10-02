/** Keep Undici's socket/connection cause; String(TypeError) alone only says "fetch failed". */
export function ocrStopCause(error: unknown): string {
  const chain: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current) && chain.length < 5) {
    seen.add(current);
    if (!(current instanceof Error)) {
      chain.push(String(current));
      break;
    }
    const code = "code" in current && typeof current.code === "string" ? ` [${current.code}]` : "";
    chain.push(`${current.name}: ${current.message}${code}`);
    current = current.cause;
  }
  return chain.join(" <- ");
}
