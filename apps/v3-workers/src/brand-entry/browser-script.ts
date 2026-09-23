import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createR2Objects, RetainedPublication, sha256 } from '@crawl-automation/v3-artifacts';
import { TextLocalStore } from '@crawl-automation/v3-text';
import { storeEntryUrl, directoryLinks } from '../../../../packages/v3-channels/src/amazon-brand-entry.js';
import { readGncPrivateJson } from '../gnc-config.js';
import { SeedSchema, baseOutcome, safeCode, type Call, type Seed, type Outcome, type ObjectProof } from './contracts.js';

// These APIs are supplied by ego-browser, not a Playwright session or a second browser.
export interface EgoApi { taskSpace(id: number): Promise<any>; }
type Journal = { call: Call; phase: string; before: string[]; owned: { label: string; targetId: string } | null; outcome: Outcome };
const journalPath = (root: string, x: Call) => join(root, `${x.campaignId}-${x.candidateId}.json`);
const save = async (file: string, state: Journal) => {
  const temp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temp, file);
};
const identityText = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

async function cleanup(task: any, state: Journal): Promise<Outcome['cleanup']> {
  const checkedAt = new Date().toISOString();
  const targets = await task.tabs();
  if (!state.owned) {
    // A crash between newPage and journaling its label must not hide an orphan.
    const added = targets.filter((t: any) => !state.before.includes(t.targetId));
    return { status: added.length ? 'pending' : 'not_opened', targetIds: added.map((t: any) => t.targetId), checkedAt };
  }
  const owned = state.owned, current = targets.find((t: any) => t.targetId === owned.targetId);
  if (!current) return { status: 'closed', targetIds: [owned.targetId], checkedAt };
  if (task.ownership !== 'agent' || current.openedBy !== 'agent' || current.label !== owned.label)
    return { status: 'pending', targetIds: [owned.targetId], checkedAt };
  const page = task.page(current.label);
  // Restore only this target's interception state, and stop its pending navigation.
  await page.cdp('Fetch.disable'); await page.cdp('Page.stopLoading');
  try { await page.close(); } catch { /* A close timeout can precede a successful target removal. */ }
  for (let n = 0; n < 8; n++) {
    if (!(await task.tabs()).some((t: any) => t.targetId === owned.targetId)) return { status: 'closed', targetIds: [owned.targetId], checkedAt: new Date().toISOString() };
    await new Promise(r => setTimeout(r, 250));
  }
  return { status: 'pending', targetIds: [owned.targetId], checkedAt: new Date().toISOString() };
}

export async function recover(api: EgoApi, configFile: string, call: Call) {
  const config: any = await readGncPrivateJson(configFile), file = journalPath(config.journalRoot, call);
  let state: Journal;
  try { state = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e: any) { if (e.code === 'ENOENT') return { status: 'not_opened', targetIds: [], checkedAt: new Date().toISOString() }; throw e; }
  if (JSON.stringify(state.call) !== JSON.stringify(call)) throw Error('BRAND_ENTRY.JOURNAL_IDENTITY');
  const task = await api.taskSpace(config.taskSpaceId);
  state.outcome.cleanup = await cleanup(task, state); state.phase = 'recovered';
  await save(file, state);
  return state.outcome.cleanup;
}

