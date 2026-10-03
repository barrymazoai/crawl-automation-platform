# Crawler V3 execution rules

## DTC model judgment and reusable scripts — user clarification, 2026-10-03

- **Latest scope correction: capture materials only.** Preserve page HTML, original product-region HTML, full original galleries and website variant/page associations. Do not extract ingredients/directions/Facts or other business fields during capture; remove the added mandatory post-capture Codex review. Conversion only maps retained materials into the existing downstream input; conditional mixed-gallery attribution and the existing downstream product processing remain. Tickets 183/184.
- **Current validation instruction: do not add unit tests for this DTC repair; use necessary build/type checks and direct Mini validation of real capture, variant scope and downstream results.** Preserve the real evidence and record each outcome in the tickets.
- **Latest user-confirmed order: reuse the original DTC workflow that already uses Ego → original DTC output → mixed-variant/material judgment → fixed conversion to the next processing stage.** Do not push downstream conversion/proof requirements back into the original capture workflow. Implementation plan: [legacy-first DTC plan](docs/spark/2026-10-03-dtc-legacy-first-plan.md); 183 recovers the true old capture baseline and method reuse, 155/178 handles post-capture mixing, 184 handles conversion, parent 151.
- **The old DTC capture workflow itself already used Ego before the new Worker rewrite.** On 2026-09-28, `2417085` connected the existing DtcLegacyCapture / runHarvest workflow to Ego through the then-used bridge; `20b09db` fixed its sandbox connection and `39169c2` merged it. Its capture/skill files are unchanged at the old deployed `b891f0d`. The 2026-10-02 `92d4cb3` native-skill restoration is a later change, not the first old-DTC-to-Ego migration. Recover the old capture behavior while retaining the existing native Ego interface and verified fixes; do not rebuild a bridge or redo browser migration. See [verified lineage](docs/quality/2026-10-03-dtc-legacy-ego-lineage.md).
- **Preserve this sequence: Codex observes and validates the actual site flow → save the working flow as a reusable script/method → reuse it for applicable products → let Codex handle actual changes locally and retain the verified revision.** Do not force every product to repeat discovery or regenerate capture/handoff scripts.
- The prohibition on generic keyword extractors does **not** prohibit scripts that execute a site-specific flow already observed and validated by the model. Reuse navigation, expansion, website variant collection, full-gallery capture and handoff methods; never substitute guessed keyword/image-filename matches for the model's judgment.
- Normal differences in product text, price, stock, option names, image counts or page layout are not by themselves terminal errors. If a learned step no longer applies, preserve acquired evidence and return that step to Codex for bounded observation/adaptation; do not immediately reject the entire product, silently pick another node or restart the whole site. Genuine unresolved identity/material gaps remain explicit Review.
- Reusable scripts contain methods, not copied product values or cross-product Facts assignments. Each product keeps its own website variants and original evidence; integrity/hash and exact task-ownership checks remain enforced. A method change within the active capture is not authorization to retry a failed business task or overwrite archived evidence.
- Keep the accepted old product-first flow and native Ego browser substitution. After raw product capture, use the existing downstream processing; only the separately approved DTC mixed-gallery scope step is added where needed. A validated flow should become easier to reuse, not grow a fresh proof-writing task for each product.
- This clarification supersedes the assistant's contradictory suggestions that all script reuse is mechanical extraction or that every product must be observed from scratch. Current implementation is not yet accepted as satisfying it; track corrections and evidence under CRAWLV3-151 / CRAWLV3-148.

## Device identity and current work — 2026-09-23

- Read [execution machines](docs/operations/machines.md) before connecting to a Mini or Windows host. The US primary Mini is `server@100.76.126.12`; Windows is `rc-workstation\barry@100.114.3.97`; the new Brand Mini is `server2@100.84.91.3` (identity supplied by the user; SSH not yet verified).
- Keep the existing US single-product queue separate from [Brand entry preparation](docs/spark/2026-09-23-amazon-brand-entry-preparation-design.md). The user authorized resuming the existing single-product work, and it resumed on 2026-09-23; see [activation record](docs/quality/2026-09-23-single-products-resumed.md). Do not infer that the Brand preparation program has already been deployed.

## Browser page lifecycle — user requirement, 2026-09-10

