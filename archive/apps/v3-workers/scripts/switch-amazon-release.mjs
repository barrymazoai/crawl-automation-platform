// Manual, one shot per deploy: move the Amazon roles and the queue runner from one git-cloned release to another.
//   node apps/v3-workers/scripts/switch-amazon-release.mjs <from-release> <to-release>
// e.g. main-20260928 main-20260928b. Roles: 7 amazon-live, 17 amazon-channel-label, 4 amazon workflow, plus the queue
// runner (launchd) and the crawler-queue / crawler-maintenance wrappers. Refuses unless the queue is idle with no held
// permits; backs up every file it changes under manual-releases/<to-release>/switch; adds no auto-start.
// Rollback: copy switch/*.before* back to their original paths, then stop/start the same jobs and the queue service.
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const pg = createRequire(import.meta.url)('pg');
const [FROM_REL, TO_REL] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(FROM_REL ?? '') || !/^[a-z0-9-]+$/.test(TO_REL ?? '') || FROM_REL === TO_REL) throw Error('Usage: switch-amazon-release <from-release> <to-release>');
const root = '/Users/server/apps/crawler-v3', manifestPath = root + '/live/deployment.json', out = root + `/manual-releases/${TO_REL}/switch`;
const NEW = `/releases/${TO_REL}/source/`, OLD = `/releases/${FROM_REL}/source/`;
const GROUPS = [
  { from: OLD, file: 'amazon/amazon-live-worker.js', count: 7 },
  { from: OLD, file: 'label/channel-label-worker.js', count: 17 },
  { from: OLD, file: 'workflow/product-workflow-worker.js', count: 4 },
];
// Same file set as the workers' artifactBuildId: every .js, plus the workflow bundle (product-workflow-worker.ts).
const buildOf = dir => execFileSync('/usr/bin/python3', ['-c', `import hashlib,os\nh=hashlib.sha256()\nfor n in sorted(x for x in os.listdir(${JSON.stringify(dir)}) if x.endswith('.js') or x=='product-workflows.cjs'):\n b=open(os.path.join(${JSON.stringify(dir)},n),'rb').read();h.update((str(len(b))+':').encode());h.update(b)\nprint(h.hexdigest())`], { encoding: 'utf8' }).trim();
const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const plan = [];
for (const g of GROUPS) {
  const jobs = m.jobs.filter(j => /^amazon-/.test(j.id) && j.entry.includes(g.from) && j.entry.endsWith('/dist/ocr-cloud/' + g.file));
  if (jobs.length !== g.count) throw Error(`expected ${g.count} jobs for ${g.file}, got ${jobs.length}`);
  for (const j of jobs) {
    const cfg = j.env.V3_WORKER_CONFIG, c = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    const oldBuild = buildOf(j.entry.replace(/\/[^/]+$/, ''));
    if (c.expectedBuildId !== oldBuild) throw Error('unexpected current build for ' + j.id);
    const newEntry = j.entry.replace(g.from, NEW), newBuild = buildOf(newEntry.replace(/\/[^/]+$/, ''));
    if (!fs.existsSync(newEntry)) throw Error('missing new entry for ' + j.id);
    plan.push({ id: j.id, cfg, oldEntry: j.entry, newEntry, oldBuild, newBuild });
  }
}
const db = new pg.Client({ connectionString: m.database.connectionString }); await db.connect();
const busy = (await db.query("SELECT count(*)::int n FROM amazon_queue_item WHERE state IN ('running','ready','queued')")).rows[0].n;
const held = (await db.query('SELECT count(*)::int n FROM resource_permit WHERE released_at IS NULL')).rows[0].n; await db.end();
if (busy || held) throw Error(`queue not idle: queued/ready/running=${busy} held=${held}`);
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
fs.copyFileSync(manifestPath, out + '/deployment.before.json', fs.constants.COPYFILE_EXCL);
for (const p of plan) fs.copyFileSync(p.cfg, out + '/' + p.id + '.config.before.json', fs.constants.COPYFILE_EXCL);
fs.writeFileSync(out + '/plan.json', JSON.stringify(plan, null, 1));
const ctl = (cmd, id) => JSON.parse(execFileSync(m.node, [root + '/manual-control.mjs', cmd, id], { encoding: 'utf8', timeout: 180000 }).trim().split('\n').pop());
for (const p of plan) ctl('stop', p.id);
console.log('stopped', plan.length);
for (const p of plan) { const c = JSON.parse(fs.readFileSync(p.cfg, 'utf8')); c.expectedBuildId = p.newBuild; fs.writeFileSync(p.cfg + '.next', JSON.stringify(c, null, 2), { mode: 0o600 }); fs.renameSync(p.cfg + '.next', p.cfg); }
for (const j of m.jobs) { const p = plan.find(x => x.id === j.id); if (p) j.entry = p.newEntry; }
fs.writeFileSync(manifestPath + '.next', JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(manifestPath + '.next', manifestPath);
const started = []; for (const p of plan) { const s = ctl('start', p.id); started.push({ id: p.id, ready: s.jobs?.find(x => x.id === p.id)?.ready }); }
fs.writeFileSync(out + '/started.json', JSON.stringify({ at: new Date().toISOString(), started }, null, 1));
console.log(JSON.stringify({ started: started.length, notReady: started.filter(s => !s.ready).map(s => s.id) }));

// Queue runner and the two operator wrappers: same private config, new release.
const OLDQ = OLD, plist = root + '/manual-services/com.crawlv3.maintenance.promises.queue.plist';
for (const f of [plist, root + '/crawler-queue', root + '/crawler-maintenance']) {
  const s = fs.readFileSync(f, 'utf8'); if (!s.includes(OLDQ)) throw Error('old release path not found in ' + f);
  fs.copyFileSync(f, out + '/' + f.split('/').pop() + '.before', fs.constants.COPYFILE_EXCL);
}
execFileSync(root + '/crawler-maintenance', ['stop', 'queue'], { encoding: 'utf8', timeout: 120000 });
for (const f of [plist, root + '/crawler-queue', root + '/crawler-maintenance']) {
  const s = fs.readFileSync(f, 'utf8'), mode = fs.statSync(f).mode & 0o777;
  fs.writeFileSync(f + '.next', s.split(OLDQ).join(NEW), { mode }); fs.renameSync(f + '.next', f);
}
execFileSync(root + '/crawler-maintenance', ['start', 'queue'], { encoding: 'utf8', timeout: 120000 });
console.log(JSON.stringify({ queue: execFileSync(root + '/crawler-maintenance', ['status', 'queue'], { encoding: 'utf8' }).trim().slice(-300) }));
