# Swanson test pages

Real product pages archived byte for byte by the Healthy Origins pilot on 2026-09-28 (R2
`v3/swanson-html/<operation>-product/original.html`), gzip-compressed. They are public pages; the only key-like
value in them is Swanson's own client-side analytics key (`amplitudeApiKey`), which the page sends to every visitor.

| File                                        | Page                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------- |
| `healthy-origins-d-ribose.html.gz`          | `/p/healthy-origins-natural-d-ribose-10-6-oz-pwdr`                              |
| `healthy-origins-ubiquinol-variant.html.gz` | `/p/healthy-origins-ubiquinol-kaneka-qh-100-mg-60-sgels?variant=46318812168330` |

Page projections (the public JSON the Swanson parser reads back for the planner), copied from the former
`packages/v3-channels/src/fixtures` so the label-core tests no longer read another package's files. All test data
moves out of git with ticket R45 (R2 test prefix).

| File                          | Content                                      |
| ----------------------------- | -------------------------------------------- |
| `swanson-product-public.json` | Projection of a Swanson product page (09-28) |
| `swanson-second-public.json`  | Projection of a second product page (09-29)  |
