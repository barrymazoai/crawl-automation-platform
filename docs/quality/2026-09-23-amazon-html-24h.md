# Amazon HTML rolling 24-hour admission

The successful-collection shortcut did not cover HTML downloaded before a later Review, observation-only captures, or concurrent campaigns. The paid product capture entry now requires a shared Postgres admission decision as well as its per-operation R2 archive.

- Key: canonical Amazon site origin + ASIN, independent of brand, campaign and Worker.
- A short transaction takes a transaction-scoped advisory lock, checks recent attempts, and records the sole download admission. It commits before the provider request; no database lock or processing-resource permit is kept by the deduplication record.
- Successful captures are reusable for a rolling 24 hours from the original capture time. Unknown/failed requests block downloads for 24 hours from admission. A concurrent task whose original is not available stops explicitly rather than waiting or retrying.
- A new task may fetch after expiry. An already attempted operation may never fetch again, even after expiry. No task is scheduled/requeued by this feature.
- Reuse reads and verifies the original receipt and bytes from R2, retains an immutable copy bound to the new observation, and records the original receipt key and SHA-256 in `reusedFrom`. The original capture time and fetch-route metadata are retained. Reuse does not extend freshness. The extra copy is one requested HTML document, not a cache migration.
- Download success is archived before parsing. Parsing failure leaves reusable original evidence. If the DB acknowledgment is lost after R2 publication, a subsequent explicitly submitted task can verify that archive and reconcile its receipt without another GET.
- Missing/corrupt evidence or unknown publication stops the task without a fallback download. Original archives and Review records are not overwritten.

Migration: `024_amazon_html_fetch.sql` is additive and retains attempt history. Apply via the versioned migration path after a fresh backup. Releases that validate the migration ledger must use the updated migration list before their next startup (API, delivery, brand web and queue CLI). Existing product workflows and concurrency settings are unchanged.

Validation must run on a Mac mini: archive/HTTP regressions plus isolated PostgreSQL concurrency, expiry, failure, receipt immutability and cancellation cases. Keep production intake paused; no paid capture or queue restart is required to validate this change.
