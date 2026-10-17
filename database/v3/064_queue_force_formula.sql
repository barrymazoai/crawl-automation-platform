-- Owner 2026-10-17: a product queued again with forceFormula extracts its formula afresh instead of reusing the one
-- already collected (ingredients-only labels whose Supplement Facts panel was missed). Cleared once it completes.
BEGIN;
SET LOCAL search_path = public;

ALTER TABLE queue_item ADD COLUMN force_formula boolean NOT NULL DEFAULT false;

COMMIT;
