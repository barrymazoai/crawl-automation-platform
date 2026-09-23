# Crawler V3 execution rules

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
- For this migration, query the production database through the US Mac mini (100.76.126.12). Keep queue intake paused until the user authorizes resuming it.
