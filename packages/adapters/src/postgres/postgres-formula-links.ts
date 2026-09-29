import { formulaErrors, type FormulaLink, type FormulaLinks } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { hashString } from "@crawl-automation/processing";

const INSERT = `
  INSERT INTO formula_link (link_id, channel, listing_id, variant_id, formula_operation_id,
                            sibling_listing_id, sibling_variant_id, evidence, record_hash, run_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
  ON CONFLICT DO NOTHING`;

const READ = `
  SELECT link_id, channel, listing_id, variant_id, formula_operation_id, sibling_listing_id,
         sibling_variant_id, evidence, run_id, record_hash
    FROM formula_link WHERE link_id = $1`;

interface LinkRow {
  link_id: string;
  channel: string;
  listing_id: string;
  variant_id: string | null;
  formula_operation_id: string;
  sibling_listing_id: string;
  sibling_variant_id: string | null;
  evidence: Record<string, unknown>;
  run_id: string;
  record_hash: string;
}

/** What makes two links the same link: everything but the run that wrote it. */
const linkHash = (link: FormulaLink) =>
  hashString(
    JSON.stringify([
      link.channel,
      link.listingId,
      link.variantId,
      link.formulaOperationId,
      link.sibling,
    ]),
  );

function fromRow(row: LinkRow): FormulaLink {
  return {
    linkId: row.link_id,
    channel: row.channel,
    listingId: row.listing_id,
    variantId: row.variant_id,
    formulaOperationId: row.formula_operation_id,
    sibling: { listingId: row.sibling_listing_id, variantId: row.sibling_variant_id },
    evidence: row.evidence,
    runId: row.run_id,
  };
}

/** Formula links in `formula_link`: written once and read back; a different stored link is a conflict. */
export class PostgresFormulaLinks implements FormulaLinks {
  constructor(private readonly database: Queryable) {}

  async record(link: FormulaLink): Promise<FormulaLink> {
    const hash = linkHash(link);
    await this.database.query(INSERT, [
      link.linkId,
      link.channel,
      link.listingId,
      link.variantId,
      link.formulaOperationId,
      link.sibling.listingId,
      link.sibling.variantId,
      JSON.stringify(link.evidence),
      hash,
      link.runId,
    ]);
    const rows = await this.database.query<LinkRow>(READ, [link.linkId]);
    const row = rows[0];
    if (!row || row.record_hash !== hash) {
      throw formulaErrors.create("FORMULA.LINK_CONFLICT", {
        details: { linkId: link.linkId, channel: link.channel, listingId: link.listingId },
      });
    }
    return fromRow(row);
  }
}
