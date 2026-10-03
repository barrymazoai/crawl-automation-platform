# HMW native DTC small-site acceptance — 2026-10-03

Tracking: CRAWLV3-151 / CRAWLV3-155. This is a live acceptance run, not a claim that six products have succeeded.

## Scope and user decisions

- Reuse the verified native catalog scan `dd93e125-5c07-4a01-82d2-0172623ebb5e`: six real product URLs, full catalog and terminal empty page reconciled. Do not repeat discovery or count the older fixed-selector captures as native acceptance.
- Capture raw products and website variants with model-directed crawl-products through native Ego; retain originals before the existing processing flow. No generic extractor or filename/keyword assignment.
- User explicitly authorized resuming Server 二 Space 6 after the manual sample inspection ended its assignment. Read-only verification confirmed the inspection page `p120` / target `84FAAFB32B481616890E1CBA90850F00` absent, with only the pre-existing unknown-origin `about:blank` preserved.
- New user instruction: skip companies requiring login to continue product collection and preserve the reason. Klean Athlete is explicitly skipped for this acceptance round. Its inspected public product detail was readable but displayed “LOG IN TO ADD TO CART”; this is not evidence that all of its product information is hidden. Do not classify every site with a sign-in link as blocked, or attempt authentication/bypasses.
- A true independent-material multi-variant positive sample is still outstanding. HMW Travel Pack's prior 7-Day/30 Day inconsistency is not a clean positive. Klean's separate flavor pages without an observed selector do not prove the variant-switching branch.

## Start

At `2026-10-03T05:44:27.132Z`, queue was paused, exactly six HMW items had attempt 0, and held permits were empty. Saved preflight and old limits at Server 一:

`/Users/server/apps/crawler-v3/manual-releases/dtc-native-20261002/hmw-six-acceptance-start.json`

Only the DTC queue was changed: ready/running limits `20/40 → 1/1`, then manually resumed. Other channels were not changed. No historical Review was requeued.

| Product path under `https://shop.hmwmethod.com` | Acceptance concern |
| --- | --- |
| `/products/method-essentials-stack-1` | Actual multiple-product bundle; verify downstream scope handling from retained evidence. |
| `/products/touchcare-method-complete` | Original-branding multivitamin bottle; complete details and label. |
| `/products/foundation-multiviatim-and-mineral-travel-pack` | Two website variants, unavailable option and website/label inconsistency; do not invent package counts. |
| `/products/method-creatine-chews` | Single product; full gallery, label and enrichment. |
| `/products/perform-creatine-chews-single-serve-pack` | A single-serve pack is not automatically a multi-product bundle. |
| `/products/hmw-method-perform-strawberry-kiwi-creatine-chews-coming-soon` | Flavor difference and availability; preserve the website's actual state. |

First run `a8a9af87-ee23-4035-aa9c-452dede76ebf` started `05:44:30.055Z` for Essentials Stack. At `05:45:01Z`, it was running with native Codex PID 34536 and task target `4D9DA5EE7E9FDBBF803594C3972EAC02`; other items had not started. These are active-execution observations, not stop proofs.

## First item exposed CRAWLV3-181

Queue intake was paused at `05:47:22Z`, leaving five items unstarted. The native capture retained all five gallery images, including two different products' Facts, and the actual website offer: a multivitamin plus creatine, one website variant `53886126784878`, USD 49.98, available. It correctly did not use a `pack`/`stack` keyword exclusion during capture.

At `05:53:34Z`, the real parent had entered a single-product Label workflow. Investigation confirmed that the old bundle scope handling existed only in the legacy DTC catalog workflow and was absent from the current native ProductPipeline path. The parent and Label were cancelled once to prevent the two products' labels becoming one formula. At `05:55:31Z` both were CANCELLED, global held permits were empty, and DTC was paused with five queued / one Review. Original results are preserved; this is not an automatic retry or a successful business collection.

Native Codex PID 34536 had a process-group-absent receipt at `05:50:08.844Z`, exact page absence at `05:50:09.301Z`, and round-ended receipt at `05:50:09.433Z`. R2 readback at `05:57:45.681Z` verified all 59 files / 20,607,904 bytes against size and SHA-256. Evidence files under the same Server 一 directory: `hmw-six-first-{status,cancel,stopped,r2-proof}.json`.

Impact check at `06:17:22Z`: no `collected_product` or `product_enrichment_subject` exists for the first item's listing. Its cancelled Label history never reached assembly/collection. Proof: `hmw-six-first-no-business-write.json`; no mixed-product formula was written.

The CRAWLV3-181 patch adds a DTC-only semantic scope decision after raw archive/observed-field verification and before Facts plans. Codex reviews website fields and all variant options, with exact retained-field citations. An explicit offer containing two distinct products returns `scope-excluded / DTC.MULTI_PRODUCT_BUNDLE`; single-product travel packs, single-serve packs and selectable variants continue unchanged. Mixed single/bundle options or insufficient evidence remain unresolved. This is not keyword extraction, image-based specification collection, or shared Facts modification.

