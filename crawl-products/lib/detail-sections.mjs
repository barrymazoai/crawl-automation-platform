import { parseHTML } from "linkedom";

/** Keep each heading attached to its own DOM body; never pair adjacent accordions. */
export function detailSections(html, toText) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll("script,style,template,noscript,svg")) node.remove();
  const sections = [];
  const add = (heading, body) => {
    const label = toText(heading?.innerHTML || "").trim();
    const value = toText(body || "").trim();
    if (label && value) sections.push({ label, value });
  };
  for (const details of document.querySelectorAll("details")) {
    const summary = [...details.children].find(node => node.localName === "summary");
    if (!summary) continue;
    const body = details.cloneNode(true);
    for (const node of body.querySelectorAll("summary,details")) node.remove();
    add(summary, body.innerHTML);
  }
  // ARIA links explicitly name the controlled panel, including panels outside the button's parent.
  for (const heading of document.querySelectorAll("button[aria-controls],[role=tab][aria-controls]")) {
    if (heading.closest("details")) continue;
    const ids = heading.getAttribute("aria-controls").trim().split(/\s+/);
    if (ids.length !== 1) continue;
    const panel = document.getElementById(ids[0]);
    if (panel && !panel.contains(heading)) add(heading, panel.innerHTML);
  }
  for (const row of document.querySelectorAll(".traits__item,.accordion-item,.product__accordion")) {
    if (row.querySelector("details")) continue;
    const heading = row.querySelector(".traits__label,.accordion__title,.accordion-button,button,h2,h3,h4");
    const body = row.querySelector(".traits__values,.accordion-body,.accordion__content,[role=tabpanel]");
    if (heading && body && !body.contains(heading)) add(heading, body.innerHTML);
  }
  // Plain heading + adjacent body: stop at a new section or heading, not at the next matching keyword.
  for (const heading of document.querySelectorAll("h2,h3,h4")) {
    if (heading.closest("details,button,summary,[role=tab]")) continue;
    const parts = [];
    for (let next = heading.nextElementSibling; next; next = next.nextElementSibling) {
      if (next.matches("h1,h2,h3,h4,h5,h6,section,article,details,button")
        || next.querySelector("h1,h2,h3,h4,h5,h6,summary,[role=tab]")) break;
      parts.push(next.outerHTML);
    }
    add(heading, parts.join("\n"));
  }
  return sections;
}

export function factsHeading(label) {
  return /^(?:supplement facts?|nutrition(?:al)? (?:facts?|information)|active ingredients?)\s*:?$/i.test(label.trim());
}
