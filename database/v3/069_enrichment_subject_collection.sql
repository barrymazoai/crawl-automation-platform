BEGIN;

-- Delivery, reopen `enriched` and the health function cleanup find a sent product's enrichment by its collection
-- operation (the ledger's listing ID is not the subject's: Swanson ledgers the page slug). Without this index
-- reopen `enriched` checked every verified row against all subjects and passed 60 s (2026-10-26).
CREATE INDEX product_enrichment_subject_collection
  ON product_enrichment_subject (collection_operation_id, channel, registered_at DESC);

COMMIT;
