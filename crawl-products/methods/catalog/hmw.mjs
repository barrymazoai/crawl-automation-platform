// Learned from retained HMW catalog DOM and its real grid-end observation (CRAWLV3-203).
const links = '#main-collection-product-grid a.full-unstyled-link[href*="/products/"]';

export async function prepare({ page, tab, sourceUrl }) {
  await tab.goto(sourceUrl);
  await page.waitForFunction(selector => Boolean(document.querySelector(selector)), links, { timeout: 10_000 });
  const observed = await page.evaluate(selector => ({
    cards: document.querySelectorAll(selector).length,
    // This collection count lives inside the filter drawer; body.innerText omits it.
    countText: document.querySelector(".mobile-facets__count")?.textContent.trim() ?? null,
  }), links);
  const count = /^(\d+)\s+products$/.exec(observed.countText ?? "");
  if (!count || Number(count[1]) !== observed.cards) throw new Error("observed_hmw_catalog_structure_changed");
  return {
    seedUrls: [sourceUrl],
    listingOptions: {
      productLinkSelectors: [links], paginationActions: [], scrollListings: false,
      listingProfile: { productLinkSelectors: [links], paginationActions: [], scrollListings: false },
      listingCoverage: [{ url: sourceUrl, paginationMode: "none", verifiedVisually: true }],
      completionProof: "enumeration", extraRoundsAfterConverge: 1,
      maxRounds: 3, maxPagesPerSeed: 1, maxItems: 10000,
    },
    oracle: { expected: Number(count[1]), comparable: true, basis: "same collection .mobile-facets__count" },
    observation: observed,
  };
}

export function projectPage({ document, url }) {
  return [...document.querySelectorAll(links)].map(anchor => {
    const title = anchor.querySelector(".card-information__text")?.textContent.trim();
    const brand = anchor.querySelector(".card-information__vendor")?.textContent.trim();
    if (!title || !brand) throw new Error("hmw_catalog_card_identity_changed");
    return { url: new URL(anchor.getAttribute("href"), url).href, title, brand };
  });
}
