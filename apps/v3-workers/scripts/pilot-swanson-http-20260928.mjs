// Manual, Server 一 only (user 2026-09-28: "redeploy it and start the Swanson worker, then run a pilot").
// Healthy Origins through Swanson product capture over ScraperAPI (static HTML, archived before parsing), products from
// the products.json brand scan, formula from the page's own facts text (text-facts-first/1). Each step is run by hand:
//   node pilot-swanson-http-20260928.mjs source                 create + enable the Healthy Origins Swanson brand source (web API)
//   node pilot-swanson-http-20260928.mjs config <scan-result>   write the pilot's private config (stays on Server 一)
//   node pilot-swanson-http-20260928.mjs switch [--write]       move the 29 Swanson-session jobs to this release (backups first)
//   node pilot-swanson-http-20260928.mjs start                  set the switched jobs' build ids and start them (stops at the first failure)
//   node pilot-swanson-http-20260928.mjs remove-web [--write]   stop brand-web and remove it from the deployment (user request)
//   node pilot-swanson-http-20260928.mjs submit                 one collection submission for the pilot source
//   node pilot-swanson-http-20260928.mjs deliver                start the submission's workflow directly (no brand-web)
//   node pilot-swanson-http-20260928.mjs status                 progress of the pilot submission
// Rollback of `switch`: copy manual-releases/swanson-http-20260928/switch/*.before* back, then stop/start the same jobs.
import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import { createHash } from 'node:crypto';
import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const pg = createRequire(import.meta.url)('pg');
const root = '/Users/server/apps/crawler-v3', out = root + '/manual-releases/swanson-http-20260928', manifestPath = root + '/live/deployment.json';
const release = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // <release>/source
const dist = release + '/apps/v3-workers/dist/ocr-cloud';
const OLD_CONFIG = root + '/manual-releases/local-temporal-20260923/config-93-swanson.private.json', NEW_CONFIG = out + '/config-swanson-http.private.json';
const BRAND = { id: '8caf4486-e541-45c9-938c-28efe301fa92', name: 'Healthy Origins', url: 'https://www.swansonvitamins.com/collections/brand-healthy-origins' };
const SESSION = 'swanson-acg-resident-v1';
const [cmd, arg] = process.argv.slice(2), write = process.argv.includes('--write');
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sha = s => createHash('sha256').update(s).digest('hex');
const uuid = s => { const h = sha(s).slice(0, 32).split(''); h[12] = '4'; h[16] = '8'; const v = h.join(''); return [v.slice(0, 8), v.slice(8, 12), v.slice(12, 16), v.slice(16, 20), v.slice(20)].join('-'); };
// brand-web (the only API) was removed from the deployment on user request; API calls exist only for `source`/`submit`.
const webConfig = () => { const j = m.jobs.find(x => x.id === 'brand-web'); if (!j) throw Error('brand-web was removed; this step needs its API');
  return JSON.parse(fs.readFileSync(j.env.V3_BRAND_WEB_CONFIG, 'utf8')); };
