import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OutcomeSchema, baseOutcome, type Call, type Seed, type Outcome } from './contracts.js';

export class BrowserRunner {
  constructor(private readonly configFile: string, private readonly config: { cliPath: string; journalRoot: string; runtimeRoot: string }, private readonly scriptPath: string) {}
  private async execute(mode: 'discover' | 'recover', value: unknown, signal: AbortSignal, timeout: number): Promise<any> {
    const code = `const m=await import(${JSON.stringify(pathToFileURL(this.scriptPath).href)});const result=await m.${mode}({taskSpace},${JSON.stringify(this.configFile)},${JSON.stringify(value)});console.log("BRAND_ENTRY_RESULT:"+JSON.stringify(result));`;
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.cliPath, ['nodejs', '-e', code], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error: Error | undefined, killTimer: NodeJS.Timeout | undefined;
      const terminate = () => {
        if (error) return;
        error = Error(signal.aborted ? 'BRAND_ENTRY.CANCELLED' : 'BRAND_ENTRY.TIME_LIMIT');
        if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
          killTimer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already exited */ } }, 2000); }
      };
      const timer = setTimeout(terminate, timeout);
      const collect = (chunk: Buffer) => { output += chunk.toString('utf8'); if (output.length > 2 * 1024 * 1024) terminate(); };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      signal.addEventListener('abort', terminate, { once: true }); if (signal.aborted) terminate();
      child.on('error', e => { error = Error('BRAND_ENTRY.EXECUTOR_UNAVAILABLE'); });
      child.on('close', code => {
        clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', terminate);
        if (error) return reject(error);
        const line = output.split('\n').findLast(x => x.startsWith('BRAND_ENTRY_RESULT:'));
        if (code !== 0 || !line) return reject(Error('BRAND_ENTRY.EXECUTION_UNRESOLVED'));
        try { resolve(JSON.parse(line.slice('BRAND_ENTRY_RESULT:'.length))); } catch { reject(Error('BRAND_ENTRY.RESULT_UNVERIFIED')); }
      });
    });
  }
  async recover(call: Call): Promise<Outcome['cleanup']> {
    const quarantine = join(this.config.runtimeRoot, 'browser-quarantine.json');
    let prior: { call: Call } | undefined;
    try { prior = JSON.parse(await fs.readFile(quarantine, 'utf8')); }
    catch (e: any) { if (e.code !== 'ENOENT') throw Error('BRAND_ENTRY.EXECUTOR_QUARANTINED'); }
    if (prior && (prior.call?.campaignId !== call.campaignId || prior.call?.candidateId !== call.candidateId))
      throw Error('BRAND_ENTRY.EXECUTOR_QUARANTINED');
    const result = OutcomeSchema.shape.cleanup.parse(await this.execute('recover', call, AbortSignal.timeout(28000), 28000));
    if (result.status === 'pending') await fs.writeFile(quarantine, JSON.stringify({ call, cleanup: result }), { mode: 0o600 });
    else await fs.rm(quarantine, { force: true });
    return result;
  }
  async discover(seed: Seed, signal: AbortSignal) {
    const call: Call = { campaignId: seed.campaignId, candidateId: seed.candidateId };
    try { await fs.access(join(this.config.runtimeRoot, 'browser-quarantine.json')); throw Error('BRAND_ENTRY.EXECUTOR_QUARANTINED'); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    try {
      const result = OutcomeSchema.parse(await this.execute('discover', seed, signal, 210000));
      if (result.campaignId !== call.campaignId || result.candidateId !== call.candidateId) throw Error('BRAND_ENTRY.RESULT_IDENTITY');
      if (result.cleanup.status === 'pending') await fs.writeFile(join(this.config.runtimeRoot, 'browser-quarantine.json'), JSON.stringify({ call, cleanup: result.cleanup }), { mode: 0o600 });
      return result;
    } catch {
      // An executor failure never repeats business navigation. Preserve its journal,
      // close exact targets separately, and leave the executor quarantined if uncertain.
      const result = baseOutcome(call, signal.aborted ? 'cancelled' : 'failed', signal.aborted ? 'BRAND_ENTRY.CANCELLED' : 'BRAND_ENTRY.EXECUTION_UNRESOLVED');
      result.seed = seed;
      try {
        const state = JSON.parse(await fs.readFile(join(this.config.journalRoot, `${call.campaignId}-${call.candidateId}.json`), 'utf8'));
        if (state.call.campaignId !== call.campaignId || state.call.candidateId !== call.candidateId) throw Error('BRAND_ENTRY.JOURNAL_IDENTITY');
        const partial = OutcomeSchema.parse(state.outcome); result.pages = partial.pages; result.evidence = partial.evidence;
      } catch { /* Keep the terminal execution error, never invent lost evidence. */ }
      try { result.cleanup = await this.recover(call); }
      catch { result.cleanup = { status: 'pending', targetIds: [], checkedAt: new Date().toISOString() };
        await fs.writeFile(join(this.config.runtimeRoot, 'browser-quarantine.json'), JSON.stringify({ call, cleanup: result.cleanup }), { mode: 0o600 }); }
      return result;
    }
  }
}
