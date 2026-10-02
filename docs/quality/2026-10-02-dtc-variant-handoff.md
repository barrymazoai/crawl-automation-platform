# DTC website variant handoff — CRAWLV3-155

Status: implemented and deployed; Mini integration passed; controlled live acceptance in progress.

The old collector preserved a base product and expanded its website variants for final export. The V3 native path retained the inventory but processed only `sourcePlan.owner`, so a collected base product did not prove every website variant was processed.

This repair keeps a single native Codex/Ego harvest. Each website variant receives an independent downstream operation, retained projection and image manifest referencing the existing original bytes. `variantContexts` records the model's observed website state (or explicit website evidence of shared scope), archived field method, applicable gallery and proof. The host replays the exact method against archived hashes. No generic extractor, keyword-based gallery selection, image-derived variant identity, default SKU/price backfill or repeated image download is added.

Missing, conflicting or duplicate per-variant context becomes a separate Review. Other verified variants continue. Sold-out variants retain their website SKU, options, price and availability, including independent history records even when label scope remains unresolved. Existing Label, sibling-formula verification and enrichment mechanisms are reused; a size/pack-count relationship alone cannot establish a formula match. Each child waits for cancellation of its own downstream work. The parent counts every requested website variant; enrichment pending/Review is not counted as complete. Old histories retain the pre-expansion path via `dtc-variant-handoff-v1`.

## Verification so far

- 126 offline regression checks passed: distinct flavour details/gallery; sold-out identity; missing/duplicate/state-changed/tampered/unarchived evidence; mixed success/Review; archive publication failure; file isolation; cancellation; old patch branch; existing sibling/formula and enrichment behavior; per-variant history.
- `pnpm check` passed, including lint, formatting, dependency boundaries, duplication and 22 package type checks; Git push hooks passed for every shipped commit.
- Server 一 at 2026-10-02 13:33:59 UTC: DTC paused / queued 6; other five channels running with no ready/running items; held permits empty; seven jobs ready; OCR healthy.
- Server 二 final verification: 128 passed / 1 skipped, including three real Temporal histories/replays (all variants, partial Review, pre-patch), six browser source integration tests, retained originals and existing enrichment/reuse regressions. Worker built. The skipped case requires a new-protocol Solaray capture.
- HMW retained run `7725ee3e-611a-4110-92c7-fcd16fae0d71`: both old unscoped variants become independent Reviews, preserving SKU 012 / 9.99 / unavailable and SKU 022 / 34.99 / available. No variant formula is fabricated.
- Solaray's retained records predate field provenance (`fieldEvidence` absent); they cannot prove success under the current protocol. An explicit negative test verifies `observed_method_unverified / method_required`. Originals were not edited to make the test pass.
- A real single-brand compatibility defect surfaced after repairing outdated test fixtures: native actual brand was rejected by the legacy site-key projection decoder. CRAWLV3-174 fixes this with the existing `dtc-product/2` brand-proof wrapper; legacy site-key projections remain readable. Local related tests: 57 passed / 2 unconfigured historical fixtures skipped.
- Plane's transient comment failure was read back before retry; progress was then recorded on 155 and the discovered defect on 174.

## Deployment and live acceptance

- Main commits: `ab592c1` implementation, `3efb476` retained tests, `adb5a01` native integration fixtures, `907dd01` single-brand compatibility.
- Both hosts received **907dd01aa5d1d932383270e44bfad313df92ee56** through fresh Git clones and locked install/build. No code copied outside Git, no migration or auto-start added.
- Server 一 ready at 13:48:48.864 UTC; Server 二 browser Worker ready at 13:49:41.930 UTC. Original process files backed up by deployment.
- Queue modes saved in Server 一 `manual-releases/dtc-native-20261002/before-dtc-variants-907dd01-deploy.json`. Five originally running empty queues restored at 13:50:21.883 UTC; DTC remained paused/queued 6, held permits empty, seven local jobs ready and OCR healthy.
- Ego baseline: TaskSpace 6, agent control, only p1 `EA0CD8AF195DEB4B359079117C351DBC`, chrome://newtab/. No unrelated pages operated.
- New bounded Solaray run `f12f2ea3-d3a0-4c5f-b632-d29b170ca23c`, submitted at 13:50:51.319 UTC, completed at 14:02:47.016 UTC, source `e9b8bcd7-7fc6-4605-969c-c8cd6d776f3e`, URL `https://solaray.com/products/zinc-copper`. Label collected and enrichment registered; no failed Temporal events. Website variant `32703815778364`, SKU `076280471052`, `100 ct`, $11.89, available; normalized count 100. Formula retained four nutrient rows and four other ingredients. The native collector retained both observed carousel images; subsequent existing Label selection identified the facts image.
- Solaray operation `label-621a6402c3aae28fa4089d32eb75a6266db2a633bbbbdac7790109ef6f267ef8`; enrichment `8a57cb5b812ea2eab66ecead68762f57be1af00a1d4e55831e8f60561f42d12c`. All 41 R2 files (7,632,026 bytes) read back with matching size and SHA-256. The new retained single-variant test passed on Server 二, resolving the previously skipped acceptance case. Native process 65136 exited 0 and was verified absent; page `A096B16B019798DF8CC4F8E6732EC0C8` absent, only baseline p1 retained. Held permits empty after capture. Evidence: Server 一 `manual-releases/dtc-native-20261002/variant155-solaray-{request,receipt,product,r2-proof}.json`.
- New bounded HMW multi-variant run `f84a2f8d-a9b1-4b90-814d-2338f08c556a`, submitted at 14:03:43.110 UTC, source `743aae55-33ee-4233-ba73-037c1b534af5`, URL `https://shop.hmwmethod.com/products/foundation-multiviatim-and-mineral-travel-pack`. Capture exposed CRAWLV3-175: the model asserted `website-shared` from a single carousel/default selection without an explicit website statement. Cancellation requested at 14:10:10.325 UTC, workflow CANCELLED at 14:10:31.709 UTC, no child workflows or failure events. No label/enrichment result is claimed. Request/receipt retained as `variant155-hmw-{request,receipt}.json`.
- HMW's 43 archived files (9,733,632 bytes) all passed R2 readback size/SHA checks; original review and failed first preview retained. Native process 71612 exited 0 at 14:09:48.007 UTC and has an absence receipt. TaskSpace 6 inventory after cancellation contains only baseline p1. CRAWLV3-175 now requires a `sharedScope` exact source rule and website text, replayed using existing immutable observed-source checks. Source grounding is checked by code; whether that statement actually covers the claimed variants/material remains the model's semantic responsibility. No keyword classifier is introduced.
- No historical Review, original or completed workflow rewritten.

## Remaining acceptance

1. Complete 175's Mini retained negative-case and regression checks, deploy via Git, then finish a fresh bounded HMW observation through final per-variant outcomes and cleanup. Solaray single-variant acceptance is complete; CRAWLV3-174 is in Review.
2. Record actual outcomes and remaining site-specific gaps in CRAWLV3-155. DTC batch stays paused with six queued items.
