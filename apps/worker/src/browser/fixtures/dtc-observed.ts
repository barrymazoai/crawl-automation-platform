import { sha256 } from "@crawl-automation/platform";

/** Synthetic exact website field locations, matching the native provenance protocol. */
export function observedProductFixture(input: {
  url: string;
  image: string;
  variants: { variantId: string; url: string }[];
}) {
  const fields = {
    title: "Sleep",
    brand: "Beta",
    currency: "USD",
    ...(input.variants.length === 1 ? { price: "12.50" } : {}),
  };
  const website = JSON.stringify({ fields, variants: input.variants });
  const fieldEvidence = observedMethod(input, { fields, website });
  return {
    "website.json": website,
    "evidence/records.json": JSON.stringify([
      {
        productUrl: input.url,
        fields,
        variants: input.variants,
        fieldEvidence,
        pageHtml: "product.html",
        gallery: [{ url: input.image, localPath: "front.png", mime: "image/png" }],
        flags: [],
      },
    ]),
  };
}

function observedMethod(
  input: Parameters<typeof observedProductFixture>[0],
  at: {
    fields: Record<string, string>;
    website: string;
  },
) {
  const { fields, website } = at;
  return {
    codec: "observed-product/1",
    productUrl: input.url,
    sources: [
      {
        path: "website.json",
        url: `${input.url}.json`,
        kind: "json",
        sha256: sha256(Buffer.from(website)),
      },
    ],
    fields: Object.fromEntries(
      Object.keys(fields).map((name) => [name, { source: 0, pointer: `/fields/${name}` }]),
    ),
    variantMappings: input.variants.map((variant, index) =>
      Object.fromEntries(
        Object.keys(variant).map((name) => [
          name,
          { source: 0, pointer: `/variants/${index}/${name}` },
        ]),
      ),
    ),
  };
}

export function catalogDiscoveryFixture(
  pages: { htmlPath: string; screenshotPath: string; entries: { url: string }[] }[],
) {
  const productUrls = pages.flatMap((page) => page.entries.map((entry) => entry.url));
  return {
    codec: "catalog-discovery/1",
    complete: true,
    zeroGrowthRounds: 1,
    productUrls,
    pages: [1, 2].flatMap((round) =>
      pages.map((page) => ({
        round,
        htmlPath: page.htmlPath,
        screenshotPath: page.screenshotPath,
      })),
    ),
    rounds: [1, 2].map((round) => ({
      round,
      growth: round === 1 ? productUrls.length : 0,
      coverageComplete: true,
      productUrls,
    })),
  };
}
