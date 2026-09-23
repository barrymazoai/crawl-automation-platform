import * as fs from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserRunner } from './browser-runner.js';
import { CandidateSchema, ManifestSchema, OutcomeSchema, baseOutcome, type Outcome } from './contracts.js';
import { createJson, readJson, atomicJson, digest, LocalEvidence } from './local-store.js';
import { verifiedProofs } from './proofs.js';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
export async function batchStatus(root: string) {
  const manifest = ManifestSchema.parse(await readJson(join(root, 'manifest.json'))), results: Outcome[] = [];
  for (const name of await fs.readdir(join(root, 'results'))) if (name.endsWith('.json')) results.push(OutcomeSchema.parse(await readJson(join(root, 'results', name))));
  const counts: Record<string, number> = { pending: manifest.candidates.length - results.length, verified: 0, review: 0, failed: 0, cancelled: 0 };
  for (const result of results) counts[result.state]!++;
  return { campaignId: manifest.campaignId, total: manifest.candidates.length, counts, recent: results.slice(-5).map(x => ({ id: x.candidateId, state: x.state, code: x.code, cleanup: x.cleanup.status })) };
}
async function main() {
  const [command, rawRoot, ...args] = process.argv.slice(2); if (!rawRoot) throw Error('BRAND_ENTRY.BATCH_REQUIRED');
  const root = resolve(rawRoot), manifestFile = join(root, 'manifest.json'), configFile = join(root, 'browser.json');
  if (command === 'init') {
    const data = await readJson(resolve(args[0]!)), candidates = (data.brands ?? data.candidates).map((x: unknown) => CandidateSchema.parse(x));
    if (new Set(candidates.map((x: any) => x.companyId)).size !== candidates.length) throw Error('BRAND_ENTRY.MANIFEST');
    const manifest = ManifestSchema.parse({ codec: 'amazon-brand-local/1', campaignId: randomUUID(), createdAt: new Date().toISOString(), candidates });
    const space = Number(args[1] ?? 1); if (!Number.isSafeInteger(space) || space < 1) throw Error('BRAND_ENTRY.SPACE');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await createJson(manifestFile, manifest);
    for (const dir of ['attempts', 'results', 'journals', 'evidence']) await fs.mkdir(join(root, dir), { mode: 0o700 });
    await createJson(configFile, { cliPath: args[2] ?? '/Users/server2/.local/bin/ego-browser', taskSpaceId: space, runtimeRoot: root, journalRoot: join(root, 'journals'), evidenceRoot: join(root, 'evidence') });
    console.log(JSON.stringify({ root, campaignId: manifest.campaignId, candidates: candidates.length, manifestSha256: digest(await fs.readFile(manifestFile)), credentialsRequired: false })); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await batchStatus(root))); return; }
  if (command === 'package-list') {
    const manifest = ManifestSchema.parse(await readJson(manifestFile)), store = new LocalEvidence(join(root, 'evidence'));
    const files = new Set<string>(['manifest.json']); let verified = 0;
    for (const candidate of manifest.candidates) {
      const name = `results/${candidate.companyId}.json`; let out: Outcome;
      try { out = OutcomeSchema.parse(await readJson(join(root, name))); } catch (e: any) { if (e.code === 'ENOENT') continue; throw e; }
      if (out.campaignId !== manifest.campaignId || out.candidateId !== candidate.companyId) throw Error('BRAND_ENTRY.RESULT_IDENTITY');
      files.add(name);
      if (out.state !== 'verified') continue;
      for (const ref of verifiedProofs(out)) { await store.read(ref); files.add(`evidence/${ref.key}`); }
      verified++;
    }
    // Review evidence remains retained on this Mini and is pulled on demand.
    await fs.writeFile(join(root, 'transfer-files.txt'), [...files].join('\n') + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ files: files.size, verified, manifestSha256: digest(await fs.readFile(manifestFile)) })); return;
  }
  const manifest = ManifestSchema.parse(await readJson(manifestFile)), config = await readJson(configFile);
  const runner = new BrowserRunner(configFile, config, join(dirname(fileURLToPath(import.meta.url)), 'browser-script.js'));
  const lockFile = join(root, 'run-lock.json');
  if (command === 'recover') {
    let lock; try { lock = await readJson(lockFile); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    if (lock && alive(lock.pid)) throw Error('BRAND_ENTRY.RUNNING');
    for (const name of await fs.readdir(join(root, 'attempts'))) {
      if (!name.endsWith('.json')) continue;
      const id = z.uuid().parse(name.slice(0, -5)), outFile = join(root, 'results', name);
      try { await fs.access(outFile); continue; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      const call = { campaignId: manifest.campaignId, candidateId: id }, out = baseOutcome(call, 'failed', 'BRAND_ENTRY.EXECUTION_INTERRUPTED');
      try { const journal = await readJson(join(config.journalRoot, `${call.campaignId}-${id}.json`));
        const partial = OutcomeSchema.parse(journal.outcome); out.seed = partial.seed; out.pages = partial.pages; out.evidence = partial.evidence; } catch { /* preserve an unresolved attempt */ }
      out.cleanup = await runner.recover(call); await createJson(outFile, out);
      if (out.cleanup.status === 'pending') throw Error('BRAND_ENTRY.CLEANUP_PENDING');
    }
    if (lock) await fs.rm(lockFile); console.log(JSON.stringify(await batchStatus(root))); return;
  }
  if (command !== 'run') throw Error('BRAND_ENTRY.UNKNOWN_COMMAND');
  const limit = Number(args[0] ?? 5), selected = new Set(args.slice(1).map(x => z.uuid().parse(x)));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw Error('BRAND_ENTRY.LIMIT');
  for (const name of await fs.readdir(join(root, 'attempts'))) {
    try { await fs.access(join(root, 'results', name)); } catch { throw Error('BRAND_ENTRY.RECOVERY_REQUIRED'); }
  }
  await createJson(lockFile, { pid: process.pid, at: new Date().toISOString(), campaignId: manifest.campaignId });
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  let count = 0, consecutiveBlocked = 0;
  try {
    for (const candidate of manifest.candidates) {
      if (count >= limit || controller.signal.aborted) break;
      if (selected.size && !selected.has(candidate.companyId)) continue;
      const outFile = join(root, 'results', `${candidate.companyId}.json`);
      try { await fs.access(outFile); continue; } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      await fs.access(config.cliPath);
      const call = { campaignId: manifest.campaignId, candidateId: candidate.companyId };
      await createJson(join(root, 'attempts', `${candidate.companyId}.json`), { ...call, at: new Date().toISOString() });
      await atomicJson(join(root, 'progress.json'), { at: new Date().toISOString(), active: candidate.name, candidateId: candidate.companyId, count });
      const outcome = await runner.discover({ ...call, candidate }, controller.signal);
      await createJson(outFile, outcome); count++;
      console.log(JSON.stringify({ name: candidate.name, candidateId: candidate.companyId, state: outcome.state, code: outcome.code, directories: outcome.directories.length, cleanup: outcome.cleanup.status }));
      if (outcome.cleanup.status === 'pending') throw Error('BRAND_ENTRY.CLEANUP_PENDING');
      if (outcome.code === 'BRAND_ENTRY.USER_CONTROL') break;
      consecutiveBlocked = ['BRAND_ENTRY.ACCESS_CHALLENGE', 'BRAND_ENTRY.HTTP_STATUS'].includes(outcome.code) ? consecutiveBlocked + 1 : 0;
      if (consecutiveBlocked >= 3) { console.log(JSON.stringify({ paused: 'repeated-site-access-failure' })); break; }
    }
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await atomicJson(join(root, 'progress.json'), { at: new Date().toISOString(), active: null, processedThisRun: count });
    await fs.rm(lockFile);
  }
  console.log(JSON.stringify(await batchStatus(root)));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e instanceof Error ? e.message : 'BRAND_ENTRY.FAILED'); process.exitCode = 1; });
