// Import verified Amazon Brand addresses into Server 1 (brand / brand_source only).
//   node apps/v3-workers/scripts/import-brand-urls.mjs preview|apply <run-name> <rows.json> <out-dir>
// rows: [{ companyId, companyName, amazonBrand, kind, url }]. Each row adds one disabled amazon/US
// brand_source. The brand is the one whose note carries the company ID, else the single brand with
// the same name (case-insensitive), else a new brand under our company name with a traceable note.
// Preview rolls back; apply writes before.json first. Nothing else changes.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import pg from 'pg';

const [mode, run, rowsFile, out] = process.argv.slice(2);
if (!['preview', 'apply'].includes(mode) || !/^[a-z0-9-]{8,80}$/.test(run ?? '') || !rowsFile || !out) {
  throw Error('Usage: import-brand-urls.mjs preview|apply <run-name> <rows.json> <out-dir>');
}
const rows = JSON.parse(fs.readFileSync(rowsFile, 'utf8'));
const deployment = JSON.parse(fs.readFileSync('/Users/server/apps/crawler-v3/live/deployment.json', 'utf8'));
const digest = s => createHash('sha256').update(s).digest('hex');
const newId = r => {
  const h = digest(`brand-entry:${run}:${r.companyId}`).slice(0, 32).split(''); h[12] = '8'; h[16] = '8'; const v = h.join('');
  return [v.slice(0, 8), v.slice(8, 12), v.slice(12, 16), v.slice(16, 20), v.slice(20)].join('-');
};
const valid = n => typeof n === 'string' && n.length >= 1 && n.length <= 80 && n === n.trim();
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const db = new pg.Client({ connectionString: deployment.database.connectionString });
await db.connect();
const totalsSql = "SELECT (SELECT count(*) FROM brand)::int brands,(SELECT count(*) FROM brand_source WHERE channel='amazon')::int amazon_sources,(SELECT count(*) FROM brand_source WHERE channel='amazon' AND enabled)::int enabled_amazon";

async function resolveBrand(r) {
  const byCompany = (await db.query('SELECT id FROM brand WHERE note LIKE $1', [`%${r.companyId}%`])).rows;
  if (byCompany.length === 1) return { id: byCompany[0].id, how: 'company-id-in-note' };
  if (byCompany.length > 1) return { skip: 'COMPANY_ID_AMBIGUOUS' };
  const name = valid(r.companyName) ? r.companyName : valid(r.amazonBrand) ? r.amazonBrand : null;
  const byName = (await db.query('SELECT id FROM brand WHERE lower(name)=lower($1) OR lower(name)=lower($2)', [name ?? '', r.amazonBrand ?? ''])).rows;
  if (byName.length === 1) return { id: byName[0].id, how: 'same-name' };
  if (byName.length > 1) return { skip: 'BRAND_NAME_AMBIGUOUS' };
  if (!name) return { skip: 'BRAND_NAME_INVALID' };
  return { id: newId(r), how: 'created', name };
}

if (mode === 'apply' && !fs.existsSync(out + '/before.json')) {
  const before = { at: new Date().toISOString(), totals: (await db.query(totalsSql)).rows[0],
    sources: (await db.query("SELECT * FROM brand_source WHERE url = ANY($1)", [rows.map(r => r.url)])).rows };
  fs.writeFileSync(out + '/before.json', JSON.stringify(before), { flag: 'wx', mode: 0o600 });
}
const result = { attached: [], created: [], sourcesAdded: 0, alreadyPresent: 0, skipped: [] };
await db.query('BEGIN');
try {
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  for (const r of rows) {
    const b = await resolveBrand(r);
    if (b.skip) { result.skipped.push({ ...r, why: b.skip }); continue; }
    if (b.how === 'created') {
      const note = `Amazon Brand URL import ${run}; Amazon brand ${r.amazonBrand ?? ''}; ${r.kind}。旧来源公司编号：${r.companyId}`;
      const cur = (await db.query('SELECT name FROM brand WHERE id=$1', [b.id])).rows[0];
      if (!cur) { await db.query('INSERT INTO brand(id,name,note) VALUES($1,$2,$3)', [b.id, b.name, note]); result.created.push({ id: b.id, name: b.name, companyId: r.companyId }); }
      else if (cur.name !== b.name) { result.skipped.push({ ...r, why: 'BRAND_ID_CONFLICT' }); continue; }
    } else result.attached.push({ id: b.id, how: b.how, companyId: r.companyId });
    const ins = await db.query("INSERT INTO brand_source(brand_id,channel,region,url,enabled) VALUES($1,'amazon','US',$2,false) ON CONFLICT (brand_id,region,url) DO NOTHING", [b.id, r.url]);
    if (ins.rowCount) result.sourcesAdded++; else result.alreadyPresent++;
    const s = (await db.query("SELECT channel FROM brand_source WHERE brand_id=$1 AND region='US' AND url=$2", [b.id, r.url])).rows[0];
    if (!s || s.channel !== 'amazon') throw Error('SOURCE_CONFLICT ' + r.companyId);
  }
  const totals = (await db.query(totalsSql)).rows[0];
  if (mode === 'apply') await db.query('COMMIT'); else await db.query('ROLLBACK');
  const summary = { mode, run, at: new Date().toISOString(), rows: rows.length, brandsAttached: result.attached.length,
    attachedHow: result.attached.reduce((a, s) => (a[s.how] = (a[s.how] || 0) + 1, a), {}), brandsCreated: result.created.length,
    sourcesAdded: result.sourcesAdded, alreadyPresent: result.alreadyPresent, skipped: result.skipped.length,
    skippedWhy: result.skipped.reduce((a, s) => (a[s.why] = (a[s.why] || 0) + 1, a), {}), totalsAfter: totals };
  fs.writeFileSync(out + `/${mode}.json`, JSON.stringify({ ...summary, attached: result.attached, created: result.created, skipped: result.skipped }, null, 1), { mode: 0o600 });
  console.log(JSON.stringify(summary));
} catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; } finally { await db.end(); }
