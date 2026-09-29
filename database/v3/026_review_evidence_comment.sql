BEGIN;
-- Comment only. The owner decided on 2026-09-29 that the collection API (private network, no login) may return a
-- full Review record and its evidence files (reviews.evidence); list/get still return the allowlisted projection.
COMMENT ON TABLE review_record IS 'Full candidate and original error evidence. Append-only passive journal, not a task queue. HTTP list/get use an allowlisted projection; the private-network reviews.evidence procedure returns the raw record.';
COMMIT;
