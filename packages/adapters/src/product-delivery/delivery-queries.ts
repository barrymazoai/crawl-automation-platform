export const DELIVERY_QUEUE = `
  SELECT DISTINCT ON (q.source_id, q.listing_id, q.variant_id)
    q.item_id, q.batch_id::text, q.source_id::text, q.listing_id, q.variant_id,
    q.state, q.run_id::text, a.settled_at, a.outcome
  FROM queue_item q JOIN brand_source s ON s.id=q.source_id AND s.channel='dtc'
  LEFT JOIN queue_attempt a ON a.run_id=q.run_id
  WHERE q.channel='dtc' AND q.source_id=ANY($1::uuid[])
    AND ($2::uuid[] IS NULL OR q.batch_id=ANY($2::uuid[]))
  ORDER BY q.source_id, q.listing_id, q.variant_id, q.created_at DESC, q.item_id DESC`;

export const DELIVERY_SCANS = `
  SELECT DISTINCT ON (scan.source_id) scan.source_id::text, scan_id::text, state, started_at, result, settings
  FROM brand_scan scan LEFT JOIN dtc_source_settings policy ON policy.source_id=scan.source_id
  WHERE channel='dtc' AND scan.source_id=ANY($1::uuid[])
    AND ($2::uuid[] IS NULL OR scan.scan_id=ANY($2::uuid[]))
  ORDER BY scan.source_id, requested_at DESC, scan_id DESC`;

export const DELIVERY_COLLECTIONS = `
  SELECT DISTINCT ON (record->'observation'->>'listingId', record->'observation'->>'variantId') operation_id
  FROM collected_product
  WHERE record->'observation'->>'requestId'=$1 AND record->'observation'->>'sourceId'=$2
    AND record->>'codec' IN ('collected-product/3','collected-product/4','collected-product/5')
  ORDER BY record->'observation'->>'listingId', record->'observation'->>'variantId',
    collected_at DESC, operation_id DESC`;

/**
 * KAN-259: did this run only revisit a live listing? A metrics-only revisit records `live` sightings and collects
 * nothing; an unlisted revisit (brand mismatch, identity conflict, removed variant) must not count.
 */
export const DELIVERY_LIVE_REVISIT = `
  SELECT count(*) FILTER (WHERE state='live')::int AS live,
    count(*) FILTER (WHERE state<>'live')::int AS other
  FROM listing_state_observation
  WHERE channel='dtc' AND listing_id=$1 AND run_id=$2::uuid`;

/**
 * KAN-259: the newest other settled, completed attempt (an earlier attempt of the same queue item included) of the same
 * source and SKU that collected the product, within the request's scans when it names them (KAN-253). Attempts that
 * ended in Review never qualify: their label was not accepted.
 */
export const DELIVERY_EARLIER_COLLECTION = `
  SELECT q.item_id, q.batch_id::text, q.source_id::text, q.listing_id, q.variant_id,
    'completed' AS state, a.run_id::text, a.settled_at, a.outcome
  FROM queue_attempt a JOIN queue_item q ON q.item_id=a.item_id
  WHERE q.channel='dtc' AND q.source_id=$1::uuid AND q.listing_id=$2
    AND q.variant_id IS NOT DISTINCT FROM $3::text AND a.run_id<>$4::uuid
    AND a.settled_at IS NOT NULL AND a.outcome='completed'
    AND ($5::uuid[] IS NULL OR q.batch_id=ANY($5::uuid[]))
    AND EXISTS (SELECT 1 FROM collected_product cp
      WHERE cp.record->'observation'->>'requestId'=a.run_id::text
        AND cp.record->'observation'->>'sourceId'=q.source_id::text
        AND cp.record->>'codec' IN ('collected-product/3','collected-product/4','collected-product/5'))
  ORDER BY a.started_at DESC NULLS LAST, a.run_id DESC LIMIT 1`;

export const DELIVERY_HISTORY = `
  SELECT record, body_hash FROM product_history_source
  WHERE record->>'codec'='v3-capture-history/1'
    AND record->'listing'->>'channel'='dtc'
    AND record->'owner'->>'runId'=$1 AND record->'owner'->>'sourceId'=$2
    AND record->'listing'->>'externalId'=$3
    AND (record->'capture'->>'variantId' IS NOT DISTINCT FROM $4::text
      OR record->'capture'->>'variantId' IS NULL)
  ORDER BY (record->'capture'->>'variantId' IS NOT DISTINCT FROM $4::text) DESC,
    record->>'capturedAt' DESC, source_record_id DESC LIMIT 1`;

export const DELIVERY_HOLDS = `
  SELECT DISTINCT 'review' AS kind, record->'failure'->>'operationId' AS "operationId",
    record->'observation'->>'listingId' AS "listingId",
    record->'observation'->>'variantId' AS "variantId"
  FROM review_record WHERE record->'failure'->>'requestId'=$1
    AND record->'observation'->>'sourceId'=$2
    AND record->'failure'->>'stage' IN ('pipeline.product','product.enrich')
  UNION ALL
  SELECT 'pending', subject->>'collectionOperationId', subject->>'listingId', subject->>'variantId'
  FROM product_enrichment_attempt attempt
  WHERE subject->'observation'->>'requestId'=$1 AND subject->'observation'->>'sourceId'=$2
    AND NOT EXISTS (SELECT 1 FROM product_enrichment_subject completed
      WHERE completed.collection_operation_id=attempt.subject->>'collectionOperationId'
        AND completed.channel='dtc' AND completed.listing_id=attempt.subject->>'listingId'
        AND completed.variant_id IS NOT DISTINCT FROM attempt.subject->>'variantId')`;
