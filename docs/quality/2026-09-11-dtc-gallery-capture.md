# Innerbody DTC gallery capture correction — 2026-09-11

The second Brand trial (`f3cdb82b-5bc0-4597-8806-3f26abd7a557`) completed with passive label Review because its capture selected only the front bottle. Retained step-0 evidence contained the two actual gallery controls and 86×86 label/back thumbnails. The actual decision was `capture`, images `[2]`; it never opened either thumbnail. The user's screenshot correctly identifies Supplement Facts in the gallery of `https://shop.innerbody.com/products/astaxanthin?variant=44807968882774`.

The reader now supplies visited control indices to the decider, retains aria-labels on image buttons, and refuses early completion while observed allowlisted gallery controls remain unvisited. Each click must expose a loaded large image of a different asset; the next decision must select that new image. A responsive width change of the front image alone does not establish a new view. Bounds, challenge handling and exact page ownership remain enforced.

A real Mini browser probe found that these thumbnail buttons open `#productModal`, which covers the next thumbnail. The site policy now allowlists its observed `#productModal > span.close` control. The reader closes this preview before the next thumbnail, verifies its disappearance and hit-tests pointer targets. It does not click arbitrary modal buttons or execute the site's inline handlers directly.

Validation:

- `pnpm --filter @crawl-automation/v3-workers build:dtc`: passed, 18 JS files.
- Mini regression: 47 passed, 0 failed across dtc-cdp, dtc-live, cdp-task-pages and real Temporal dtc-stream tests. Includes premature completion, lazy loading, omitted image refusal, preview dismissal, visited-control context, ambiguity, challenge, cancellation and exact-target cleanup.
- Real browser probe: `dtc-gallery-76081b25-2233-4bc2-bcf0-caaeec441f3b`; three decision steps exposed front, Supplement Facts and other back view. Both back images were actually loaded at 600×600. Four observed URLs were retained because the front appeared at two responsive widths. No claim that these are the site's maximum-resolution files.
- Probe target `1BF8CD710C48A5047AAC641FE0F976DC` closed and absence verified by EgoTaskPages; its Mini browser permit released. Earlier diagnostic pages also closed with permits released.
- Probe evidence: Mini `/Users/barry/apps/crawlv3-batch-a.UiA4dx/dtc-gallery-76081b25-2233-4bc2-bcf0-caaeec441f3b/report.json`, step-0/1/2 JSON and PNG, and journal. The probe used the actual reader through Ego CDP with a deterministic evidence selector; it did not run Windows-native Codex, download original files through the production chain or run OCR.
- Mini rolled from supervisor 82404 to 92238, with temporary supervisor 92145 subsequently stopped. Canonical DTC roles 26/26 ready; original roles 90/90 ready. Temporal preflight `v3-dtc-doctor-3b19ce02-cc8b-4cf9-beb6-bdb3edf132d9` passed. No new Brand request submitted during this correction.

Runtime source baseline: `1e8d64986ad6cb37860e6f8460ac7f3de7898deb`.
Activity build: `d71eaa27032edf29bdeba84231320495dfd8a46972ecb38dfc032c559e0f8e3c`.
Workflow build: `774bd5fe24522dc5d03f401cec47ef2a6b74063a4cffdc9463ae7020c86cd9c6`.
The complete `product-workflows.cjs` bytes are unchanged. The combined workflow build changes because it also includes the release JS files. Mini retained old release, private and settings backups and synchronized the new gallery-dismiss site field.

Windows must pull main and follow `apps/v3-workers/deploy/innerbody/WINDOWS_GALLERY_FIX_PROMPT.md`, including the one-field site configuration update. Existing credentials and Chrome instance are reused. A new normal Brand request must then verify Windows image download, OCR/label assembly and page cleanup. Earlier Review records and R2 evidence are preserved; this correction does not promote their outcomes.
