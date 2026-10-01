/** Independent aggregates avoid multiplying credits by activity/capture/attempt joins. */
export const usageSummaryQuery = `
WITH events AS (
  SELECT * FROM usage_event WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
    AND ($3::text IS NULL OR channel=$3)
), costs AS (
  SELECT channel,
    COALESCE(sum(credit_cost) FILTER (WHERE kind IN ('capture','brand-request') AND provider_call),0)::float8 AS credits,
    count(*) FILTER (WHERE kind IN ('capture','brand-request') AND credit_cost IS NULL
      AND (provider_call OR (kind='brand-request' AND cache_hit IS NULL)))::int AS unknown,
    count(*) FILTER (WHERE kind='capture' AND cache_hit)::int AS capture_reuses,
    count(*) FILTER (WHERE kind='model-text' AND provider_call)::int AS text_calls,
    count(*) FILTER (WHERE kind='model-image' AND provider_call)::int AS image_calls,
    count(*) FILTER (WHERE kind='model-enrichment' AND provider_call)::int AS enrichment_calls,
    count(*) FILTER (WHERE kind='ocr' AND provider_call)::int AS ocr_calls,
    count(*) FILTER (WHERE kind='brand-request' AND provider_call)::int AS brand_calls,
    count(*) FILTER (WHERE kind='brand-request' AND cache_hit)::int AS brand_reuses,
    count(*) FILTER (WHERE kind='preparation' AND cache_hit=false)::int AS recomputed,
    count(*) FILTER (WHERE kind='preparation' AND cache_hit)::int AS reused,
    COALESCE(sum(input_tokens) FILTER (WHERE kind LIKE 'model-%'),0)::float8 AS input_tokens,
    COALESCE(sum(output_tokens) FILTER (WHERE kind LIKE 'model-%'),0)::float8 AS output_tokens,
    count(*) FILTER (WHERE kind LIKE 'model-%' AND provider_call
      AND (input_tokens IS NULL OR output_tokens IS NULL))::int AS missing_tokens
  FROM events GROUP BY channel
), captures AS (
  SELECT channel, count(*) FILTER (WHERE state='done' AND NOT reused)::int AS fresh,
    count(*) FILTER (WHERE state='done' AND reused AND NOT EXISTS (
      SELECT 1 FROM usage_event e WHERE e.operation_id=h.operation_id AND e.kind='capture' AND e.cache_hit))::int AS reused
  FROM html_capture h WHERE requested_at >= $1::timestamptz AND requested_at < $2::timestamptz
    AND ($3::text IS NULL OR channel=$3) GROUP BY channel
), unmeasured_captures AS (
  SELECT h.channel, COALESCE(sum(h.credit_cost),0)::float8 AS credits,
    count(*) FILTER (WHERE h.credit_cost IS NULL)::int AS unknown
  FROM html_capture h WHERE h.requested_at >= $1::timestamptz AND h.requested_at < $2::timestamptz
    AND ($3::text IS NULL OR h.channel=$3) AND NOT h.reused AND h.state <> 'in_flight'
    AND NOT EXISTS (SELECT 1 FROM usage_event e
      WHERE e.operation_id=h.operation_id AND e.kind='capture' AND e.provider_call)
  GROUP BY h.channel
), products AS (
  SELECT channel,count(*)::int AS total FROM product_run
  WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
    AND ($3::text IS NULL OR channel=$3) GROUP BY channel
), attempts AS (
  SELECT channel,count(*)::int AS total FROM queue_attempt
  WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
    AND ($3::text IS NULL OR channel=$3) GROUP BY channel
), channels AS (
  SELECT channel FROM costs UNION SELECT channel FROM captures
  UNION SELECT channel FROM products UNION SELECT channel FROM attempts
)
SELECT ch.channel,
  COALESCE(p.total,0) AS products, COALESCE(a.total,0) AS attempts,
  COALESCE(h.fresh,0) AS "freshCaptures", COALESCE(h.reused,0)+COALESCE(c.capture_reuses,0) AS "captureReuses",
  COALESCE(c.credits,0)+COALESCE(u.credits,0) AS credits,
  COALESCE(c.unknown,0)+COALESCE(u.unknown,0) AS "unknownCreditCalls",
  COALESCE(c.text_calls,0) AS "modelTextCalls", COALESCE(c.image_calls,0) AS "modelImageCalls",
  COALESCE(c.enrichment_calls,0) AS "modelEnrichmentCalls", COALESCE(c.ocr_calls,0) AS "ocrCalls",
  COALESCE(c.brand_calls,0) AS "brandRequests", COALESCE(c.brand_reuses,0) AS "brandReuses",
  COALESCE(c.recomputed,0) AS "preparationsRecomputed", COALESCE(c.reused,0) AS "preparationsReused",
  COALESCE(c.input_tokens,0) AS "inputTokens", COALESCE(c.output_tokens,0) AS "outputTokens",
  COALESCE(c.missing_tokens,0) AS "modelCallsWithoutTokens"
FROM channels ch LEFT JOIN costs c USING (channel) LEFT JOIN captures h USING (channel)
LEFT JOIN products p USING (channel) LEFT JOIN attempts a USING (channel)
LEFT JOIN unmeasured_captures u USING (channel)
WHERE ch.channel IS NOT NULL ORDER BY ch.channel`;

export const usageStepQuery = `
SELECT channel,step,kind,count(*)::int AS samples,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS "medianMs",
  percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS "p90Ms"
FROM usage_event WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
  AND ($3::text IS NULL OR channel=$3) AND channel IS NOT NULL
GROUP BY channel,step,kind ORDER BY channel,kind,step`;
