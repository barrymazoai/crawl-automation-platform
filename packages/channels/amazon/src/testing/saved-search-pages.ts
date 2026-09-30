import { parseHTML } from "linkedom";
import { savedPage } from "./saved-pages.js";

const directory = "docs/quality/evidence/2026-09-23-brand-scraperapi-check";
export const filteredSearch = savedPage(`${directory}/02-filtered.original.html`);
export const unfilteredSearch = savedPage(`${directory}/01-search.original.html`);
export const FILTERED_SEARCH_URL =
  "https://www.amazon.com/s?k=Herb+Pharm&i=hpc&rh=n%3A3760901%2Cp_123%3A383950&dc=";

/** Boundary cases are explicitly in-memory mutations of a real retained page, never new fixtures. */
export function searchDocument() {
  return parseHTML(filteredSearch.read().html).document;
}

export function pagedSearch(input: { page: number; empty?: boolean; last?: boolean }) {
  const document = searchDocument();
  const selected = document.querySelector(".s-pagination-selected");
  selected?.replaceChildren(String(input.page));
  const next = document.querySelector("a.s-pagination-next");
  next?.setAttribute("href", `${FILTERED_SEARCH_URL}&page=${input.page + 1}`);
  if (input.last) {
    next?.remove();
  }
  if (input.empty) {
    document.querySelector("div.s-main-slot")?.replaceChildren();
  }
  return document.toString();
}