// The workers' artifactBuildId: every .js (plus the workflow bundle) in sorted order, each as `<length>:` then its bytes.
// (The first version of this script hashed file names too, so the switched jobs refused to start; `start` repairs that.)
const buildOf = dir => execFileSync('/usr/bin/python3', ['-c', `import hashlib,os\nh=hashlib.sha256()\nfor n in sorted(x for x in os.listdir(${JSON.stringify(dir)}) if x.endswith('.js') or x=='product-workflows.cjs'):\n b=open(os.path.join(${JSON.stringify(dir)},n),'rb').read();h.update((str(len(b))+':').encode());h.update(b)\nprint(h.hexdigest())`], { encoding: 'utf8' }).trim();
const ctl = (c, id) => { try { return JSON.parse(execFileSync(m.node, [root + '/manual-control.mjs', c, id], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop()); }
  catch (e) { const t = String(e.stdout ?? '').trim().split('\n').pop(); try { return JSON.parse(t); } catch { throw e; } } };
async function api(path, method = 'GET', body, key) {
  // brand-web accepts only its local workspace client (it adds the Bearer token itself); writes carry its own Origin.
  const origin = `http://127.0.0.1:${webConfig().port}`;
  const r = await fetch(`${origin}/api/v3${path}`, { method, headers: { 'X-V3-Client': 'local-workspace', ...(method !== 'GET' ? { Origin: origin } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const v = await r.json().catch(() => null); if (!r.ok) throw Error(`API ${r.status} ${JSON.stringify(v)}`); return v;
}
// Read-only database lookup, so config/status work without the API.
const findSource = async () => { const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
  try { return (await db.query("SELECT id, channel, url, enabled, revision FROM brand_source WHERE brand_id=$1 AND channel='swanson' AND url=$2", [BRAND.id, BRAND.url])).rows[0] ?? null; }
  finally { await db.end(); } };
fs.mkdirSync(out, { recursive: true, mode: 0o700 });

if (cmd === 'source') {
  let s = await findSource();
  if (!s) s = await api(`/brands/${BRAND.id}/sources`, 'POST', { channel: 'swanson', region: 'US', url: BRAND.url }, uuid('swanson-http-20260928:create-source'));
  if (!s.enabled) s = await api(`/brands/${BRAND.id}/sources/${s.id}/enabled`, 'PATCH', { enabled: true, revision: s.revision }, uuid('swanson-http-20260928:enable-source:' + s.revision));
  console.log(JSON.stringify({ source: { id: s.id, channel: s.channel, url: s.url, enabled: s.enabled, revision: s.revision } }));
} else if (cmd === 'config') {
  // Scan result (swanson-brand-scan-result/1) for Healthy Origins: every product page /p/<handle>, newest first.
  const scan = JSON.parse(fs.readFileSync(arg, 'utf8'));
  if (scan.codec !== 'swanson-brand-scan-result/1' || scan.state !== 'complete' || !/brand-healthy-origins/.test(scan.url)) throw Error('Healthy Origins scan result required');
  const urls = scan.ids.map(id => scan.items[id].url);
  if (!urls.length || urls.length > 100 || new Set(urls).size !== urls.length) throw Error('unexpected product list');
  const s = await findSource(); if (!s?.enabled) throw Error('run `source` first');
  const old = JSON.parse(fs.readFileSync(OLD_CONFIG, 'utf8'));
  const amazon = JSON.parse(fs.readFileSync(m.jobs.find(j => j.env?.V3_AMAZON_LIVE_CONFIG).env.V3_AMAZON_LIVE_CONFIG, 'utf8'));
  if (amazon.capture?.mode !== 'scraperapi') throw Error('Amazon ScraperAPI route not found');
  const { browser: _browser, ...base } = old;
  const config = { ...base, scope: { brandId: BRAND.id, sourceId: s.id, channel: 'swanson', region: 'US', rootUrl: BRAND.url, scopeVersion: `source-revision-${s.revision}` },
    brandName: BRAND.name, egressId: amazon.egressId,
    capture: { mode: 'scraperapi', route: amazon.capture.route, scraperApi: { apiKey: amazon.capture.scraperApi.apiKey, allowedOrigins: ['https://www.swansonvitamins.com'] }, dns: amazon.capture.dns ?? 'system' },
    factsPolicy: 'text-facts-first/1', productList: { codec: 'swanson-product-list/1', urls } };
  fs.writeFileSync(NEW_CONFIG, JSON.stringify(config, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ written: NEW_CONFIG, products: urls.length, scope: config.scope, egressId: config.egressId, browserResource: config.browserResource }));
} else if (cmd === 'switch') {
  const map = [[/\/channel-label-worker\.js$/, dist + '/label/channel-label-worker.js'], [/\/channel-plan-worker\.js$/, dist + '/plan/channel-plan-worker.js'],
    [/\/swanson-live-worker\.js$/, dist + '/swanson/swanson-live-worker.js'], [/\/product-workflow-worker\.js$/, dist + '/workflow/product-workflow-worker.js']];
  const readCfg = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const jobs = m.jobs.filter(j => { const c = j.env?.V3_WORKER_CONFIG ? readCfg(j.env.V3_WORKER_CONFIG) : null; return JSON.stringify(j).includes(SESSION) || JSON.stringify(c ?? '').includes(SESSION); });
  if (jobs.length !== 29) throw Error(`expected 29 jobs of session ${SESSION}, got ${jobs.length}`);
  const plan = jobs.map(j => {
    const target = map.find(([re]) => re.test(j.entry))?.[1]; if (!target || !fs.existsSync(target)) throw Error('no new entry for ' + j.id);
    return { id: j.id, cfg: j.env?.V3_WORKER_CONFIG ?? null, swanson: !!j.env?.V3_SWANSON_LIVE_CONFIG, oldEntry: j.entry, newEntry: target, newBuild: buildOf(dirname(target)) };
  });
  if (!fs.existsSync(NEW_CONFIG)) throw Error('run `config` first');
  const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
  const held = (await db.query("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL AND (request::text LIKE '%swanson%' OR request::text LIKE $1)", [`%${SESSION}%`])).rows[0].n; await db.end();
  if (held) throw Error(`Swanson session busy: ${held} held permits`);
  console.log(JSON.stringify({ jobs: plan.length, byEntry: plan.reduce((a, p) => (a[p.newEntry.split('/ocr-cloud/')[1]] = (a[p.newEntry.split('/ocr-cloud/')[1]] ?? 0) + 1, a), {}), write }));
  if (!write) process.exit(0);
  const sw = out + '/switch'; fs.mkdirSync(sw, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifestPath, sw + '/deployment.before.json', fs.constants.COPYFILE_EXCL);
  for (const p of plan) if (p.cfg) fs.copyFileSync(p.cfg, sw + '/' + p.id + '.config.before.json', fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(sw + '/plan.json', JSON.stringify(plan, null, 1), { flag: 'wx' });
  for (const p of plan) ctl('stop', p.id);
  for (const p of plan) if (p.cfg) { const c = JSON.parse(fs.readFileSync(p.cfg, 'utf8')); c.expectedBuildId = p.newBuild; fs.writeFileSync(p.cfg + '.next', JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(p.cfg + '.next', p.cfg); }
  for (const j of m.jobs) { const p = plan.find(x => x.id === j.id); if (!p) continue; j.entry = p.newEntry; if (p.swanson) j.env.V3_SWANSON_LIVE_CONFIG = NEW_CONFIG; }
  fs.writeFileSync(manifestPath + '.next', JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(manifestPath + '.next', manifestPath);
  const started = []; for (const p of plan) { const s = ctl('start', p.id); started.push({ id: p.id, ready: s.jobs?.find(x => x.id === p.id)?.ready ?? null }); }
  fs.writeFileSync(sw + '/started.json', JSON.stringify({ at: new Date().toISOString(), started }, null, 1));
  console.log(JSON.stringify({ started: started.length, notReady: started.filter(s => !s.ready).map(s => s.id) }));
} else if (cmd === 'start') {
  // After `switch`: set each switched job's expectedBuildId from its current (new) entry, then start them in order,
  // stopping at the first job that does not come up. Configs were already backed up by `switch`.
  const plan = JSON.parse(fs.readFileSync(out + '/switch/plan.json', 'utf8'));
  const started = [];
  for (const p of plan) {
    const j = m.jobs.find(x => x.id === p.id); if (!j || j.entry !== p.newEntry) throw Error('job not switched: ' + p.id);
    if (p.cfg) { const c = JSON.parse(fs.readFileSync(p.cfg, 'utf8')), id = buildOf(dirname(p.newEntry));
      if (c.expectedBuildId !== id) { c.expectedBuildId = id; fs.writeFileSync(p.cfg + '.next', JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(p.cfg + '.next', p.cfg); } }
    // A failed start leaves the service loaded-but-exited; the control tool starts only an explicitly stopped service.
    ctl('stop', p.id);
    const s = ctl('start', p.id), ready = s.jobs?.find(x => x.id === p.id)?.ready ?? false;
    started.push({ id: p.id, ready });
    if (!ready) break;
  }
  fs.writeFileSync(out + '/switch/started.json', JSON.stringify({ at: new Date().toISOString(), started }, null, 1));
  console.log(JSON.stringify({ started: started.filter(s => s.ready).length, of: plan.length, notReady: started.filter(s => !s.ready).map(s => s.id) }));
} else if (cmd === 'remove-web') {
  // User 2026-09-28: "We don't need any web service, so just remove the web service." Stops brand-web and takes its job
  // out of the deployment (its config stays: the Amazon queue CLI reads delivery settings from it). Nothing is deleted.
  const job = m.jobs.find(j => j.id === 'brand-web');
  if (!job) { console.log(JSON.stringify({ removed: false, reason: 'brand-web is not in the deployment' })); process.exit(0); }
  console.log(JSON.stringify({ job: job.id, entry: job.entry, write }));
  if (!write) process.exit(0);
  const dir = out + '/remove-web'; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifestPath, dir + '/deployment.before.json', fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(dir + '/brand-web.job.json', JSON.stringify(job, null, 1), { flag: 'wx', mode: 0o600 });
  const stopped = ctl('stop', 'brand-web');
  const next = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); next.jobs = next.jobs.filter(j => j.id !== 'brand-web');
  fs.writeFileSync(manifestPath + '.next', JSON.stringify(next, null, 2), { mode: 0o600 }); fs.renameSync(manifestPath + '.next', manifestPath);
  console.log(JSON.stringify({ removed: true, stopped: stopped.jobs?.find(j => j.id === 'brand-web') ?? stopped, jobsLeft: next.jobs.length,
    restore: `cp ${dir}/deployment.before.json ${manifestPath} && manual-control.mjs start brand-web` }));
} else if (cmd === 'deliver') {
  // Without brand-web's delivery runner: start the submission's BrandCollectionWorkflow directly, with the same options
  // TemporalGateway used (reject duplicates, no retry/timeout for a brand). An existing execution is only reported.
  const { Client, Connection } = createRequire(import.meta.url)('@temporalio/client');
  const sub = JSON.parse(fs.readFileSync(out + '/submission.json', 'utf8'));
  const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
  const row = (await db.query('SELECT snapshot FROM collection_submission WHERE request_id=$1', [sub.requestId])).rows[0]; await db.end();
  if (!row) throw Error('submission not found');
  const input = { version: 1, requestId: sub.requestId, snapshot: row.snapshot };
  const control = m.jobs.find(j => j.id === 'swanson-control'), rt = JSON.parse(fs.readFileSync(control.env.V3_WORKER_CONFIG, 'utf8')), t = rt.transport;
  const connection = await Connection.connect({ address: rt.address, connectTimeout: '15 seconds', ...(t.mode === 'mtls' ? { tls: { serverNameOverride: t.serverName,
    serverRootCACertificate: fs.readFileSync(t.caFile), clientCertPair: { crt: fs.readFileSync(t.certFile), key: fs.readFileSync(t.keyFile) } } } : {}) });
  try {
    const client = new Client({ connection, namespace: rt.namespace }), workflowId = `v3-collection-${sub.requestId}`;
    const taskQueue = `v3.swanson.control.v1.swanson-live-v1.session.${SESSION}`;
    try { const d = await client.workflow.getHandle(workflowId).describe(); console.log(JSON.stringify({ exists: true, workflowId, status: d.status.name, runId: d.runId })); }
    catch (e) {
      if (e?.name !== 'WorkflowNotFoundError') throw e;
      const h = await client.workflow.start('BrandCollectionWorkflow', { workflowId, taskQueue, args: [input], workflowIdReusePolicy: 'REJECT_DUPLICATE', workflowIdConflictPolicy: 'FAIL' });
      console.log(JSON.stringify({ started: true, workflowId, runId: h.firstExecutionRunId, taskQueue }));
    }
  } finally { await connection.close(); }
} else if (cmd === 'submit') {
  const s = await findSource(); if (!s?.enabled) throw Error('run `source` first');
  const r = await api(`/brands/${BRAND.id}/sources/${s.id}/submissions`, 'POST', { sourceRevision: s.revision }, uuid('swanson-http-20260928:submit:' + s.revision));
  fs.writeFileSync(out + '/submission.json', JSON.stringify(r, null, 1));
  console.log(JSON.stringify(r));
} else if (cmd === 'status') {
  const sub = JSON.parse(fs.readFileSync(out + '/submission.json', 'utf8')), id = sub.requestId;
  const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect(); await db.query('SET default_transaction_read_only = on');
  const q = async (s, v) => (await db.query(s, v)).rows;
  const s = await findSource();
  console.log(JSON.stringify({ requestId: id,
    workflow: (await q("SELECT count(*)::int n FROM catalog_page WHERE catalog_id=$1", [id]))[0].n + ' catalog pages',
    discoveries: (await q('SELECT count(*)::int n FROM catalog_discovery WHERE catalog_id=$1', [id]))[0].n,
    closure: (await q('SELECT status FROM catalog_closure WHERE catalog_id=$1', [id]))[0]?.status ?? null,
    collected: (await q("SELECT count(*)::int n FROM collected_product WHERE record->'observation'->>'sourceId'=$1", [s.id]))[0].n,
    reviews: await q("SELECT record->'failure'->>'code' code, count(*)::int n FROM review_record WHERE record->'observation'->>'sourceId'=$1 GROUP BY 1 ORDER BY 2 DESC", [s.id]),
    heldPermits: (await q("SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL AND request::text LIKE '%swanson%'"))[0].n }));
  await db.end();
} else throw Error('Usage: source | config <scan-result.json> | switch [--write] | start | remove-web [--write] | submit | deliver | status');
