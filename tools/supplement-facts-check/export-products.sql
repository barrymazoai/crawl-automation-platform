-- Products we synced to Supply Smart whose latest label has ingredients but no formula (FORMULA_MISSING),
-- with every gallery image Supply Smart holds for them. A Whole Foods product without its own images uses the
-- images of the Amazon listing with the same ASIN. Run READ-ONLY against the Supply Smart database:
--   PGOPTIONS='-c default_transaction_read_only=on' psql "$SUPPLY_SMART_TEST_DATABASE_URL" -X -A -t -F $'\t' \
--     -f export-products.sql > manifest.tsv
-- Columns: channel, external_id, product_id, image_source, image_url
WITH latest AS (
  SELECT DISTINCT ON (product_id, listing_id) *
  FROM product_label_observation
  ORDER BY product_id, listing_id, captured_at DESC, created_at DESC),
missing AS (
  SELECT DISTINCT ON (channel, external_id) channel, external_id, product_id
  FROM latest WHERE 'FORMULA_MISSING' = ANY(issue_codes)
  ORDER BY channel, external_id),
own AS (
  SELECT m.*, 'own' AS image_source, i.image_url
  FROM missing m JOIN product_image i ON i.product_id = m.product_id),
asin AS (
  SELECT m.*, 'amazon-asin' AS image_source, i.image_url
  FROM missing m
  JOIN product_channel c ON c.channel = 'amazon' AND c.external_id = m.external_id
  JOIN product_image i ON i.product_id = c.product_id
  WHERE m.channel = 'wholefoods'
    AND NOT EXISTS (SELECT 1 FROM product_image x WHERE x.product_id = m.product_id))
SELECT DISTINCT channel, external_id, product_id, image_source, image_url
FROM (SELECT * FROM own UNION ALL SELECT * FROM asin) rows
ORDER BY channel, external_id, image_url;