- Every channel follows the same rule: close task-owned pages when their browser work ends. This includes brand directories, product details, image previews, search pages, and temporary tabs for GNC, Swanson, Amazon, and DTC.
- Do not leave pages open merely because they may be useful for a later task, a batch is unfinished, a Worker stopped, or a resource permit was released. Shared task space/Profile reuse does not mean retaining completed pages.
- Capture required evidence first. When original image acquisition depends on the live page, finish that bounded browser phase before closing it; OCR, Codex, and database processing must use retained evidence and must not keep the page alive.
- Success, terminal Review, failure, and cancellation all require a page-cleanup outcome. Close only exact task-owned targets; never close unrelated user tabs or the entire browser, clear cookies, reset the Profile, or kill the browser process.
- User-control or permission boundaries remain hard stops: never seize control to perform cleanup. Report cleanup as pending, not completed. Retain a page for inspection only if the user explicitly asks for that specific current page; past blanket retention requests are superseded by this rule.
- Verify target absence after closing. Browser tab inventories can lag behind a close receipt; perform a bounded read-only recheck rather than assuming the receipt proves closure or blindly repeating close.
- Automatic Workers need a task-owned page lifecycle, cleanup before lease handoff, and exact-target recovery for abnormal exits. Do not claim this is implemented just because a cleanup helper or this rule exists. Do not close a shared fixed target in an individual read/file Activity while another Activity still needs it.
- Run browser/provider/integration tests on Mac mini, not this MacBook. Preserve R2 evidence and existing passive Review records.

## Redeployment and migration — user requirement, 2026-09-22

- Redeploy code by running `git clone` on the target machine, checking out a verified commit/tag, installing locked dependencies, and building there. Do not replace this with copying old release directories or archiving the whole working tree. Identify any missing/uncommitted deployment changes explicitly instead of silently copying everything.
- Do not bulk-transfer large historical caches, downloaded images, evidence copies, model workspaces, or entire handoff directories to the new machine. Do not make their full extraction a prerequisite for cutover.
- Keep the existing R2 design: resolve retained artifacts by their references when a task needs them, verify their integrity, and cache locally as needed. This already exists; do not describe it as a new feature or modify the program merely to enable it.
- Migrate required private configuration separately. Review unresolved local-only handoffs individually; transfer only a demonstrated necessary subset. Keep explicitly authorized database backup/restore separate from historical cache copying. Preserve source data, R2 evidence, and passive Review records.
- When the user stops a transfer and requests cleanup, stop the exact task-owned transfer/import chain, delete its destination staging files, and verify absence. Do not resume that bulk migration. Report deletion as pending until it has actually completed.
- Follow the user's manual-start requirement for Worker/OCR; do not add boot/login auto-start mechanisms.
- See [migration corrections](docs/quality/2026-09-22-migration-corrections.md) for the incident, corrected procedure, and cleanup status.

## Failed execution cleanup — user requirement, 2026-09-22

- A task that failed, timed out, or cannot continue must enter explicit stop-and-cleanup handling. Do not leave its resource permits held indefinitely while reporting the batch as normally running.
- Stop the exact task-owned execution, verify provider processes and task pages have ended, retain the failure/cleanup evidence, and release its resource permits. Releasing a ledger entry alone is not a substitute for stopping actual execution.
- Preserve existing R2 evidence and passive Reviews; cleanup must not silently retry the business operation or turn a failure into a success.
- When recovery shares a Worker with healthy tasks, pause new intake and let those tasks finish before recycling that executor. Surface any unverified shutdown as an actionable recovery failure rather than silently waiting forever. Existing browser ownership and user-control boundaries still apply.
- The bounded OCR performance controller has its own Amazon/ScraperAPI recovery path. Do not claim this means automatic recovery is deployed across every production channel.

## Original HTML evidence — user requirement, 2026-09-23

- A completed Amazon HTML download must be archived byte-for-byte in R2, with capture URL/time, identity, byte size and SHA-256, and read back successfully before product parsing or analysis starts. Retain the original when parsing fails. A projection or derived HTML fragment is not a substitute for original HTML.
- Investigations, parser fixes and reanalysis use the retained original. Do not fetch a fresh page to stand in for missing historical evidence. Label any explicitly needed new capture as a new observation, archive it first, and preserve old evidence and Reviews.
- Do not silently retry failed ScraperAPI requests. Unknown archive publication must stop processing; it must not cause a second download.
- Enforce shared rolling 24-hour admission for the same Amazon site and ASIN before a paid HTML fetch, across tasks, campaigns and Workers. Reuse verified originals with their original capture time and immutable provenance; reuse must not renew the window. Failed/unknown attempts block new downloads during the window, and the same failed operation never gains retry permission when the window expires. This admission history is not a held processing-resource permit.
- For this migration, query the production database through the US Mac mini (100.76.126.12). Keep queue intake paused until the user authorizes resuming it.
