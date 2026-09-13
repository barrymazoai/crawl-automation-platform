BEGIN;
-- Read/export by retained source without scanning all observation relationships.
CREATE INDEX product_history_observation_source_origin ON product_history_observation_source(source_record_id);
COMMIT;
