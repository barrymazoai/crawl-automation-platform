export { sameServingSize } from "@crawl-automation/v3-contracts";

/** A bare number ("1") names no unit, so it is no serving size (GNC's attribute table). */
export const UNITLESS = /^\s*\d+(?:[.,]\d+)?\s*$/u;
