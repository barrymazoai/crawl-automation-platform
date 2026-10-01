# Integration migrations after 038

Apply 039 → 040 → 041 → 042 through the migration API before loading the integrated
worker/API code. Pause intake first. This integration session did not connect to a
database, apply migrations, deploy code, or start services.

| Migration | Dependencies and effect |
| --- | --- |
| 039 | Uses `product_enrichment` from 020, `collected_product` and the immutable-history trigger from 018. Adds distinct immutable claim and subject tables and runtime read/insert grants. |
| 040 | Extends `queue_item` and `queue_attempt` from 027; adds followers, active-claim uniqueness and Whole Foods formula outcomes. Historical attempts remain immutable. |
| 041 | Extends `html_capture` from 033 and indexes `queue_attempt` from 027. Adds immutable usage events. Historical fresh/unknown costs stay null; identified reuse costs zero. A historical original without a capture operation ID stays unknown-cost instead of failing the non-null `reused` column. |
| 042 | Uses `resource_permit` from 015. Adds execution/stop/event journals, guards release with stop proof, and grants the runtime role read/insert/update on stop and execution rows, read/insert on events. Existing held permits without proof remain held. |

The added table, index, column and function names do not conflict with 001–038 or
with each other. Like the earlier schema migrations, these DDL files run once;
repeat API application uses the migration ledger and skips matching hashes. Raw
SQL reapplication is not supported. The idempotent capacity seeds in 036–038 and
their hashes are unchanged. The catalog test now pins all 001–042 names/hashes.

## Exactly what 040 does to duplicates

The unique index includes only `queued`, `ready` and `running`, keyed by channel,
listing and variant. Historical `review`, `completed` and `pending` rows are
outside both the index and the backfill.

Therefore the supplied production case of **30 review+queued pairs and two
completed+queued pairs** preserves all 64 rows: the 32 queued requests stay queued,
the 30 Reviews and two completions stay terminal, and their attempts, run IDs,
reasons and timestamps stay unchanged. The new follower field is null. No old
Review is retried and no collection is removed by the migration.

For multiple active requests for the same channel/listing/variant, 040 takes an
exclusive table lock and deterministically selects the sole running row first,
otherwise earliest `created_at`, breaking ties by `item_id`. Other queued/ready
rows become `following` and point to that leader; only their state, follower pointer
and update timestamp change. Their batch requests and prior attempt history stay
intact. New attempts are not inserted. Followers later inherit the leader's terminal
receipt through the settlement trigger.

If two rows for the same identity are already running, 040 raises an exception
before schema/backfill changes. It does not conceal executions or release their
resources. Those exact executions must be drained and verified before applying.

## Verification boundary

Unit tests validate catalog ordering/hashes and queue adapter behavior. The explicit
PostgreSQL acceptance suite `packages/adapters/src/migrations/integration-migrations.test.ts`
starts from 038 and covers all four migrations, the 32 historical pairs, running
priority, oldest/tie selection, immutable attempts, ambiguous historical capture
costs, runtime grants and atomic refusal of duplicate running owners. It was authored
but **not executed** here because PostgreSQL-server tests are prohibited in this session.
The existing queue-coalescing integration suite covers concurrent admission and
follower settlement; it is also unrun here.
