# Amazon product adapter (R17)

`@crawl-automation/channel-amazon` implements `ChannelAdapter` for Amazon US product pages.
The adapter is not registered in the worker or API yet. It performs no network or model calls.

R18 adds the search/brand-page `BrandScanReader`, application queue bridge and migration.
See [brand scan implementation and integration notes](BRAND_SCAN.md).

## Files

- `package.json`, `tsconfig.json`: workspace package and strict TypeScript configuration.
- `src/index.ts`, `src/adapter.ts`: exports, HTTP policy, identity and planning hooks.
- `src/address.ts`, `src/dom.ts`, `src/errors.ts`: US URL normalization, static DOM and registered errors.
- `src/product.ts`, `src/commerce.ts`, `src/images.ts`: evidence, metrics and selected gallery.
- `src/script-data.ts`, `src/family.ts`: embedded literal data and all variation dimensions/ASINs.
- `src/facts.ts`: bounded ingredient sections and conservative facts completeness.
- `src/{address,product,facts,family,edge-cases,pipeline}.test.ts`: offline tests.
- `src/testing/saved-pages.ts`: external saved-page loader; no HTML or compressed data added here.

The HTML parser is [LinkeDOM](https://github.com/WebReflection/linkedom), backed by htmlparser2,
as already used by Swanson. [Acorn](https://github.com/acornjs/acorn) and its walker parse the
embedded gallery/twister JavaScript into syntax trees. Only selected literal values are decoded;
scripts and `A.$.parseJSON` are never executed. Shared `pageText` handles text conversion.

## Observed saved pages

Prices are USD; family counts include the selected ASIN. Each identity equals the ASIN in the
file name. Full titles and exact expected values are asserted in `product.test.ts`.

| Saved page                         | Product / brand            | Price / list  | Rating / reviews | Availability          | Images | Family                                | Facts                                       |
| ---------------------------------- | -------------------------- | ------------- | ---------------- | --------------------- | ------ | ------------------------------------- | ------------------------------------------- |
| `amazon-static-B0013LAQS6.html.gz` | Nature's Bounty Fish Oil   | 10.45 / 14.09 | 4.8 / 6,320      | In Stock              | 6      | 7; flavour + size/pack                | Ingredients only; incomplete                |
| `amazon-static-B0G963NB8Q.html.gz` | Horbäach Collagen Peptides | 9.99 / —      | 4.4 / 19         | In Stock              | 7      | None observed                         | Ingredients + Other Ingredients; incomplete |
| `B0013LAQS6.html`                  | Nature's Bounty Fish Oil   | 10.45 / 14.09 | 4.8 / 6,331      | In Stock              | 6      | 6; flavour + size/pack                | Ingredients only; incomplete                |
| `B0D1LQLV1P.html`                  | Best Naturals Manganese    | — / —         | 4.4 / 84         | Currently unavailable | 7      | None observed                         | Ingredients only; incomplete                |
| `B0GHZDFNP8.html`                  | Nature's Bounty B12        | 19.99 / 33.93 | 4.8 / 27,140     | In Stock              | 7      | 4; size/pack, constant Cherry flavour | Other Ingredients only; incomplete          |

All five originals lack complete text facts. Complete-text tests use explicitly identified,
in-memory mutations of the saved pages, not claimed real complete captures. The shared planner
then produces one required page source and no images. Incomplete originals retain every image.
Ingredients, disclaimers and directions are separated by DOM headings, not fixed-length slices.
Serving weight or Other Ingredients amounts alone cannot satisfy the active-amount requirement.

## Tests and data

By default tests read the two existing files in `packages/v3-channels/src/fixtures/` and three
HTML files in `docs/quality/evidence/2026-09-23-amazon-html-loading/`. Set `V3_TEST_DATA_DIR` to
an external directory containing either their basenames or the same relative directory layout.
An explicit override disables repository fallback. Missing files use `describe.skipIf` with a
message naming the missing file and the environment variable; `--reporter verbose` shows it.
R45 can move these originals to R2 without putting test data in this package.

Verification commands (repository root except TypeScript):

```sh
cd packages/channels/amazon
../../../node_modules/.bin/tsc --noEmit
```

```sh
npx --no-install vitest run --config vitest.v3.config.ts packages/channels/amazon
npx --no-install eslint packages/channels/amazon
npx --no-install jscpd packages/channels --config .jscpd.json
```

The pipeline tests use fake provider responses and in-memory publication, including 404/410,
same-ASIN redirects, other-ASIN redirects, redirects away, identity conflicts, archive replay and
per-channel ScraperAPI option forwarding. No browser/provider integration or paid run was made.

Verified locally: TypeScript and ESLint pass; Vitest passes 94 tests in six files; jscpd reports
zero clones across `packages/channels` (82 source files). With an intentionally missing data
directory, 19 independent tests pass and 75 saved-page tests skip. All TypeScript source lines
are within 100 characters. No install, commit, branch or external file edit was performed.

## Integration changes still needed

Add this import to each composition root below:

```ts
import { amazonAdapter } from "@crawl-automation/channel-amazon";
```

The two registry lines (current workspace locations):

```ts
// apps/worker/src/container.ts
registry: asValue(new ChannelRegistry([swansonAdapter, gncAdapter, amazonAdapter])),
// apps/api/src/resources/channel-registry.ts (re-exported by queue-parts.ts)
return new ChannelRegistry([swansonAdapter, gncAdapter, amazonAdapter]);
```

Add `"@crawl-automation/channel-amazon": "workspace:*"` to the dependencies of both
`apps/worker/package.json` and `apps/api/package.json`, then run `pnpm install` to update the
lockfile and workspace links. The workspace glob already includes the new package; no root
package change or dependency-cruiser baseline exception is needed. None of these external
files were edited for R17. Validation reused already installed dependencies through ignored
links under this package's `node_modules`; `pnpm install` was not run.

HTTP policy is the original Amazon bound (6 MiB, 75 seconds), shaped like GNC's policy.
Render/premium/country choices remain in `ScraperApiCaptureSettings.channels.amazon`; platform
defaults are `render: false`, `premium: false`, `countryCode: "us"`. Do not add provider options
to `HttpPolicy`, which does not define them. Ensure Amazon's origin is allowed in deployment
settings when wiring it up. No Store scanner registration is included.

## Legacy behavior intentionally not copied

- HTTP transport, paid-fetch admission, archive publication and unlisted classification belong
  to core/platform. Core supplies `not_found`, `redirected_to_other_product`, `redirected_away`
  and `identity_conflict`. The old `/clp/<ASIN>` redirect override and dog-page guesses are not
  a second channel-specific unlisting policy.
- Ego/VM execution, opening image modals, Store/brand discovery, browser control and postal-code
  delivery changes are outside this HTTP-only product ticket.
- Purchase-condition/seller parsing, sales badges, sales rank, first-available dates, manufacturer,
  item form/unit count and A+ enrichment are outside the requested fields. Availability is the
  observed text in `commerce.availability`; no stock boolean is invented.
- Ingredient tokenization/normalization and image/OCR/model label extraction belong downstream.
  Facts-image guessing from unrelated page content is not used; all selected gallery images remain.
- Whole-page price/rating/image regex fallbacks and fixed-length ingredient slices are replaced
  with selected-product DOM/data scopes. Twister reads all dimension labels; it does not discard
  flavour labels or assert complete catalog enumeration. DOM-only variation links without a
  selected-ASIN twister map do not establish a family for formula reuse.
- The new hook stores `ChannelProductEvidence` projections like GNC. Legacy browser/VM
  `AmazonRenderedProduct` projection objects are not accepted by this hook; historical originals
  must be reparsed through the adapter. No historical evidence or Review was changed.

The US host restriction is intentional: `www`, bare, `m`, and `smile.amazon.com` product URLs
normalize to `https://www.amazon.com/dp/<ASIN>`. Other marketplaces are not silently mapped to US.
