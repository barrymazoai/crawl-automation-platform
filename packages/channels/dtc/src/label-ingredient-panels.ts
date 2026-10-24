export const INGREDIENT_HEADING = /^(?:(?:plant[- ]based|other)\s+)?ingredients\s*:?$/i;

/** A named accordion header can control its ingredient body as a sibling; false retains /3 ID lookup. */
export function ingredientChromePanels(root: Element, scopedIds = false): Set<Element> {
  const headings = root.querySelectorAll("h2, h3, h4, summary, [role='tab']");
  return new Set(
    [...headings].flatMap((heading) => ingredientChromePanel(heading, root, scopedIds)),
  );
}

function ingredientChromePanel(heading: Element, root: Element, scopedIds: boolean): Element[] {
  if (
    !INGREDIENT_HEADING.test(heading.textContent?.trim() ?? "") ||
    heading.closest('[class*="faq"]')
  ) {
    return [];
  }
  const header = ingredientChromeHeader(heading);
  const body = header.matches("details")
    ? header
    : ingredientChromeBody(heading, header, { root, scopedIds });
  return ingredientChromeBounded(body, header) ? [header, body] : [];
}

function ingredientChromeHeader(heading: Element): Element {
  const details = heading.matches("summary") ? heading.parentElement : null;
  return details?.matches("details") ? details : (heading.closest(".accordion-item") ?? heading);
}

function ingredientChromeBounded(body: Element | null, header: Element): body is Element {
  const tablist = header.closest("[role='tablist']");
  return (
    !!body?.matches("section, article, details, div, ul, p, [role='tabpanel']") &&
    ingredientBodyText(body, header) &&
    (body.parentElement === header.parentElement ||
      header.contains(body) ||
      (body.matches("[role='tabpanel']") && tablist?.parentElement === body.parentElement))
  );
}

function ingredientBodyText(body: Element, header: Element): boolean {
  if (body !== header || !header.matches("details")) {
    return !!body.textContent?.trim();
  }
  return [...header.children].some(
    (child) => !child.matches("summary") && !!child.textContent?.trim(),
  );
}

function followsHeading(heading: Element, candidate: Element, root: Element): boolean {
  for (let node: Element | null = heading; node && node !== root; node = node.parentElement) {
    for (let next = node.nextElementSibling; next; next = next.nextElementSibling) {
      if (next === candidate || next.contains(candidate)) {
        return true;
      }
    }
  }
  return false;
}

function ingredientChromeBody(
  heading: Element,
  header: Element,
  options: { root: Element; scopedIds: boolean },
): Element | null {
  const control = heading.querySelector("[aria-controls], [data-bs-target]") ?? heading;
  const targetId =
    control.getAttribute("aria-controls") ?? control.getAttribute("data-bs-target")?.slice(1);
  let linked: Element | null = null;
  if (targetId && /^[\w-]+$/.test(targetId)) {
    linked = options.scopedIds
      ? ([...options.root.querySelectorAll(`[id="${targetId}"]`)].find(
          (candidate) =>
            followsHeading(heading, candidate, options.root) &&
            ingredientChromeBounded(candidate, header),
        ) ?? null)
      : options.root.ownerDocument.getElementById(targetId);
  }
  return linked ?? heading.nextElementSibling ?? header.nextElementSibling;
}