export async function discover(api: EgoApi, configFile: string, raw: unknown): Promise<Outcome> {
  const seed = SeedSchema.parse(raw), call: Call = { campaignId: seed.campaignId, candidateId: seed.candidateId };
  const config: any = await readGncPrivateJson(configFile), file = journalPath(config.journalRoot, call);
  await fs.mkdir(config.journalRoot, { recursive: true, mode: 0o700 });
  const task = await api.taskSpace(config.taskSpaceId);
  if (task.ownership !== 'agent') throw Error('BRAND_ENTRY.USER_CONTROL');
  const state: Journal = { call, phase: 'creating', before: (await task.tabs()).map((t: any) => t.targetId), owned: null, outcome: baseOutcome(call, 'failed', 'BRAND_ENTRY.EXECUTION_UNRESOLVED') };
  state.outcome.seed = seed;
  // This intent must exist before any page creation; an existing one denies a rerun.
  await fs.writeFile(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
  const r2 = createR2Objects(config.r2, config.r2Credentials);
  const publication = new RetainedPublication(await TextLocalStore.open(join(config.journalRoot, 'retained')), r2.store);
  const deadline = Date.now() + 180000, bounded = () => Math.max(1, Math.min(45000, deadline - Date.now()));
  let page: any;
  const retain = async (key: string, bytes: Uint8Array, mediaType: string): Promise<ObjectProof> => {
    if (Date.now() >= deadline) throw Error('BRAND_ENTRY.TIME_LIMIT');
    const proof = { key, sha256: sha256(bytes), byteSize: bytes.length, mediaType };
    await publication.publish(key, bytes, mediaType, AbortSignal.timeout(bounded()));
    state.outcome.evidence.push(proof); await save(file, state);
    return proof;
  };
  try {
    // Verify retained seed bytes before navigating a link derived from them.
    for (const ref of [seed.original, seed.receipt]) {
      const bytes = await r2.store.read(ref.key, ref.byteSize, AbortSignal.timeout(15000));
      if (!bytes || bytes.length !== ref.byteSize || sha256(bytes) !== ref.sha256) throw Error('BRAND_ENTRY.SEED_EVIDENCE');
    }
    page = await task.newPage();
    const own = (await task.tabs()).find((t: any) => t.label === page.label);
    if (!own || own.openedBy !== 'agent' || state.before.includes(own.targetId)) throw Error('BRAND_ENTRY.PAGE_OWNERSHIP');
    state.owned = { label: own.label, targetId: own.targetId }; state.phase = 'navigating'; await save(file, state);
    await page.cdp('Network.enable', { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 8 * 1024 * 1024 });
    const visit = async (rawUrl: string) => {
      if (state.outcome.pages.length >= 8) throw Error('BRAND_ENTRY.NAVIGATION_LIMIT');
      const url = storeEntryUrl(rawUrl), index = state.outcome.pages.length, prefix = `v3/brand-entry/${call.campaignId}/${call.candidateId}/pages/${index}`;
      await page.events();
      await page.cdp('Fetch.enable', { patterns: [{ urlPattern: 'https://www.amazon.com/stores/*', resourceType: 'Document', requestStage: 'Response' }] });
      let navigationError: unknown, navigationDone = false;
      const navigation = page.goto(url, { waitUntil: 'domcontentloaded', timeout: bounded() }).then(() => { navigationDone = true; }, (e: unknown) => { navigationError = e; });
      let original: ObjectProof | null = null, finalUrl = url, capturedAt = '', status = 0, redirects = 0;
      const navigationDeadline = Math.min(deadline, Date.now() + 45000);
      while (!original && Date.now() < navigationDeadline) {
        if (task.ownership !== 'agent') throw Error('BRAND_ENTRY.USER_CONTROL');
        if (navigationError) throw navigationError;
        const events = await page.events();
        for (const event of events) {
          if (event.method !== 'Fetch.requestPaused') continue;
          const p = event.params;
          finalUrl = storeEntryUrl(p.request.url);
          status = p.responseStatusCode;
          if (status >= 300 && status < 400) {
            if (++redirects > 3) throw Error('BRAND_ENTRY.REDIRECT_LIMIT');
            const location = p.responseHeaders.find((h: any) => h.name.toLowerCase() === 'location')?.value;
            if (!location) throw Error('BRAND_ENTRY.REDIRECT_UNVERIFIED');
            storeEntryUrl(new URL(location, finalUrl).href);
            await retain(`${prefix}/redirect-${redirects}.json`, Buffer.from(JSON.stringify({ url: finalUrl, status, location })), 'application/json');
            await page.cdp('Fetch.continueResponse', { requestId: p.requestId }); continue;
          }
          const contentType = p.responseHeaders?.find((h: any) => h.name.toLowerCase() === 'content-type')?.value ?? '';
          if (!/^text\/html(?:;|$)/i.test(contentType)) throw Error('BRAND_ENTRY.NOT_HTML');
          const body = await page.cdp('Fetch.getResponseBody', { requestId: p.requestId }, { timeout: bounded() });
          // Network.getResponseBody strips BOMs from decoded text. Only the Fetch
          // base64 response body passed the byte-exact fixture; never substitute DOM/text.
          if (!body.base64Encoded) throw Error('BRAND_ENTRY.RAW_BODY_UNVERIFIED');
          const bytes = Buffer.from(body.body, 'base64');
          if (!bytes.length || bytes.length > 6 * 1024 * 1024) throw Error('BRAND_ENTRY.HTML_LIMIT');
          capturedAt = new Date().toISOString();
          original = await retain(`${prefix}/original.html`, bytes, 'text/html');
          await retain(`${prefix}/original.json`, Buffer.from(JSON.stringify({ url: finalUrl, requestedUrl: url, capturedAt, status, original,
            representation: 'fetch-response-base64', contentType })), 'application/json');
          await page.cdp('Fetch.continueResponse', { requestId: p.requestId });
          // Interception is task-target-local and ends as soon as the required body is retained.
          await page.cdp('Fetch.disable');
          if (status !== 200) throw Error('BRAND_ENTRY.HTTP_STATUS');
          break;
        }
        if (!original) await new Promise(r => setTimeout(r, 100));
      }
      if (!original) throw Error('BRAND_ENTRY.RAW_BODY_MISSING');
      await navigation;
      if (navigationError || !navigationDone) throw Error('BRAND_ENTRY.NAVIGATION_FAILED');
      if (storeEntryUrl(await page.url()) !== finalUrl) throw Error('BRAND_ENTRY.REDIRECT_UNVERIFIED');
      await page.waitForFunction(() => document.readyState !== 'loading', undefined, { timeout: bounded() });
      const snapshotText: string = await page.snapshot({ scope: 'full_page' });
      const data = await page.evaluate(() => ({ title: document.title,
        headings: Array.from(document.querySelectorAll('h1,h2,img[alt]')).map(e => e.getAttribute('alt') || e.textContent || '').slice(0, 250),
        text: (document.body?.innerText ?? '').slice(0, 100000), html: document.documentElement.outerHTML,
        products: Array.from(new Set(Array.from(document.querySelectorAll('a[href]')).map(a => a.getAttribute('href')?.match(/\/dp\/([A-Z0-9]{10})/)?.[1]).filter(Boolean))),
        links: Array.from(document.querySelectorAll('a[href]')).filter(a => (a as HTMLElement).getClientRects().length > 0).map(a => ({ href: (a as HTMLAnchorElement).href,
          text: (a.textContent || a.getAttribute('aria-label') || '').trim(), navigation: Boolean(a.closest('nav,[role="navigation"],[class*="Navigation"],[class*="navigation"]')) })).slice(0, 1500) }));
      const rendered = await retain(`${prefix}/rendered.html`, Buffer.from(data.html), 'text/html');
      const snapshot = await retain(`${prefix}/snapshot.txt`, Buffer.from(snapshotText), 'text/plain');
      state.outcome.pages.push({ requestedUrl: url, finalUrl, capturedAt, status, original, rendered, snapshot,
        responseRepresentation: 'fetch-response-base64', title: data.title, productCount: data.products.length });
      await save(file, state);
      if (/Robot Check|Enter the characters you see below|verify (?:that )?you are (?:a )?human/i.test(data.text)) throw Error('BRAND_ENTRY.ACCESS_CHALLENGE');
      const visibleIdentity = identityText([data.title, ...data.headings].join(' '));
      if (!visibleIdentity.includes(identityText(seed.name))) throw Error('BRAND_ENTRY.STORE_IDENTITY');
      return { data, index };
    };
    const first = await visit(seed.storeUrl), choice = directoryLinks(first.data.links, seed.storeUrl);
    state.outcome.directoryKind = choice.kind;
    for (const entry of choice.links) {
      const visited = entry.href === state.outcome.pages[0]!.finalUrl ? first : await visit(entry.href);
      if (!visited.data.products.length) throw Error('BRAND_ENTRY.DIRECTORY_EMPTY');
      state.outcome.directories.push({ url: entry.href, text: entry.text, pageIndex: visited.index });
    }
    state.outcome.state = 'verified'; state.outcome.code = 'BRAND_ENTRY.VERIFIED'; state.outcome.verifiedAt = new Date().toISOString();
  } catch (e) {
    state.outcome.state = 'review'; state.outcome.code = safeCode(e); state.outcome.verifiedAt = null;
  } finally {
    try { state.outcome.cleanup = await cleanup(task, state); }
    catch { state.outcome.cleanup = { status: 'pending', targetIds: state.owned ? [state.owned.targetId] : [], checkedAt: new Date().toISOString() }; }
    if (state.outcome.cleanup.status === 'pending') { state.outcome.state = 'failed'; state.outcome.code = 'BRAND_ENTRY.CLEANUP_PENDING'; state.outcome.verifiedAt = null; }
    state.phase = 'finished'; await save(file, state); r2.close();
  }
  return state.outcome;
}
