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
