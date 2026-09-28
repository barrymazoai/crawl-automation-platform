// Builds a brand scan manifest from a site's own brand list ([{ name, url }], e.g. the saved GNC /department/brands/ or
// Swanson /pages/brands links). --site gnc (default) -> gnc-brand-scan/1, --site swanson -> swanson-brand-scan/1.
// Public names and URLs only; no database. Writes manifest.json and brands.json (id -> name, url).
//   node gnc-scan-manifest.mjs <brands.json> <run-dir> [--site gnc|swanson] [--brands "a|b"] [--limit N] [--concurrency 10] [--max-pages 5]
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gncScanAddress } from '../../../../packages/v3-channels/src/gnc-brand-scan.mjs';
import { swansonScanAddress } from '../../../../packages/v3-channels/src/swanson-brand-scan.mjs';

const args = process.argv.slice(2), [listFile, dir] = args;
const opt = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const concurrency = Number(opt('--concurrency', '10')), maxPages = Number(opt('--max-pages', '5')), limit = opt('--limit') === null ? null : Number(opt('--limit'));
const site = opt('--site', 'gnc'), address = { gnc: gncScanAddress, swanson: swansonScanAddress }[site];
if (!address) throw Error('--site must be gnc or swanson');
const only = opt('--brands')?.split('|').map(s => s.trim().toLowerCase()).filter(Boolean) ?? null;
if (!listFile || !dir || !(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 50) || !(Number.isInteger(maxPages) && maxPages >= 1 && maxPages <= 50))
  throw Error('Usage: gnc-scan-manifest.mjs <brands.json> <run-dir> [--site gnc|swanson] [--brands "a|b"] [--limit N] [--concurrency 1-50] [--max-pages 1-50]');
if (fs.existsSync(dir + '/manifest.json')) throw Error('Run directory already has a manifest: ' + dir);
const clean = n => String(n).normalize('NFKC').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
const seen = new Set(), brands = [], skipped = [];
for (const b of JSON.parse(fs.readFileSync(listFile, 'utf8'))) {
  let url; try { url = address(b.url).url; } catch { skipped.push({ name: b.name, url: b.url, reason: `not a ${site} brand page` }); continue; }
  if (seen.has(url)) continue; seen.add(url);
  const name = clean(b.name);
  if (only && !only.includes(name.toLowerCase()) && !only.includes(address(url).slug)) continue;
  brands.push({ id: randomUUID(), name, url });
}
const chosen = limit === null ? brands : brands.slice(0, limit);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(dir + '/manifest.json', JSON.stringify({ codec: `${site}-brand-scan/1`, concurrency, maxPages, createdAt: new Date().toISOString(),
  candidates: chosen.map(({ id, url }) => ({ id, url })) }, null, 1), { flag: 'wx', mode: 0o600 });
fs.writeFileSync(dir + '/brands.json', JSON.stringify(Object.fromEntries(chosen.map(({ id, name, url }) => [id, { name, url }])), null, 1), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ listed: brands.length + skipped.length, usable: brands.length, selected: chosen.length, skipped: skipped.length, concurrency, maxPages, maxRequests: chosen.length * maxPages }));
