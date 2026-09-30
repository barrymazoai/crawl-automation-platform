import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { BrowserRunner } from './browser-runner.js';

describe('Browser quarantine ownership', () => {
  it('cannot clear or overwrite a different attempt quarantine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brand-quarantine-'));
    try {
      const prior = { call: { campaignId: 'campaign-a', candidateId: 'candidate-a' }, cleanup: { status: 'pending', targetIds: ['orphan'] } };
      const marker = join(root, 'browser-quarantine.json'); await writeFile(marker, JSON.stringify(prior));
      const runner = new BrowserRunner('/unused', { cliPath: '/unused', journalRoot: root, runtimeRoot: root }, '/unused');
      const execute = vi.spyOn(runner as any, 'execute');
      await expect(runner.recover({ campaignId: 'campaign-b', candidateId: 'candidate-b' })).rejects.toThrow('EXECUTOR_QUARANTINED');
      expect(execute).not.toHaveBeenCalled(); expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual(prior);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('clears its own quarantine only after a confirmed cleanup result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'brand-quarantine-'));
    try {
      const call = { campaignId: 'campaign-a', candidateId: 'candidate-a' }, marker = join(root, 'browser-quarantine.json');
      await writeFile(marker, JSON.stringify({ call }));
      const runner = new BrowserRunner('/unused', { cliPath: '/unused', journalRoot: root, runtimeRoot: root }, '/unused');
      const execute = vi.spyOn(runner as any, 'execute').mockResolvedValue({ status: 'pending', targetIds: ['orphan'], checkedAt: '2026-09-23T00:00:00.000Z' });
      expect((await runner.recover(call)).status).toBe('pending'); expect(JSON.parse(await readFile(marker, 'utf8')).call).toEqual(call);
      execute.mockResolvedValue({ status: 'closed', targetIds: ['orphan'], checkedAt: '2026-09-23T00:00:01.000Z' });
      expect((await runner.recover(call)).status).toBe('closed'); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
