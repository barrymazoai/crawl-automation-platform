/**
 * Settled, completed marketplace products, the latest queue item per listing/variant chosen BEFORE completion
 * filtering (no fallback to an older success). A follower shares its leader's run and receipt, so the receipt is
 * joined by run (review 2026-10-12). `material_at` is when the product's material last changed: its settlement, and
 * for Whole Foods also the latest settled Amazon run of the same ASIN, whose label it carries.
 */
export function settledMarketplace(channelFilter: string) {
  return `
  latest AS (
    SELECT DISTINCT ON (q.channel, q.listing_id, q.variant_id) q.*
    FROM queue_item q WHERE ${channelFilter}
    ORDER BY q.channel, q.listing_id, q.variant_id, q.created_at DESC, q.item_id DESC),
  done AS (
    SELECT q.item_id, q.channel, q.listing_id, q.variant_id, q.url, q.run_id, q.source_id, s.brand_id,
      b.name AS brand,
      -- A follower carries its leader's run, whose archives sit under the leader's source and URL.
      coalesce(leader.source_id, q.source_id) AS material_source_id, coalesce(leader.url, q.url) AS material_url,
      greatest(a.settled_at, CASE WHEN q.channel = 'wholefoods' THEN (
        SELECT max(aa.settled_at) FROM queue_item qa
        JOIN queue_attempt aa ON aa.run_id = qa.run_id AND aa.channel = 'amazon'
        WHERE qa.channel = 'amazon' AND qa.listing_id = q.listing_id AND qa.state = 'completed'
          AND aa.outcome = 'completed') END) AS material_at
    FROM latest q JOIN brand_source s ON s.id = q.source_id AND s.channel = q.channel
    JOIN brand b ON b.id = s.brand_id
    JOIN queue_attempt a ON a.run_id = q.run_id AND a.channel = q.channel
    LEFT JOIN queue_item leader ON leader.item_id = q.follows_item_id AND leader.run_id = q.run_id
    WHERE q.state = 'completed' AND a.settled_at IS NOT NULL AND a.outcome = 'completed'
      -- A revisit that found the page gone completes too; it is a delisting, never a product to send.
      AND NOT EXISTS (SELECT 1 FROM listing_state_observation o
        WHERE o.run_id = q.run_id AND o.state = 'unlisted'))`;
}

/**
 * Still to send (migrations 060/061): the brand has a matched company and no ledger outcome (present, sent,
 * verified, failed) is newer than the material. A failure or an unknown attempt waits for the next capture.
 */
export const PENDING_SYNC = `
  EXISTS (SELECT 1 FROM supply_smart_brand_company m WHERE m.brand_id = d.brand_id AND m.status = 'matched')
  AND NOT EXISTS (SELECT 1 FROM product_sync ps
    WHERE ps.channel = d.channel AND ps.listing_id = d.listing_id AND ps.variant_key = coalesce(d.variant_id, '')
      AND ps.status <> 'waiting_company' AND ps.material_at >= d.material_at)`;

export const MARKETPLACE_QUEUE = `
  WITH ${settledMarketplace("q.channel = $1")}
  SELECT d.item_id, d.listing_id, d.variant_id, d.material_url AS url, d.run_id::text,
    d.material_source_id::text AS source_id, d.brand_id::text, d.brand,
    -- Text keeps PostgreSQL's microseconds; a JavaScript Date would drop them and break the watermark comparison.
    d.material_at::text AS material_at
  FROM done d
  WHERE ($2::text IS NULL OR (d.listing_id, coalesce(d.variant_id, '')) > ($2, coalesce($3::text, '')))
    AND (NOT $5::boolean OR (${PENDING_SYNC}))
  ORDER BY d.listing_id, coalesce(d.variant_id, '') LIMIT $4`;

export const MARKETPLACE_HISTORY = `
  SELECT record, body_hash FROM product_history_source
  WHERE record->>'codec'='v3-capture-history/1'
    AND record->'listing'->>'channel'=$1
    AND record->'owner'->>'runId'=$2 AND record->'owner'->>'sourceId'=$3
    AND split_part(record->'listing'->>'url','?',1)=split_part($4::text,'?',1)
    AND record->'capture'->>'variantId' IS NOT DISTINCT FROM $5::text
  ORDER BY record->>'capturedAt' DESC, source_record_id DESC LIMIT 1`;

export const MARKETPLACE_COLLECTION = `
  SELECT DISTINCT ON (record->'observation'->>'listingId', record->'observation'->>'variantId')
    operation_id, observation_id, record_hash, record FROM collected_product
  WHERE record->'observation'->>'requestId'=$1 AND record->'observation'->>'sourceId'=$2
    AND record->>'codec' IN ('collected-product/3','collected-product/4','collected-product/5')
    AND ($3::text IS NULL OR record->'observation'->>'variantId'=$3)
  ORDER BY record->'observation'->>'listingId', record->'observation'->>'variantId',
    collected_at DESC, operation_id DESC LIMIT 2`;

/** Read the exact operation returned by FormulaLookup, including its actual owning channel. */
export const MARKETPLACE_LINKED_COLLECTION = `
  SELECT p.operation_id, p.observation_id, p.record_hash, p.record, s.channel, p.collected_at
  FROM collected_product p JOIN brand_source s
    ON s.id::text=p.record->'observation'->>'sourceId'
    AND s.brand_id::text=p.record->'observation'->>'brandId'
  WHERE p.operation_id=$1`;
