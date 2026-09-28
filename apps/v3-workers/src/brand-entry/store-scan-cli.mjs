// Amazon Brand Store scan runner (Server 二, Ego Lite). Finite and manual: no Temporal, R2, database or ScraperAPI.
//   node store-scan-cli.mjs run|status|recover <run-dir> [--ego <ego-browser path>]
// manifest.json: { codec: 'amazon-store-scan/1', concurrency: 1-3, maxPages: 1-60, candidates: [{ id, url }] }
// Each store runs in its own `ego-browser nodejs` process on its own page in one TaskSpace for the run. Nothing is
// retried automatically. A page that cannot be verified closed, a user takeover or three access challenges in a row
// stop the run; `recover` closes exact leftover pages from their journals.
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { storeAddress } from '../../../../packages/v3-channels/src/amazon-store-scan.mjs';

const here = dirname(fileURLToPath(import.meta.url)), browserModule = pathToFileURL(join(here, 'store-scan-browser.mjs')).href;
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const exists = async p => { try { await fs.access(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const save = async (p, v) => { const h = await fs.open(p, 'wx', 0o600); try { await h.writeFile(JSON.stringify(v, null, 1)); await h.sync(); } finally { await h.close(); } };
const atomic = async (p, v) => { const t = `${p}.${randomUUID()}`; await save(t, v); await fs.rename(t, p); };
const args = process.argv.slice(2), [command, rootArg] = args, root = resolve(rootArg ?? '.');
const opt = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const ego = opt('--ego') ?? process.env.EGO_BROWSER ?? 'ego-browser';
if (!['run', 'status', 'recover'].includes(command) || !rootArg) throw Error('Usage: store-scan-cli.mjs run|status|recover <run-dir> [--ego <path>]');
const manifest = await read(join(root, 'manifest.json'));
if (manifest.codec !== 'amazon-store-scan/1' || !(Number.isInteger(manifest.concurrency) && manifest.concurrency >= 1 && manifest.concurrency <= 3) ||
    !(Number.isInteger(manifest.maxPages) && manifest.maxPages >= 1 && manifest.maxPages <= 60) ||
    !Array.isArray(manifest.candidates) || !manifest.candidates.length || manifest.candidates.length > 2000) throw Error('STORE_SCAN.MANIFEST');
const ids = new Set();
for (const c of manifest.candidates) { if (!/^[a-f0-9-]{36}$/.test(c?.id ?? '') || ids.has(c.id)) throw Error('STORE_SCAN.MANIFEST'); storeAddress(c.url); ids.add(c.id); }

// One ego-browser nodejs process; the result is the last marker line it prints.
function egoRun(code, timeoutMs, marker) {
  return new Promise((ok, bad) => {
    const child = spawn(ego, ['nodejs', '-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 3000); }, timeoutMs);
    const collect = b => { output += b.toString('utf8'); if (output.length > 4 * 1024 * 1024) output = output.slice(-2 * 1024 * 1024); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('error', () => { clearTimeout(timer); bad(Error('STORE_SCAN.EXECUTOR_UNAVAILABLE')); });
    child.on('close', status => {
      clearTimeout(timer);
      const line = output.split('\n').findLast(x => x.startsWith(marker));
      if (timedOut) return bad(Error('STORE_SCAN.TIME_LIMIT'));
      if (status !== 0 || !line) return bad(Object.assign(Error('STORE_SCAN.EXECUTION_UNRESOLVED'), { output: output.slice(-2000) }));
      try { ok(JSON.parse(line.slice(marker.length))); } catch { bad(Error('STORE_SCAN.RESULT_UNVERIFIED')); }
    });
  });
}
const call = (fn, input, timeoutMs) => egoRun(`const m=await import(${JSON.stringify(browserModule)});const r=await m.${fn}({taskSpace},${JSON.stringify(input)});console.log("STORE_SCAN_RESULT:"+JSON.stringify(r));`, timeoutMs, 'STORE_SCAN_RESULT:');
const summary = async () => {
  const counts = { pending: 0, complete: 0, capped: 0, review: 0 }; let products = 0, pages = 0; const codes = {};
  for (const c of manifest.candidates) {
    const f = join(root, 'results', `${c.id}.json`);
    if (!(await exists(f))) { counts.pending++; continue; }
    const r = await read(f); counts[r.state] = (counts[r.state] ?? 0) + 1; products += r.asins.length; pages += r.pages.length;
    if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
  }
  return { total: manifest.candidates.length, ...counts, products, pages, codes };
};

if (command === 'status') {
  console.log(JSON.stringify({ progress: await read(join(root, 'progress.json')).catch(() => null), results: await summary() }));
} else {
  for (const d of ['results', 'attempts', 'journals', 'evidence']) await fs.mkdir(join(root, d), { recursive: true, mode: 0o700 });
  const browserFile = join(root, 'browser.json');
  const lock = await fs.open(join(root, 'run-lock.json'), 'wx', 0o600);
  await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), command })); await lock.sync();
  let halt = false, fatal = null, challenges = 0, cursor = 0, done = 0, active = 0;
  const startedAt = new Date().toISOString();
  const publish = state => atomic(join(root, 'progress.json'), { at: new Date().toISOString(), startedAt, pid: process.pid, state, fatal, active, doneThisRun: done });
  process.once('SIGTERM', () => { halt = true; }); process.once('SIGINT', () => { halt = true; });
  try {
    if (!(await exists(browserFile))) {
      if (command === 'recover') throw Error('STORE_SCAN.NO_SPACE');
      const space = await egoRun(`const t=await taskSpace(${JSON.stringify('amazon store scan ' + root.split('/').pop())});console.log("STORE_SCAN_SPACE:"+JSON.stringify({id:t.spaceId}));`, 60000, 'STORE_SCAN_SPACE:');
      await save(browserFile, { taskSpaceId: space.id, createdAt: new Date().toISOString() });
    }
    const { taskSpaceId } = await read(browserFile);
    if (command === 'recover') {
      // Attempts without a result: close their exact page from the journal, record the interruption, never navigate.
      for (const c of manifest.candidates) {
        const res = join(root, 'results', `${c.id}.json`);
        if (!(await exists(join(root, 'attempts', `${c.id}.json`))) || await exists(res)) continue;
        const cleanup = await call('recover', { runRoot: root, id: c.id, taskSpaceId }, 60000);
        await save(res, { codec: 'amazon-brand-scan-result/1', id: c.id, kind: 'store', url: storeAddress(c.url).url, state: 'review', code: 'STORE_SCAN.EXECUTION_INTERRUPTED',
          pages: [], asins: [], catalogEnumerationComplete: false, databaseImported: false, cleanup });
        if (cleanup.status === 'pending') throw Error('STORE_SCAN.CLEANUP_PENDING');
      }
    } else {
      for (const c of manifest.candidates)
        if (await exists(join(root, 'attempts', `${c.id}.json`)) && !(await exists(join(root, 'results', `${c.id}.json`)))) throw Error('STORE_SCAN.RECOVERY_REQUIRED');
      await publish('running');
      const timeLimitMs = Math.max(10, manifest.maxPages) * 45000;
      const one = async c => {
        const res = join(root, 'results', `${c.id}.json`);
        if (await exists(res)) return;
        await save(join(root, 'attempts', `${c.id}.json`), { id: c.id, at: new Date().toISOString() });
        active++; await publish('running');
        let r;
        try { r = await call('scanStore', { runRoot: root, id: c.id, url: c.url, maxPages: manifest.maxPages, taskSpaceId, timeLimitMs }, timeLimitMs + 120000); }
        catch (e) {
          // Executor failure: keep the journal, close the exact page separately, never repeat the navigation.
          let cleanup; try { cleanup = await call('recover', { runRoot: root, id: c.id, taskSpaceId }, 60000); }
          catch { cleanup = { status: 'pending', targetIds: [], checkedAt: new Date().toISOString() }; }
          r = { codec: 'amazon-brand-scan-result/1', id: c.id, kind: 'store', url: storeAddress(c.url).url, state: 'review', code: e.message.startsWith('STORE_SCAN.') ? e.message : 'STORE_SCAN.EXECUTION_UNRESOLVED',
            pages: [], asins: [], catalogEnumerationComplete: false, databaseImported: false, cleanup };
        } finally { active--; }
        if (r.id !== c.id) throw Error('STORE_SCAN.RESULT_IDENTITY');
        await save(res, r); done++;
        console.log(JSON.stringify({ id: c.id, state: r.state, code: r.code, pages: r.pages.length, products: r.asins.length, shopAll: r.shopAll ?? null, cleanup: r.cleanup?.status }));
        if (r.cleanup?.status === 'pending') { halt = true; fatal = 'STORE_SCAN.CLEANUP_PENDING'; }
        if (r.code === 'STORE_SCAN.USER_CONTROL') { halt = true; fatal = 'STORE_SCAN.USER_CONTROL'; }
        challenges = r.code === 'STORE_SCAN.ACCESS_CHALLENGE' ? challenges + 1 : 0;
        if (challenges >= 3) { halt = true; fatal = 'STORE_SCAN.REPEATED_ACCESS_CHALLENGE'; }
      };
      await Promise.all(Array.from({ length: manifest.concurrency }, async () => {
        while (!halt) { const c = manifest.candidates[cursor++]; if (!c) break; await one(c); }
      }));
      // Close the run's TaskSpace only when every page is verified closed and the user has not taken over.
      if (!halt && (await summary()).pending === 0)
        await egoRun(`const t=await taskSpace(${taskSpaceId});await t.finish({keep:[]});console.log("STORE_SCAN_DONE:{}");`, 60000, 'STORE_SCAN_DONE:').catch(() => { fatal = 'STORE_SCAN.SPACE_FINISH_UNVERIFIED'; });
    }
  } catch (e) { halt = true; fatal = e.message?.startsWith('STORE_SCAN.') ? e.message : 'STORE_SCAN.LOCAL_OR_EXECUTION_UNKNOWN'; process.exitCode = 1; }
  finally {
    await publish(halt ? 'paused' : 'completed');
    await lock.close(); await fs.unlink(join(root, 'run-lock.json'));
    console.log(JSON.stringify({ fatal, results: await summary() }));
  }
}
