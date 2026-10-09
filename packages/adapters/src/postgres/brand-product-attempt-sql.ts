/** The retry reservation counts even before analysis/sources have been saved. */
export const latestProductAttemptSql = `
  SELECT COALESCE(max(substring(step FROM
    '^(?:product-analysis|product-sources|products|products-failure|products-retry)@([1-9][0-9]*)$')::int), 1) AS attempt
  FROM brand_enrichment_step WHERE run_id = `;
