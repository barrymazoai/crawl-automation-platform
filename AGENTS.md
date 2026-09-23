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

## Original HTML evidence — user requirement, 2026-09-23

- A completed Amazon HTML download must be archived byte-for-byte in R2, with capture URL/time, identity, byte size and SHA-256, and read back successfully before product parsing or analysis starts. Retain the original when parsing fails. A projection or derived HTML fragment is not a substitute for original HTML.
- Investigations, parser fixes and reanalysis use the retained original. Do not fetch a fresh page to stand in for missing historical evidence. Label any explicitly needed new capture as a new observation, archive it first, and preserve old evidence and Reviews.
- Do not silently retry failed ScraperAPI requests. Unknown archive publication must stop processing; it must not cause a second download.
- For this migration, query the production database through the US Mac mini (100.76.126.12). Keep queue intake paused until the user authorizes resuming it.
