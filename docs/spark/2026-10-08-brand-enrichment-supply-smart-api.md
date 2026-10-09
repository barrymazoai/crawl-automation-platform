# Brand enrichment: Supply Smart APIs the crawler needs

> **For:** the Claude Code session working in `supply-smart-mono` (jakarta).
> **From:** Crawler V3 (`browser-scaperskill`). Revision 3, 2026-10-09. Revision 4 (jakarta, 2026-10-09):
> checked against `dev`; links carry only `source` and `confidence`; `company/link` moves a borrowed Apollo
> organization up to the owner; enrich never creates a hidden company; `enrich` output needs no change.
> **Pipeline:** https://claude.ai/artifact/9Br79dEuhYxtExrrsB4nPZ
>
> **Rule (owner, 2026-10-08):** the crawler reads, searches, writes and saves Supply Smart data **only through
> the API**. It never holds a database URL. Everything the old scripts did directly in the database
> (`import-brand-companies.ts`: categories, relationships, contact positions) needs an API procedure.

## Owner decisions this spec follows

1. **Supply Smart receives only final results (2026-10-09).** Clues, guesses and anything uncertain stay in
   Crawler V3's own database. Codex judges them there. Only a decided result is sent: "brand X belongs to
   company Y", "this Apollo organization is brand X", "this company has no owner". Supply Smart does **not** need
   candidate procedures, candidate table changes or a relationship review page for this pipeline.
2. **Codex decides.** A separate Codex reviewer in the crawler decides which clue is right. What it can't decide,
   and any merge of two companies, waits in the crawler for a person and is not sent until decided.
3. **Owners and sub-brands are normal, visible companies**, never hidden ones, created only once the link is
   decided. A new owner gets the profile and Apollo pass only, like a holding company; a product run only when
   its own site sells products.
4. **Super brands are in scope.** A request can be a group with sub-brands. Each sub-brand is created, linked to
   the group, and enriched like a single brand. At most 20 per request, nutrition only; sub-brands don't fan out further.
5. **Apollo matching is done by Codex**, up to three attempts, and only a match with a hard tie (domain, LinkedIn
   page, or legal name + address) is sent.
6. **A link records `source` and `confidence` only (2026-10-09).** That is enough to say how a relationship was
   found. The clues, the reason and who decided stay in the crawler. No new columns on `company_relationship`.
7. **One Apollo organization, one company row (2026-10-09).** A brand never holds its owner's organization id.
   Two cases, both handled by `company/link` (§2.3): the owner holds it already, so only the link is written and
   the brand gets no people of its own; or the brand took it first, so the link moves the organization id, the
   fields copied from it and the people up to the owner.

---

## 0. How the crawler calls you

| Target | Path | Auth |
|---|---|---|
| Brand requests (biz) | `POST {HOST}/api/rpc/brandEnrichment/<proc>` | Service API key in `x-api-key` |
| Product database | `POST {HOST}/api/database/rpc/<router>/<proc>` | The same Service API key |

oRPC, body `{"json": {...}}`, response `{"json": ...}`. Follow the existing service-key rule in
`lib/service-api-key.ts`: service keys skip the web whitelist and quota.

No gateway change is needed: `apps/biz-server/src/product-database-gateway.ts` (dev) lets a service key call any
product-database procedure. The procedure whitelist and the quota apply only to logged-in users.

---

## 1. Existing procedures the crawler will use (no change unless listed in §2)

| Stage | Procedure | Use |
|---|---|---|
| Intake | `brandEnrichment/serviceList`, `serviceUpdateStatus` | Pending requests; claim; complete / fail |
| Identity | `product/resolveCompany` | Domain → matched / unmatched / ambiguous / conflict |
| Identity, owners, sub-brands | `company/create` | A company we don't have (normal, visible) |
| Read | `company/getById`, `company/structure`, `company/search`, `company/quickSearch` | Current profile, family, domains |
| Products | `product/ingestObservationBatch`, `verifyObservationBatch`, `completeCrawlRun`, `ingestLabelObservation` | v2 product ingest |
| Profile + Apollo | `company/enrich` | Description, keywords, Apollo organization and people (extended in §2.1) |
| Merge | `company/mergeCompany` | Only after a person confirmed the merge in the crawler |
| Contacts | `contact/getByCompanyId` | Read contacts to classify |

