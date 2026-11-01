BEGIN;
-- Owner 2026-11-01: the owner may finish named Review items without a new run (Prolon fasting kits are not
-- supplements). The item keeps its run and every historical attempt; the note and time record that the outcome
-- is the owner's decision, and stay if the item is later queued again.
ALTER TABLE queue_item ADD COLUMN owner_settled_at timestamptz;
ALTER TABLE queue_item ADD COLUMN owner_note text
  CHECK (owner_note IS NULL OR char_length(owner_note) BETWEEN 1 AND 200);
ALTER TABLE queue_item ADD CONSTRAINT queue_owner_settle_receipt
  CHECK ((owner_settled_at IS NULL) = (owner_note IS NULL));
COMMIT;
