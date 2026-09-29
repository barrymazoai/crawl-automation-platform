-- The shared pipeline writes one metrics point per product capture into the history tables (018), for every
-- channel. The earlier history projection was granted these rights by hand; the services' database role gets them
-- here: it may add and read, never change or remove (the tables are append-only).
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON product_history_source, product_history_listing, product_history_listing_source,
      product_history_observation, product_history_observation_source TO v3_runtime;
  END IF;
END;
$$;
COMMIT;
