// Learned from CRAWLV3-200 retained pages. No catalog counts or product values are cached.
const links = ".product-item a.h7";
const next = '#pagination .next-page:not([class~="!pointer-events-none"])';

export async function prepare({ page, tab, sourceUrl }) {
  await tab.goto(sourceUrl);
  await page.waitForFunction(() => Boolean(document.querySelector(".product-item a.h7"))
    && /^\d+ of \d+ products$/.test(document.querySelector('span[x-text="count_products"]')?.textContent.trim() ?? ""),
  undefined, { timeout: 10_000 });
  const observed = await page.evaluate(() => {
    const totals = [...document.querySelectorAll('span[x-text="count_products"]')]
      .map(node => node.textContent.trim());
    const control = document.querySelector("#pagination nav[data-actual-page]");
    return { totals, pagination: control?.outerHTML ?? null,
      cards: document.querySelectorAll(".product-item a.h7").length };
  });
  const counts = observed.totals.map(value => /^(\d+) of (\d+) products$/.exec(value));
  if (!observed.cards || !counts.length || counts.some(value => !value)
    || new Set(counts.map(value => value[2])).size !== 1
    || (!observed.pagination && Number(counts[0][2]) !== observed.cards)) {
    throw new Error("observed_catalog_structure_changed");
  }
  const paginationMode = observed.pagination ? "click" : "none";
  const paginationActions = observed.pagination ? [{ action: "click", selector: next }] : [];
  return {
    seedUrls: [sourceUrl],
    listingOptions: {
      productLinkSelectors: [links], paginationActions, scrollListings: false,
      listingProfile: { productLinkSelectors: [links], paginationActions, scrollListings: false },
      listingCoverage: [{ url: sourceUrl, paginationMode, verifiedVisually: true }],
      completionProof: "enumeration", extraRoundsAfterConverge: 1,
      maxRounds: 4, maxPagesPerSeed: 100, maxItems: 10000,
    },
    oracle: { expected: Number(counts[0][2]), comparable: true,
      basis: 'same rendered collection span[x-text="count_products"]' },
    observation: observed,
  };
}

export function projectPage({ document, url, sourceUrl }) {
  // This verified single-brand storefront prints its identity in its Corporation JSON-LD.
  const identities = [...document.querySelectorAll('script[type="application/ld+json"]')]
    .map(node => JSON.parse(node.textContent)).filter(value => value["@type"] === "Corporation"
      && new URL(value.url).origin === new URL(sourceUrl).origin);
  if (identities.length !== 1 || !identities[0].name?.trim()) throw new Error("catalog_identity_changed");
  return [...document.querySelectorAll(links)].map(anchor => ({
    url: new URL(anchor.getAttribute("href"), url).href,
    title: anchor.textContent.trim(), brand: identities[0].name,
  }));
}
