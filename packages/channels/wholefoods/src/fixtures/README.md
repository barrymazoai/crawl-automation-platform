# Whole Foods test pages (synthetic)

No real Whole Foods page is saved in the repository yet. These pages are **built by hand** from what the 2026-09-28
checks in Ego recorded (docs/spark/2026-09-28-channel-brand-adapters-plan.md, "Whole Foods vs Amazon check" and "Price
by store"): the `/grocery/product/<slug>-<asin>` links, the "Pickup at The Alameda" store line, the prices shown at
The Alameda (store 10259) and the "No results for" notice. Replace them with archived originals from the first real
run (`v3/wholefoods-html/…`, `v3/brand-scans/…`) and keep the tests passing.
