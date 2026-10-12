-- A shared product page (Costco) that is still live but no longer offers a variant it offered before (owner
-- 2026-10-12): that variant is unlisted with reason variant_removed, evidenced by the archived live page.
BEGIN;
SET LOCAL search_path = public;

ALTER TABLE listing_state_observation DROP CONSTRAINT listing_state_observation_reason_check;
ALTER TABLE listing_state_observation ADD CONSTRAINT listing_state_observation_reason_check
  CHECK (reason IN ('not_found', 'redirected_to_other_product', 'redirected_away', 'identity_conflict',
    'variant_removed'));

COMMIT;