Scope input, intent, raw answer and validated result are retained. A completed decision can be reused; an uncertain started call is not repeated. Queue execution completion with an exclusion reason is distinct from a successfully collected product. The patch is not yet deployed. Mini-only retained acceptance will use the first bundle, old Travel Pack and successful Solaray mixed-gallery originals, and check the full capture boundary without altering their historical results.

## Retained scope acceptance

Business patch `5ddc4e1`; tools corrected in `429776a` / `d9b2451`; scope citation/admission fixes `403cd66` / `9c8b107`. Local full `pnpm check` and 32 focused tests passed; all 32 also passed on Server 二. The first tool replay omitted the workflow ID and failed before provider execution; corrected replay of all three actual product parent histories passed.

Three actual Codex calls used the existing `mini-model-account` gate on an isolated Temporal queue. Their input/answer/results are retained under `v3/dtc-product-scope/`. Model decision categories were correct in all three; Solaray's initial host validation rejected legitimate `variants` citations because only text fields were allowed. The fix exposes the exact retained website inventory as a citable field, rejects invented counts, and fixes model-call admission to the operation ID so changed input cannot repeat an uncertain failed call.

After the fix, all original files and all three saved model inputs/answers were reread from R2 and compared with local bytes, then revalidated without any new model calls. The full `DtcAgentProductCapture` boundary was exercised with these actual answers and in-memory derivative publications:

| Original run | Original files checked | Decision and boundary |
| --- | --- | --- |
| `a8a9af87-ee23-4035-aa9c-452dede76ebf` | 59 | Multi-product bundle; `scope-excluded`, zero source projections. |
| `7725ee3e-611a-4110-92c7-fcd16fae0d71` | 41 | Single-product Travel Pack; normal source plan, both old unscoped variants remain Review. This does not resolve their material ambiguity. |
| `e3415944-675d-4732-b976-b3b463041c5e` | 81 | Single product with 120ct/240ct options; both variants retain the mixed-gallery handoff and three expected base/variant projections. |

The three validation workflows were `dtc-scope-accept-609c31a9-37e2-4fb1-a0ed-d1206b2f756d`, `dtc-scope-accept-b705320d-e74a-4af8-aff1-19544468b40f`, and `dtc-scope-accept-5219c421-d228-4c63-8f74-948b3b0063a4`. All three Codex processes have exit receipts preceding permit release. At `06:12:32Z` global held permits were empty. The third original validation remains failed; its retained-answer revalidation is a separate proof, not a rewritten successful task.

Evidence: Server 二 `manual-releases/scope181-d9b2451-live/` and `manual-releases/scope181-9c8b107-revalidation/`; Server 一 `manual-releases/dtc-native-20261002/scope181-model-stop-proof.json`. Tool commands are committed as `tools/verify-dtc-retained-scope.mts` and `tools/revalidate-dtc-scope.mts`.

Deployment preflight at `06:13:53Z`: no held permits or running/ready items; all other channel queues had zero unstarted items. Saved their running modes and manually paused them before service replacement. DTC remains paused with five queued / one cancelled Review and 1/1 limits. Deploying `9c8b107` through origin main fresh clone/build; readiness and queue restoration remain to be verified.

Deployment completed: Server 一 seven jobs verified ready at `06:14:28Z`; Server 二 browser-worker verified ready at `06:15:12Z`. Both run `9c8b107`. No migration or automatic startup was added. Five other empty channel queues were restored to their original running modes; DTC stayed paused until the next bounded item start. Deployment receipts and `scope181-{deploy-preflight,queues-restored}.json` are retained on Server 一; Server 二 logs are under `manual-releases/dtc-mixed-852546a/`.

## Second item

At `06:15:59Z`, original HMW queue item `59152395f5066ecdc0bad8b885148891ce57e9794e58f845c7f394bd31135fd0` started its first attempt, run `88409a29-c6d9-4f4a-acee-f0001cf1f155`, for `/products/touchcare-method-complete`. Intake was immediately paused without forcing this execution: four queued / one running / one cancelled Review. This is not a retry of the first item. Preflight/start receipts are `hmw-six-second-{preflight,start}.json`; outcome is pending.

## Required closeout

For every base product record its outcome, discovered/processed/review variants, scope exclusions, independent or mixed material route, selected Facts source, website commerce, enrichment result, R2 size/hash readback, exact browser/process stop evidence and released permits. All-settled is separate from all-successful. Keep passive Reviews and originals unchanged; diagnose implementation failures using retained evidence.

Whole-site acceptance remains in progress. CRAWLV3-178's separate Solaray mixed-gallery run already passed 2/2 variants; see [variant routing acceptance](2026-10-03-dtc-variant-routing.md).
