import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ageDays, envLabel, failureCard, latestPush, overdueCard, redact, successCard } from '../src/alert.mjs';

const report = (over = {}) => ({
  runId: 'customs-2026-12-12T16:00:00Z',
  fetchedAt: '2026-12-12T16:00:00Z',
  supplySmart: 'app.supplysmart.net',
  window: { from: '2023-11', to: '2026-10', months: 36 },
  codes: 74,
  rows: 24500,
  pushed: true,
  counts: { rows: { inserted: 700, updated: 12, restored: 0, unchanged: 23788, removed: 3 } },
  ...over,
});

describe('envLabel', () => {
  it('names test and production', () => {
    assert.equal(envLabel('app.supplysmart.net'), '生产环境');
    assert.equal(envLabel('test.supplysmart.net'), '测试环境');
    assert.equal(envLabel('localhost:8292'), 'localhost:8292');
  });
});

describe('redact', () => {
  it('removes every env value and any key= parameter', () => {
    const fake = 'FAKE-SECRET-0123456789';
    const out = redact(`GET /data?get=x&key=abc123&time=1 failed; x-api-key ${fake}`, [fake, 'short']);
    assert.ok(!out.includes(fake));
    assert.ok(!out.includes('abc123'));
    assert.match(out, /key=<redacted>/);
  });
  it('leaves short values alone (no shredding of ordinary words)', () => {
    assert.equal(redact('dry run failed', ['run']), 'dry run failed');
  });
});

describe('successCard', () => {
  it('green, with the environment, window and changes', () => {
    const c = successCard(report());
    assert.equal(c.color, 'green');
    assert.equal(c.title, '美国海关数据已同步（生产环境）');
    assert.match(c.markdown, /最新月份 \*\*2026-10\*\*/);
    assert.match(c.markdown, /新增 700，更新 12，恢复 0，撤回 3；未变 23,788/);
  });
  it('says so when nothing changed', () => {
    const c = successCard(report({ counts: { rows: { unchanged: 24269 } } }));
    assert.match(c.markdown, /本次没有变化（24,269 行未变）/);
  });
});

describe('failureCard', () => {
  it('red, with the stage; a failed dry run wrote nothing', () => {
    const c = failureCard({ host: 'test.supplysmart.net', stage: 'dry', error: 'customsTrade/ingest: HTTP 409', dataDir: '/d' });
    assert.equal(c.color, 'red');
    assert.equal(c.title, '美国海关数据同步失败（测试环境）');
    assert.match(c.markdown, /还没有写入任何数据/);
    assert.match(c.markdown, /HTTP 409/);
  });
  it('a failure before the env file was read still has a title', () => {
    assert.equal(failureCard({ host: null, stage: 'start', error: 'ENOENT', dataDir: '/d' }).title, '美国海关数据同步失败（未知环境）');
  });
});

describe('latestPush / ageDays / overdueCard', () => {
  it('only pushed runs count, newest first', () => {
    const dry = report({ runId: 'dry', fetchedAt: '2026-12-20T00:00:00Z', pushed: false });
    const old = report({ runId: 'old', fetchedAt: '2026-11-12T16:00:00Z' });
    const neu = report({ runId: 'new' });
    assert.equal(latestPush([old, dry, null, neu]).runId, 'new');
    assert.equal(latestPush([dry, null]), null);
  });
  it('age in days; none is Infinity', () => {
    assert.equal(ageDays(report(), new Date('2026-12-15T16:00:00Z')), 3);
    assert.equal(ageDays(null), Infinity);
  });
  it('the card names the last push or its absence', () => {
    const c = overdueCard({ push: report(), days: 40.2, maxDays: 33, label: '生产环境', dataDir: '/d' });
    assert.equal(c.title, '美国海关数据没有按时同步（生产环境）');
    assert.match(c.markdown, /已经 40 天/);
    assert.match(overdueCard({ push: null, days: Infinity, maxDays: 33, label: '测试环境', dataDir: '/d' }).markdown, /没有成功写入的运行/);
  });
});
