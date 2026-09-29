/**
 * Deep equality for plain JSON values inside the workflow bundle (no Node built-ins there). Key order counts, as
 * with the stored JSON these values come from.
 */
export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
