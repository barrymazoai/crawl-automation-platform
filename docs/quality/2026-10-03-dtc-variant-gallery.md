# DTC mixed gallery scope — CRAWLV3-178

Parent CRAWLV3-155 / 151. This continues the user-authorized native Ego multi-variant acceptance. Website variants remain the source of SKU, options, price and availability. All original product images are retained before downstream processing.

## Real observation

- Solaray Magnesium Glycinate, `https://solaray.com/products/magnesium-glycinate`.
- Run `90c13a04-0439-420e-96b0-e366d2e4e703`, submitted 2026-10-03 01:53:42.412 UTC on `d936fd1`; source `e9b8bcd7-7fc6-4605-969c-c8cd6d776f3e`.
- Website inventory: 240ct `39660429836348`, SKU `076280895049`, 31.99, in stock; 120ct `39660429803580`, SKU `076280549010`, 18.39, in stock. Currency was visible as USD but absent from the selected field method; currency fidelity is still unaccepted.
- Native capture saved one base record, two variants and five original gallery images. Ingredients/Directions were expanded and mapped to observed nodes. The model initially hit an invisible gallery-button error and shell syntax errors; file-based scripts continued successfully within the same task.
- Only 120ct received a selected-state DOM/method. The default 240ct was unresolved because the model had not saved an independent selected-state original. This is an observation gap, not evidence that the website cannot expose that variant.
- 120ct's final `galleryUrls` contained all five images. `imageAssignments` were all null; Shopify's actual `variant_ids` arrays were empty. Inspection of the actual retained images confirmed one Facts image has 4 VegCaps / 30 servings, the other 4 VegCaps / 60 servings. Both cannot unconditionally be treated as this package's label. Filenames were not used as proof.
- `variant-preflight.json` checked 120ct with `galleryUrls: []`; the final context was changed afterwards. The old shared preflight function checked source/variant identity, not gallery scope. Host verification only rejected explicitly conflicting image bindings, then rebound null images to the selected variant.

## Stop and evidence

Cancellation requested at 02:06:16.327 UTC; parent CANCELLED at 02:06:30.998, no child workflows started. Native Codex PID 19184 had already exited 0 at 02:05:10.787. At 02:10:54 PID absence and exact page `BFC796925A2F49AD7E7E54004D89D502` absence were verified; space 6 retained only baseline p1. At 02:10:58 held permits were empty; DTC paused with 6 queued.

R2 archive `v3/dtc-agent/product-90c13a04-0439-420e-96b0-e366d2e4e703/archive.json`: all 62 files / 12,879,176 bytes read back with matching SHA-256 and byte size at 02:08:26.629 UTC. Server 一 proof `manual-releases/dtc-native-20261002/variant178-magnesium-r2-proof.json`. Server 二 original workspace `apps/crawler-dtc/browser-model/dtc-native/dd7cd6d18e765d51749d148edb46b092eee47dcf00570b469f0acfbd35044e3e`.

## Repair and limits

Each observed variant now carries a model-reviewed `galleryReview` covering the full base gallery: applicable, other-variant or unresolved, with actual evidence and an applicability basis. The selected subset must exactly match applicable entries; visibility in a static carousel and null bindings do not qualify. Unknown and other-variant images remain in the base archive. This is scope validation, not an image-derived variant inventory or generic image extractor.

The same `readObservedVariant` scope check runs before harvest and in the host. The host also compares the archived final context and method to the successful preflight entry and checks that cited evidence was archived. Semantic correctness of the model's per-image observations still requires real acceptance; the validator does not read pixels or prove a free-text assertion by itself. Old insufficient captures become per-variant Review if explicitly reprocessed; existing records/plans/history are not rewritten.

The native instructions also require all default/nondefault observations before harvesting and file-based multiline Ego scripts to avoid shell quoting errors. Production deployment and the next fresh native acceptance are pending. Full multi-variant, flavour/formula, mixed gallery and whole-brand acceptance remain incomplete.

Local validation: 25 host/prompt tests plus 29 pure source/variant/gallery tests passed; full `pnpm check` passed. The extracted shared test fixture retains the existing test-file size rules through a narrowly scoped lint annotation; production lint rules are unchanged. Mini real-original regression and deployment remain pending at this commit.

## Deployment follow-up

Commit `4db6d4aad9d65d2cb39ea14509fc981365711229` reached both Minis through origin main and fresh Git clone/build: Server 一 ready at 02:17:26.013 UTC, Server 二 at 02:18:34.789 UTC. Mini acceptance passed 144 checks across 19 files, including six retained captures and real Temporal checks; another 29 pure checks and the Worker build passed. At 02:25:37.125 UTC the other queues were restored and empty, DTC remained paused with six queued, and no permits were held. No new business observation followed deployment. The preceding pending statements describe the state when the commit was written.

## User-directed OCR/Facts preprocessing — design, not implemented

After inspecting the mixed gallery locally, the user proposed reusing the existing OCR-to-Facts discovery before the individual product/variant flow. This supersedes requiring browser capture to finish semantic image attribution. The deployed guard above remains a containment check; it does not implement this preprocessing or prove the model's image interpretation.

