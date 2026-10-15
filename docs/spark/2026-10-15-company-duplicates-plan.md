# Marketplace brand companies: fix duplicates, prevent new ones (2026-10-15)

Owner: "都可以，先写计划给我看". Follows [marketplace brand companies](2026-10-15-marketplace-brand-companies-plan.md).

## What went wrong

The identity rule asks Supply Smart which company owns the found website's domain (`company.resolve` by domain:
website / subdomains / brand_of). Found: link only. Not found: create. It never looks by name, so an existing
company was missed when it has no website (melting forest, mars men), is stored under another site of the same
business (brand site vs owner site: Trident Seafoods ↔ purealaskaomega.com, Bach ↔ bachflower.com vs nelsons.com),
or a different spelling or regional subdomain (yumvs.com vs yum-vs.com, myprotein.com vs us.myprotein.com).
Before cf7d267 a company was also named after the brand while its website was the owner's.

Read-only comparison of the 166 created companies with the 4,962 in Supply Smart TEST: 12 likely duplicates,
1 unsure (Vital Source), 10 look-alikes that are different businesses, 2 to rename.

## A. One-time corrections (Supply Smart TEST)

| Action | Ours (source) | Existing (survivor) |
|---|---|---|
| merge | Pure Alaska Omega | Trident Seafoods Corporation |
| merge | Bach Original Flower Remedies | Bach |
| merge | Myprotein | MyProtein The Hut Group |
| merge | YumVs | Teelah Corp |
| merge | Melting Forest | melting forest |
| merge | Mars Men | mars men |
| merge | Mutant | FIT FOODS DISTRIBUTION INC. |
| merge | Atrantil | KBS Research, Inc. |
| merge | BioSil | Bio Minerals NV |
| merge | Wisdom Natural | Wisdom Of The Ancients |
| merge | Redmond Trading Company | REDMOND |
| merge | Sylvan | Sylvan Bioproducts, Inc. |
| rename | Kirkland Signature → Costco | — |
| rename | Barbara's Bakery → Post Consumer Brands | — |

Vital Source stays until a person checks it.

- Supply Smart already has both operations (read from its contracts, not changed): `company.update` and
  `company.mergeCompany(survivorId, sourceIds)`. The merge moves products and contacts, carries domains and the
  other company references, keeps the source's domain as a former domain of the survivor (so the next lookup of
  that domain finds the survivor) and deletes the source.
- Crawler API (engineering rule: operations go through our API): `brandEnrichment.renameCompany({companyId, name})`
  and `brandEnrichment.mergeCompany({survivorId, sourceId})`. The merge also repoints our own records from the source
  to the survivor (brand ↔ company matches used by the product sync, and the run's company), so the next sync sends
  under the survivor. Both are owner-approved corrections only; nothing calls them automatically.
- Order: rename Kirkland first (harmless; proves the service key may call `company.update`), then merge one small
  pair (Melting Forest, 1 + 1 products) and check Supply Smart TEST read-only, then the other 11.
- If the service key may not call these, the Supply Smart team grants it or the owner merges in Supply Smart's admin;
  our API then only repoints our records.

## B. Prevention (every run that would create a company)

In `BrandIdentityService`, before creating:

1. Regional subdomain: also look up the registrable domain (`us.myprotein.com` → `myprotein.com`). Library:
   `tldts` (Public Suffix List; its private section keeps `x.myshopify.com` / `x.wordpress.com` as separate sites).
2. Look-alikes: Supply Smart `company.resolve` by name and `company.search` with the brand name (and the owner name
   on the owner route). A candidate is a company with the same normalized name, a word-prefix name (≥ 4 letters),
   the same domain ignoring `www`/hyphens, or a domain that contains the brand name (≥ 5 letters). Shared hosting
   roots (myshopify, wordpress, …) never count.
3. No candidate: create as today. Candidates: do not create; the run waits for a person with one question listing
   the candidates (existing question mechanism). Answer "same as X": link to X and add our domain to X
   (`company.addDomains`), so the next lookup finds it. Answer "new": create. The brand keeps waiting meanwhile.

Validation before deploy: replay the rule over today's 166 created companies — it must flag the 12 above and report
how many others it would have held. No new unit tests beyond the existing suite (check + existing tests).

## Deploy

Server 一 (API + brand-enrichment worker). The owner runs the deploy command; no migration.
