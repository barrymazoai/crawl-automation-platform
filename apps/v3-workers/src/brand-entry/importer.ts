import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { ManifestSchema, OutcomeSchema, safeCode, type Outcome } from './contracts.js';
import { LocalEvidence, readJson, createJson, digest } from './local-store.js';
import { verifiedProofs } from './proofs.js';
import { seedBrand, storeEntryUrl } from '../../../../packages/v3-channels/src/amazon-brand-entry.js';

export function importedBrandId(out: Outcome) {
  if (out.seed!.candidate.existingBrandIds.length > 1) throw Error('BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS');
  if (out.seed!.candidate.existingBrandIds.length) return out.seed!.candidate.existingBrandIds[0]!;
  const h = digest(`brand-entry:${out.campaignId}:${out.candidateId}`).slice(0, 32).split(''); h[12] = '8'; h[16] = '8';
  const value = h.join(''); return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}
export async function validateLocalResult(root: string, out: Outcome) {
  const store = new LocalEvidence(join(root, 'evidence'));
  for (const ref of verifiedProofs(out)) await store.read(ref);
  const seed = out.seed!, parsed = seedBrand(new TextDecoder('utf-8', { fatal: true }).decode(await store.read(seed.original)), seed.asin, seed.productUrl);
  if (parsed.name !== seed.name || parsed.brandRaw !== seed.brandRaw || parsed.storeUrl !== seed.storeUrl) throw Error('BRAND_ENTRY.SEED_IDENTITY');
  const receipt = JSON.parse((await store.read(seed.receipt)).toString('utf8'));
  if (!isDeepStrictEqual(receipt.original, seed.original) || receipt.capturedAt !== seed.capturedAt || receipt.status !== 200) throw Error('BRAND_ENTRY.SEED_EVIDENCE');
}
/** Only appends verified Brand/source configuration; no schema, queue or product changes. */
export class LocalBrandImporter {
  constructor(private readonly db: pg.Pool) {}
  async existing(out: Outcome) {
    const brandId = importedBrandId(out), urls = out.directories.map(x => storeEntryUrl(x.url));
    const brand = (await this.db.query('SELECT id,name,note,revision FROM brand WHERE id=$1', [brandId])).rows[0];
    const sources = (await this.db.query("SELECT id,url,enabled,revision FROM brand_source WHERE brand_id=$1 AND channel='amazon' AND region='US' AND url=ANY($2::text[])", [brandId, urls])).rows;
    return { brandId, brand, sources, urls, complete: Boolean(brand) && new Set(sources.map(x => x.url)).size === new Set(urls).size };
  }
  async apply(out: Outcome) {
    verifiedProofs(out);
    const seed = out.seed!, id = importedBrandId(out), c = await this.db.connect();
    try {
      await c.query('BEGIN'); await c.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,73110325))', [seed.name.toLowerCase()]);
      const current = (await c.query('SELECT id,name,note FROM brand WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (seed.candidate.existingBrandIds.length) {
        if (!current) throw Error('BRAND_ENTRY.BRAND_MISSING');
        if (seed.candidate.existingBrandNames.length && !seed.candidate.existingBrandNames.includes(current.name)) throw Error('BRAND_ENTRY.BRAND_CHANGED');
      } else {
        const note = `Amazon Brand entry preparation ${out.campaignId}/${out.candidateId}; result ${digest(JSON.stringify(out))}`;
        if (current) { if (current.name !== seed.name || current.note !== note) throw Error('BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS'); }
        else {
          if ((await c.query('SELECT 1 FROM brand WHERE lower(name)=lower($1)', [seed.name])).rowCount) throw Error('BRAND_ENTRY.BRAND_NAME_CONFLICT');
          await c.query('INSERT INTO brand(id,name,note) VALUES($1,$2,$3)', [id, seed.name, note]);
        }
      }
      const sourceIds: string[] = [];
      for (const directory of out.directories) {
        const url = storeEntryUrl(directory.url);
        await c.query("INSERT INTO brand_source(brand_id,channel,region,url,enabled) VALUES($1,'amazon','US',$2,false) ON CONFLICT (brand_id,region,url) DO NOTHING", [id, url]);
        const source = (await c.query("SELECT id,channel FROM brand_source WHERE brand_id=$1 AND region='US' AND url=$2", [id, url])).rows[0];
        if (!source || source.channel !== 'amazon') throw Error('BRAND_ENTRY.SOURCE_CONFLICT');
        sourceIds.push(source.id);
      }
      await c.query('COMMIT'); return { brandId: id, sourceIds };
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
}
async function main() {
  const [command, rawRoot, configFile, identityMapFile] = process.argv.slice(2);
  if (!['preview', 'apply'].includes(command ?? '') || !rawRoot || !configFile) throw Error('BRAND_ENTRY.IMPORT_ARGUMENTS');
  const root = resolve(rawRoot), manifest = ManifestSchema.parse(await readJson(join(root, 'manifest.json')));
  // Private legacy identifiers stay on the primary Mini. Browser inputs carry
  // only public product URLs and opaque random IDs; join them here after return.
  const identities = identityMapFile ? await readJson(resolve(identityMapFile)) : null;
  const config = await readJson(resolve(configFile)), database = config.database ?? config;
  const db = new pg.Pool({ connectionString: database.connectionString, ssl: database.tls ? { rejectUnauthorized: true } : false, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    const identity = (await db.query('SELECT current_database() name')).rows[0].name;
    if (!['crawler_v3_dev', 'crawler_v3_test'].includes(identity)) throw Error('BRAND_ENTRY.DATABASE_IDENTITY');
    const importer = new LocalBrandImporter(db), rows = [];
    const beforeFile = join(root, 'import-before.json');
    if (command === 'apply') {
      try { await fs.access(beforeFile); } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
        const ids = manifest.candidates.flatMap(x => identities ? identities[x.companyId]?.existingBrandIds ?? [] : x.existingBrandIds);
        await createJson(beforeFile, { at: new Date().toISOString(), campaignId: manifest.campaignId,
          brands: (await db.query('SELECT * FROM brand WHERE id=ANY($1::uuid[])', [ids])).rows,
          sources: (await db.query('SELECT * FROM brand_source WHERE brand_id=ANY($1::uuid[])', [ids])).rows });
      }
    }
    for (const candidate of manifest.candidates) {
      let out: Outcome;
      try { out = OutcomeSchema.parse(await readJson(join(root, 'results', `${candidate.companyId}.json`))); }
      catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
      if (out.campaignId !== manifest.campaignId || out.candidateId !== candidate.companyId) throw Error('BRAND_ENTRY.RESULT_IDENTITY');
      if (out.state !== 'verified') { rows.push({ id: candidate.companyId, state: out.state, code: out.code }); continue; }
      if (!isDeepStrictEqual(candidate, out.seed?.candidate)) throw Error('BRAND_ENTRY.SEED_IDENTITY');
      await validateLocalResult(root, out);
      if (identities) {
        const identity = identities[candidate.companyId];
        if (!identity || !identity.amazonListings.some((x: any) => x.asin === out.seed!.asin)) throw Error('BRAND_ENTRY.PRIVATE_MAPPING_MISMATCH');
        out = structuredClone(out);
        out.seed!.candidate.existingBrandIds = identity.existingBrandIds;
        out.seed!.candidate.existingBrandNames = identity.existingBrandNames;
      }
      if (out.seed!.candidate.existingBrandIds.length > 1) { rows.push({ id: candidate.companyId, state: 'review', code: 'BRAND_ENTRY.BRAND_IDENTITY_AMBIGUOUS' }); continue; }
      const resultHash = digest(JSON.stringify(out)), receiptFile = join(root, 'import-receipts', `${candidate.companyId}.json`);
      let prior; try { prior = await readJson(receiptFile); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (prior) { if (prior.resultHash !== resultHash) throw Error('BRAND_ENTRY.RESULT_CONFLICT'); rows.push(prior); continue; }
      const existing = await importer.existing(out);
      if (command === 'preview') { rows.push({ id: candidate.companyId, name: out.seed!.name, brandId: existing.brandId, newBrand: !existing.brand, newDirectories: existing.urls.filter(x => !existing.sources.some(s => s.url === x)), alreadyConfigured: existing.complete }); continue; }
      const attemptFile = join(root, 'import-attempts', `${candidate.companyId}.json`);
      let previous; try { previous = await readJson(attemptFile); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      let receipt: any;
      if (previous) {
        if (previous.resultHash !== resultHash) throw Error('BRAND_ENTRY.RESULT_CONFLICT');
        receipt = { id: candidate.companyId, resultHash, state: existing.complete ? 'imported' : 'unknown', recoveredReadOnly: true, brandId: existing.brandId, sourceIds: existing.sources.map(x => x.id) };
      } else {
        await createJson(attemptFile, { at: new Date().toISOString(), resultHash });
        try { receipt = { id: candidate.companyId, resultHash, state: 'imported', ...await importer.apply(out) }; }
        catch (e) { const settled = await importer.existing(out);
          receipt = settled.complete ? { id: candidate.companyId, resultHash, state: 'imported', recoveredReadOnly: true, brandId: settled.brandId, sourceIds: settled.sources.map(x => x.id) }
            : { id: candidate.companyId, resultHash, state: 'review', code: safeCode(e) }; }
      }
      await createJson(receiptFile, receipt); rows.push(receipt);
    }
    console.log(JSON.stringify({ campaignId: manifest.campaignId, command, results: rows }));
  } finally { await db.end(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(safeCode(e)); process.exitCode = 1; });
