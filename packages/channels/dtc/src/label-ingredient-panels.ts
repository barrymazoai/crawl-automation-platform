export const INGREDIENT_HEADING = /^(?:(?:plant[- ]based|other)\s+)?ingredients\s*:?$/i;

/** Owner 2026-10-24 (dherbs.com): a named accordion header can control its ingredient body as a sibling. */
export function ingredientChromePanels(root: Element): Set<Element> {
  const headings = root.querySelectorAll("h2, h3, h4, summary, [role='tab']");
  return new Set([...headings].flatMap((heading) => ingredientChromePanel(heading, root)));
}

function ingredientChromePanel(heading: Element, root: Element): Element[] {
  if (
    !INGREDIENT_HEADING.test(heading.textContent?.trim() ?? "") ||
    heading.closest('[class*="faq"]')
  ) {
    return [];
  }
  const header = ingredientChromeHeader(heading);
  const body = header.matches("details") ? header : ingredientChromeBody(heading, header, root);
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

function ingredientChromeBody(heading: Element, header: Element, root: Element): Element | null {
  const control = heading.querySelector("[aria-controls], [data-bs-target]") ?? heading;
  const targetId =
    control.getAttribute("aria-controls") ?? control.getAttribute("data-bs-target")?.slice(1);
  const linked =
    targetId && /^[\w-]+$/.test(targetId) ? root.ownerDocument.getElementById(targetId) : null;
  return linked ?? heading.nextElementSibling ?? header.nextElementSibling;
}
