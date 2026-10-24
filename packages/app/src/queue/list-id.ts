import { createHash } from "node:crypto";

/** A UUID-shaped queue list ID from text, so asking again with the same text names the same list. */
export function listIdFrom(text: string): string {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
