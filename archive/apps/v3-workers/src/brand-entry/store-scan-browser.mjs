// Runs inside `ego-browser nodejs` (Server 二). One store per call, on one page this call opens and always closes.
// The page's intent/ownership journal is written before any navigation so an interrupted run can close exactly that
// target later (recover). Evidence: the fully loaded page's DOM (products load by script, so the first network
// response does not contain them), archived byte-for-byte and read back before it is parsed.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { crawlStore } from './store-scan-core.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const journalFile = (root, id) => join(root, 'journals', `${id}.json`);
const writeJournal = async (file, state) => { const t = `${file}.${process.pid}.tmp`; await fs.writeFile(t, JSON.stringify(state), { mode: 0o600 }); await fs.rename(t, file); };

async function closeOwned(task, state) {
  const checkedAt = () => new Date().toISOString();
  const tabs = await task.tabs();
  if (!state.owned) {
    // A crash between opening and journaling must not hide an orphan.
    const added = tabs.filter(t => !state.before.includes(t.targetId));
    return { status: added.length ? 'pending' : 'not_opened', targetIds: added.map(t => t.targetId), checkedAt: checkedAt() };
  }
  const own = state.owned, current = tabs.find(t => t.targetId === own.targetId);
  if (!current) return { status: 'closed', targetIds: [own.targetId], checkedAt: checkedAt() };
  // Never take a page back from the user or close anything we did not open.
  if (task.ownership !== 'agent' || current.openedBy !== 'agent' || current.label !== own.label) return { status: 'pending', targetIds: [own.targetId], checkedAt: checkedAt() };
  try { await task.page(current.label).close(); } catch { /* a close timeout can precede a successful removal */ }
  for (let n = 0; n < 12; n++) {
    if (!(await task.tabs()).some(t => t.targetId === own.targetId)) return { status: 'closed', targetIds: [own.targetId], checkedAt: checkedAt() };
    await new Promise(r => setTimeout(r, 250));
  }
  return { status: 'pending', targetIds: [own.targetId], checkedAt: checkedAt() };
}

export async function scanStore(api, input) {
  const { runRoot, id, url, maxPages, taskSpaceId, timeLimitMs } = input;
  const task = await api.taskSpace(taskSpaceId);
  const base = { codec: 'amazon-brand-scan-result/1', id, kind: 'store', url, state: 'review', pages: [], asins: [], catalogEnumerationComplete: false, databaseImported: false };
  if (task.ownership !== 'agent') return { ...base, code: 'STORE_SCAN.USER_CONTROL', cleanup: { status: 'not_opened', targetIds: [], checkedAt: new Date().toISOString() } };
  const file = journalFile(runRoot, id);
  const state = { id, url, before: (await task.tabs()).map(t => t.targetId), owned: null, phase: 'opening' };
  await fs.writeFile(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); // an existing journal denies a rerun
  let result;
  try {
    const page = await task.newPage();
    const own = (await task.tabs()).find(t => t.label === page.label);
    if (!own || own.openedBy !== 'agent' || state.before.includes(own.targetId)) throw Error('STORE_SCAN.PAGE_OWNERSHIP');
    state.owned = { label: own.label, targetId: own.targetId }; state.phase = 'crawling'; await writeJournal(file, state);
    const load = async target => {
      if (task.ownership !== 'agent') throw Error('STORE_SCAN.USER_CONTROL');
      await page.goto(target).catch(e => { if (!/timed out/i.test(e.message)) throw e; });
      await page.waitForFunction(() => document.readyState !== 'loading' && !!document.body, undefined, { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(2000);
      // Load everything: scroll to the end and press "show/see/load more" until height and product count stop changing.
      let last = -1, stable = 0;
      for (let round = 0; round < 40 && stable < 3; round++) {
        const r = await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          const b = [...document.querySelectorAll('button, a[role="button"], span[role="button"]')]
            .find(x => /^(show|see|load|view)\s+more\b/i.test((x.innerText || '').trim()) && x.offsetParent !== null && !x.closest('nav, header'));
          if (b) b.click();
          return { h: document.body.scrollHeight, n: document.querySelectorAll('[data-asin], a[href*="/dp/"]').length, clicked: !!b };
        });
        await page.waitForTimeout(1300);
        const size = r.h * 100000 + r.n;
        stable = size === last && !r.clicked ? stable + 1 : 0; last = size;
      }
      const html = await page.evaluate(() => '<!doctype html>\n' + document.documentElement.outerHTML);
      return { finalUrl: await page.url(), html };
    };
    const retain = async (pageUrl, html) => {
      const stem = join(runRoot, 'evidence', sha(pageUrl)), bytes = Buffer.from(html, 'utf8');
      if (bytes.length > 16 * 1024 * 1024) throw Error('STORE_SCAN.HTML_LIMIT');
      const h = await fs.open(stem + '.html', 'wx', 0o600); try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
      const back = await fs.readFile(stem + '.html');
      if (sha(back) !== sha(bytes)) throw Error('STORE_SCAN.ARCHIVE_UNVERIFIED');
      const receipt = { url: pageUrl, capturedAt: new Date().toISOString(), sha256: sha(back), byteSize: back.length,
        representation: 'rendered-dom-after-load', archiveReadbackVerified: true };
      const r = await fs.open(stem + '.json', 'wx', 0o600); try { await r.writeFile(JSON.stringify(receipt)); await r.sync(); } finally { await r.close(); }
      return { ...receipt, html: back.toString('utf8') };
    };
    result = await crawlStore({ id, url, maxPages, deadline: Date.now() + timeLimitMs, load, retain });
  } catch (e) {
    result = { ...base, code: /^STORE_SCAN\.[A-Z_]+$/.test(e?.message ?? '') ? e.message
      : /taken control|user now controls|user control|permission prompt|delegated to user/i.test(e?.message ?? '') ? 'STORE_SCAN.USER_CONTROL' : 'STORE_SCAN.EXECUTION_UNRESOLVED' };
  } finally {
    let cleanup;
    try { cleanup = await closeOwned(task, state); }
    catch { cleanup = { status: 'pending', targetIds: state.owned ? [state.owned.targetId] : [], checkedAt: new Date().toISOString() }; }
    state.phase = 'finished'; state.cleanup = cleanup; await writeJournal(file, state);
    result = { ...result, cleanup };
  }
  return result;
}

// Close the exact page an interrupted scanStore opened, using its journal. Never navigates.
export async function recover(api, input) {
  let state;
  try { state = JSON.parse(await fs.readFile(journalFile(input.runRoot, input.id), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { status: 'not_opened', targetIds: [], checkedAt: new Date().toISOString() }; throw e; }
  const task = await api.taskSpace(input.taskSpaceId);
  const cleanup = await closeOwned(task, state);
  state.phase = 'recovered'; state.cleanup = cleanup; await writeJournal(journalFile(input.runRoot, input.id), state);
  return cleanup;
}
