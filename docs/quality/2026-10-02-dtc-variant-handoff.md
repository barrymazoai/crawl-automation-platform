# DTC website variant handoff — CRAWLV3-155

Status: implementation and offline checks complete; Mini integration/deployment/live acceptance pending.

The old collector preserved a base product and expanded its website variants for final export. The V3 native path retained the inventory but processed only `sourcePlan.owner`, so a collected base product did not prove every website variant was processed.

This repair keeps a single native Codex/Ego harvest. Each website variant receives an independent downstream operation, retained projection and image manifest referencing the existing original bytes. `variantContexts` records the model's observed website state (or explicit website evidence of shared scope), archived field method, applicable gallery and proof. The host replays the exact method against archived hashes. No generic extractor, keyword-based gallery selection, image-derived variant identity, default SKU/price backfill or repeated image download is added.

Missing, conflicting or duplicate per-variant context becomes a separate Review. Other verified variants continue. Sold-out variants retain their website SKU, options, price and availability, including independent history records even when label scope remains unresolved. Existing Label, sibling-formula verification and enrichment mechanisms are reused; a size/pack-count relationship alone cannot establish a formula match. Each child waits for cancellation of its own downstream work. The parent counts every requested website variant; enrichment pending/Review is not counted as complete. Old histories retain the pre-expansion path via `dtc-variant-handoff-v1`.

## Verification so far

- 126 offline regression checks passed: distinct flavour details/gallery; sold-out identity; missing/duplicate/state-changed/tampered/unarchived evidence; mixed success/Review; archive publication failure; file isolation; cancellation; old patch branch; existing sibling/formula and enrichment behavior; per-variant history.
- `pnpm check` passed, including lint, formatting, dependency boundaries, duplication and 22 package type checks. New Temporal replay fixture added afterward; its Mini run is pending.
- Server 一 at 2026-10-02 13:33:59 UTC: DTC paused / queued 6; other five channels running with no ready/running items; held permits empty; seven jobs ready; OCR healthy.
- No production deployment or business task submitted at this checkpoint. No old Review or original modified.
- Plane progress comment returned `fetch failed`; inspect the ticket before retrying the same comment. This local record preserves the checkpoint.

## Remaining acceptance

1. Mini real Temporal histories: expanded, mixed result, old patch branch; replay current bundle and verify permits return to zero.
2. HMW and Solaray retained originals: old unscoped multi-variant evidence must remain explicitly unresolved; single-variant behavior unchanged.
3. Git main deployment to both Minis after quiescing; fresh bounded native capture through final Label/enrichment, original hashes, per-variant records and exact page/process cleanup.
4. Record actual outcomes and remaining site-specific gaps in CRAWLV3-155. DTC batch stays paused with six queued items.