Proposed order:

1. Native Ego/Codex observes the website's complete variant inventory and each required selected state, retaining SKU, price, availability, options, page evidence and the complete original gallery. Missing website observations remain missing; Facts cannot invent or repair those fields.
2. After original archival and browser cleanup, reuse existing acquisition/OCR receipts and Facts candidate screening on the retained images. Evaluate all relevant Facts candidates, including multi-image labels. OCR-empty or uncertain images require visual inspection or explicit unresolved status, not silent exclusion.
3. Codex receives original candidate images, OCR text and the website variant evidence together. It determines Facts applicability from product identity, serving size, servings per container, printed packaging/flavour and any explicit website binding. It records cited image/text evidence and conflicts. Keyword screening identifies candidate Facts images only; filenames, gallery position and numeric matches do not assign variants.
4. Publish evidence-backed Facts references per website variant, then enter the existing individual product/variant processing. Keep the complete gallery at the parent capture; the preprocessing need not force every marketing image into a variant. Shared Facts require evidence of applicability, not merely equal nutrient rows. A variant with unresolved attribution remains Review while independently verified variants can proceed.
5. Carry verified OCR/Facts evidence forward by reference with its original producer, owner, image identity and receipt. Do not rerun OCR merely because a variant child starts, and do not relabel an old receipt with a new variant identity. This reference handoff needs implementation and validation.

Verified reuse points: `packages/workflows/src/label/label-image-ocr.ts` already prepares image OCR, performs the admitted OCR operation, resolves its receipt, screens candidates and verifies owner/image/operation identity. `label-source.ts` supplies model interpretation. However, `label-ordered.ts` stops after the first complete label; reusing that whole traversal would miss other variant labels. The new preprocessing must enumerate candidates before applying per-variant completion rules. Single-product stopping behavior should remain unchanged.

For the retained Solaray observation, the website supplies 120ct and 240ct. Actual Facts originals show 4 VegCaps with 30 and 60 servings respectively. These support the proposed model comparison after confirming product identity and consistency; this is a test hypothesis until the preprocessing runs, not a completed OCR or end-to-end result.

Acceptance must cover this retained mixed gallery, genuinely shared Facts, flavour/formula differences, incomplete or unreadable Facts, conflicting/missing variant observations, and receipt reuse without duplicate OCR. Cancellation must stop and account for all started OCR/model work before resource release. Preserve the original cancelled observation and its Review evidence; use separate test operations.

## Existing variant Facts differences audit — CRAWLV3-179

The user asked whether the previous Facts pipeline already accounts for small differences between variants. It does in design, but the sibling reuse shortcut has a verified gap. `SiblingFormulaReuse` only allows size/pack-count families and requires the target's own Facts text or verified OCR text; flavour/strength differences take full extraction. Full Label candidates retain serving metadata, per-row amount/DV, ordered columns/row structure and other ingredients, and the existing assembly comparison examines those fields.

However, `checkSiblingLabel` compares normalized text with `includes` for serving size and each saved name/amount. It omits DV and column/row structure. A local pure-function audit on `4db6d4a` confirmed that a saved 50 mg row accepts a target 250 mg row, saved 12% DV accepts 13%, and saved 2 Capsules accepts 12 Capsules. Ordinary 50→51 mg is rejected. A 30→60 servings-per-container difference is intentionally allowed for size reuse; each variant's actual packaging still needs its own retained evidence. Unspecified ingredient source versus added `(as oxide)` also passes, which is not proof of complete Facts equivalence.

Synthetic input and actual checker outputs: [audit evidence](evidence/2026-10-03-dtc-variant-facts-audit.json). This was a local pure-function check, not a live product/provider test. Historical production impact is not established. CRAWLV3-179 tracks correction and boundary cases; no production code was changed during this audit. New OCR/Facts preprocessing must not pass its results into a weaker reuse path that discards these differences. The existing known-formula early return also needs explicit review when integrating newly captured Facts, rather than assuming every observation currently reaches a fresh comparison.

The user explicitly requested tracking possible mixed use of different variants' Facts across channels. CRAWLV3-178 covers image/page/OCR attribution; CRAWLV3-179 covers formula reuse that can discard differences. The observed DTC wrong-gallery handoff was cancelled before child processing, so it is not proof of successful downstream contamination. Amazon/GNC/Swanson family reuse and Whole Foods' Amazon-ASIN formula path need channel-specific retained-evidence audits; shared code alone does not establish affected historical records. Check mixed galleries, first-Facts stopping, known-formula early returns, owner references and independent container counts. The new preprocessing first connects to DTC; the shared reuse correction must be verified for every actual caller.

## 当前实施边界

以 [DTC 两路分流实施记录](2026-10-03-dtc-variant-routing.md) 为准。本轮只增加混合图库前置和同 URL 状态证明，保留原 Facts 合约。上文“跨 owner 复用 OCR 回执、子任务零重复 OCR”为先前提案，当前未接入；不得把其列入已完成验收。多张 Facts 对同规格仍有歧义时明确 Review，不按第一张自动成功。