---

## 2. New or changed procedures

Common rules for every write below:

- **Final results only.** Every write is a decided fact. Nothing is sent as "proposed".
- **Idempotent.** Calling twice with the same input changes nothing the second time and returns the same result.
- **Provenance.** Every written row records `source` (`'brand_enrichment'`), so a bad run can be found and
  undone by source. A link also records `confidence`. Who decided, the reason and the evidence stay in the crawler.
- **No guessing.** When a name or domain could mean more than one company, return `ambiguous` with the `matches`.
  The server never picks one.
- **Tests** against the real local database, like `label-observation.test.ts`, with synthetic rows that delete themselves.

### 2.1 `company/enrich`: changes

| Change | Why |
|---|---|
| Add `categories: string[]` | The old script wrote `company_to_category` directly. Values must be `company_category` names (`pharmacy`, `nutrition`, `food`, `beverage`, `beauty/personal care`); unknown → 400. Add-only: never removes existing categories. |
| Add `mode: "overwrite" \| "fill_empty"` (default `overwrite`, today's behaviour) | The crawler sends `fill_empty` so a curated description or keyword list on an existing company is never replaced. Response `updatedFields` / new `skippedFields` show what happened. |
| Add `source: string` and `evidence?: { url: string; observedAt: string }[]` | Where the description and keywords came from. Store on the company (for example `profile_source`, `profile_evidence` jsonb, `profile_updated_at`). |
| Add `apolloMatch?: { by: "domain" \| "former_domain" \| "linkedin" \| "name_address"; attempts: number; note?: string }` | How Codex tied the Apollo organization to the brand. Store next to `apollo_data`. Required when this pipeline sends `apolloOrganization`. |
| Add `unknownEmployer: "keep"` (default today: create a hidden company) | Today a person whose Apollo organization is held by nobody, and whose organization domain is live nowhere, gets a new hidden company (`is_visible = false`, `origin = apollo_employer`). No hidden companies: with `keep` the person stays on the target. The crawler also drops people of another organization before the call, so this is a safety net. |
| Output: **no change** | `apolloOrganizationHeldBy` (the company holding the Apollo id, else null) and `routed` (`{ companyId, created, inserted, skipped }[]`) already exist (SUPPLYSMAR-420). The crawler takes the holder as its `shared_apollo_org` clue and puts `routed` in the summary. |

### 2.2 `company/resolve` (new, read-only)

Turn a name, domain or Apollo id into a company, using the roadmap §3.5 order. Used before linking an owner or a
sub-brand (which may have no domain of its own), and to ask "who holds this Apollo organization id".

```jsonc
// input: at least one field
{ "name": "Natural Organics Inc.", "domain": "naturesplus.com", "apolloOrganizationId": "5f…" }

// output
{
  "status": "matched" | "unmatched" | "ambiguous",
  "companyId": "uuid | null",
  "matchedBy": "domain" | "former_domain" | "apollo_organization" | "legal_name" | null,
  "matches": [ { "companyId": "uuid", "name": "…", "matchedBy": "…" } ]   // only when ambiguous
}
```

Order: domain in `company_domain` (current, then former) → `apollo_organization_id` → normalized legal name
(strip Inc / LLC / Corp / Ltd / Co., punctuation, case). Use the shared normalizers in
`@supply-smart/product-db/domain`.

### 2.3 `company/link` (new, write)

Writes one **decided** ownership link to `company_relationship`. The crawler calls it only after its reviewer
(or a person) decided. The crawler creates the owner first with `company/create` when `company/resolve` says unmatched.

```jsonc
{
  "fromCompanyId": "uuid",                 // the brand / child
  "toCompanyId": "uuid",                   // the owner
  "kind": "brand_of" | "subsidiary_of",
  "source": "brand_enrichment",
  "confidence": 0.9                        // 0..1, the reviewer's; stored as the existing integer column allows
}
```

The reason, the evidence and who decided stay in the crawler (owner decision 6). `company_relationship` keeps its
columns: `source`, `confidence`.

| Case | Server does |
|---|---|
| Same link already there | No-op, return it |
| `from` already has an owner of the same kind | 409 with the existing owner. The crawler does not overwrite; it keeps the conflict for a person |
| Link would make a loop (A → B → A) | 400 |
| `from` holds an Apollo organization whose name or domain matches `to` (the brand took the owner's record first) | Move the organization id, the fields copied from it (`apollo_data`, address, phone, LinkedIn, …) and the people to `to`, clear them on `from`, then insert the link. Contact moves go through `contact_company_move` so they can be undone. The brand keeps its products. |
| `to` already holds the Apollo organization | Insert the link only. The brand gets no people; its page shows the owner's people (existing "People at the parent company" rule). |
| Otherwise | Insert with `source` and `confidence` |

Adding a link never moves products. It moves contacts only in the borrowed-organization case above. When `from` and
`to` look like one company under two names, the crawler does not call `link`; that is a merge, and a person decides.

Signals the crawler keeps on its side for the reviewer's record: `domain_redirect`, `website_our_brands`,
`group_filing`, `website_footer`, `web_search`, `apollo_parent`, `apollo_suborganization`, `shared_apollo_org`.

### 2.4 `company/unlink` (new, write)

Removes a link written by this pipeline when a person later finds it wrong: `{ fromCompanyId, toCompanyId, kind,
reason }`. Only rows with `source = 'brand_enrichment'`; other rows → 403. Keep a log row of the removal with the
reason. It does not move contacts back; a person decides that separately.

### 2.5 `company/recordOwnershipCheck` (new, write) and `company/ownershipStatus` (new, read)

The final answer to "does this company have an owner", so "independent" and "never checked" don't look the same.

```jsonc
// recordOwnershipCheck input
{ "companyId": "uuid", "result": "has_parent" | "independent", "signals": ["website_footer","web_search","apollo_parent"],
  "decidedBy": "codex:luna-medium", "note": "…", "source": "brand_enrichment" }

// ownershipStatus input { "companyId": "uuid" } → output
{ "latestCheck": { "checkedAt": "…", "result": "…", "signals": [] } | null,
  "owners": [ { "toCompanyId": "uuid", "kind": "brand_of", "source": "…" } ] }
```

`has_parent` requires a link (400 otherwise). Only final results: "unclear" stays in the crawler. The crawler reads
`ownershipStatus` before research to skip companies already checked.

### 2.6 `company/addDomains` (new, write)

The guide §7.2 `domains` input, which does not exist yet: today `create` / `update` take only `subdomains`, written
as current non-primary domains, and nothing marks a domain former or records a redirect through the API. Used when the browser shows the brand URL forwarding to
another domain of the **same** brand (old domain → former, new domain → current), or when the brand site lists its
own regional domains.

```jsonc
{ "companyId": "uuid", "source": "brand_enrichment",
  "domains": [ { "domain": "oldbrand.com", "status": "former" }, { "domain": "brand.co.uk", "status": "current" } ] }
```

Never sets primary (that stays with `create` / `update`). A domain that is current on another company is skipped
and reported (`conflicts: [{ domain, ownerCompanyId }]`), never moved.

### 2.7 Contact positions

**Reuse before classifying (owner, 2026-10-09).** Most titles ("Marketing Manager", "VP of Sales") were already
classified on other contacts. The crawler first asks Supply Smart how a title was classified before and reuses
that answer. Codex classifies only titles nobody has classified yet, or titles with conflicting answers.

| Procedure | Shape |
|---|---|
| `contact/positionTaxonomy` (new, read) | Returns the allowed function and level values from `contact-position-taxonomy.ts`, so the crawler doesn't copy them. |
| `contact/knownPositions` (new, read) | Input `{ titles: string[] }` (up to 500). Normalizes each title the same way on both sides (lowercase, trim, collapse spaces, strip punctuation) and looks at contacts whose function **and** level are filled. Returns the stored values as they are: `contact-position-taxonomy.ts` is for sorting only, about 130 contacts hold off-list variants such as `Director/Head`, and about 43 % of contacts have neither field. Output per title: `{ title, normalizedTitle, status: "known" \| "conflicting" \| "unknown", function, level, seenCount, share }`. `known` = one function + level pair holds at least 90 % of the classified contacts with that title (and `seenCount` ≥ 2); `conflicting` = classified, but no pair reaches 90 %; `unknown` = never classified. Index on the normalized title if the query is slow. |
| `contact/classifyPositions` (new, batch write) | `{ items: [ { contactId, function, level, method: "reused" \| "codex" } ] }`. Validates against the taxonomy; writes only contacts whose function and level are empty (never overwrites a classified row); skips `General Contacts(Default)`. Stores `method` so reused and model answers can be told apart. Returns per item `updated` / `skipped` with reason. |

Crawler order for a brand's new contacts: `knownPositions(titles)` → `known` titles are written with
`method: "reused"` → only `unknown` and `conflicting` titles go to Codex → written with `method: "codex"`.
The crawler also keeps the titles it classified in this run, so the same new title is sent to Codex once.

### 2.8 Super brands: how the crawler uses the procedures above

No new procedure; listed so the order is clear on your side.

| Shape | Crawler calls |
|---|---|
| Group with separate brand sites | For each sub-brand: `product/resolveCompany(domain)`, `company/create` if unmatched, `company/link(brand_of → group)`. Each sub-brand then gets the full single-brand run. |
| One site selling several brand lines | For each line: `company/resolve(name)`, `company/create` (no website) if unmatched, `company/link`. **Links are written before products are sent**, so the listing's `brandName` files each product under its sub-brand (existing family-brand rule). |
| Holding company without products | Group profile and Apollo only, then its sub-brands as in the first row. |
| Owner found by the reviewer, not in Supply Smart | `company/create` (visible), profile and Apollo only, `company/link`, `recordOwnershipCheck`. A product run only when its own site sells products. |

### 2.9 `brandEnrichment/serviceUpdateStatus`: summary and group email

Add an optional `summary` (jsonb) on `completed` and `failed`, shown on the admin page:

```jsonc
{ "products": { "captured": 42, "review": 3 }, "profile": "filled" | "kept_existing" | "missing",
  "apollo": { "status": "matched" | "parent_only" | "no_match", "by": "domain", "attempts": 2 }, "contacts": 18,
  "ownership": "has_parent" | "independent" | "waiting_for_person",
  "family": { "shape": "single" | "separate_sites" | "shared_site" | "holding",
              "subBrands": [ { "name": "…", "companyId": "uuid", "status": "completed" | "failed" | "skipped_not_nutrition" | "over_limit" } ] } }
```

For a group, the completion email lists the sub-brands added (from `summary.family.subBrands`): one email per
request, not one per sub-brand. Sub-brands are not separate brand enrichment requests.

---

## 3. Order of work (suggested)

1. §2.1 (`enrich` changes): unblocks profile and Apollo.
2. §2.2 resolve, §2.3 link, §2.4 unlink.
3. §2.5 ownership check, §2.6 domains, §2.7 contact positions, §2.9 summary and email.

Each needs: migration via `db:generate` + `db:migrate` if a column is added, contract + router + service + DAO,
docs under `docs/packages/database-api/domains/companies.md` and `contacts.md`, and a real-database test.
Any database run (local / test / production) needs the owner's explicit confirmation, as in jakarta's `CLAUDE.md`.

## 4. Not asked for

- No candidate procedures and no change to `company_relationship_candidate`: clues stay in the crawler.
- No new columns on `company_relationship`: a link is `source` + `confidence`.
- No change to the `company/enrich` output: `apolloOrganizationHeldBy` and `routed` already exist.
- No relationship review page in Supply Smart for this pipeline.
- No direct database access for the crawler, and no new database credentials.
- No hidden companies: owners and sub-brands are normal companies.
- No change to `product/enrich` (the crawler uses the v2 observation ingest instead).
- No automatic company merges: the crawler calls `mergeCompany` only after a person confirms.
- No `manufactures_for` edges. "Manufactured by X" on a label names a maker, not an owner.
