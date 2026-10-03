# DTC variant preflight — CRAWLV3-176

Status: implementation ready; Mini retained-original verification and deployment pending.

Run `537ab7bb-6198-499a-bfa3-86011a004854` retained the complete HMW base product, two website variants and two observed gallery images, but declared both variants observed using the same base method. The saved DOM URL actually identifies the selected 30 Day variant; the method URL does not. The other option was listed in the form but was never selected. The model's final checks verified file/field presence rather than the variant handoff. The host correctly returned two independent Reviews; no Label/enrichment child ran.

`readObservedVariant` now exposes the same read-only original/hash, product identity, selected URL, complete inventory and explicit shared-statement checks to both the model and host. Instructions require per-variant preview before `runHarvest`, with results retained in `variant-preflight.json`. The current selected state can reuse its retained DOM through a distinct method bound to its actual URL. Other states require actual observation or an explicit unresolved outcome. The helper performs no navigation, extraction discovery, image download, formula inference or file mutation. Existing host gallery/publication checks remain in place.

Verification so far:

- 56 focused local checks passed, including base-method misuse, a valid current-state method over unchanged originals, wrong-state DOM, changed inventory, invented/duplicate IDs, and missing/tampered/valid explicit website scope statements.
- New Mini-only retained test uses the unchanged failing HMW originals: both original contexts must still be Review. A separate in-memory method bound to the actual saved current URL checks structural eligibility only; it does not rewrite the old run or assert label scope/success.
- Original evidence and database metadata audit: [previous acceptance record](2026-10-02-dtc-variant-handoff.md).

Pending: Mini regression, main Git deployment, one new bounded HMW observation, actual per-variant outcomes and exact page/process/resource cleanup. DTC batch stays paused/6. CRAWLV3-155's live different-flavour/formula and mixed-gallery acceptance is not yet complete; synthetic isolation cases do not replace those checks.
