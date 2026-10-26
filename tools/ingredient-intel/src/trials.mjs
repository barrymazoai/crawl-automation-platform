// Step "trials": the ClinicalTrials.gov collector (tools/clinical-trials, KAN-217) in the same scheduled job
// (owner 2026-10-26: trials are refreshed together with the branded ingredients). It runs as its own
// process, unchanged: an incremental collect, then a delivery for Supply Smart. Its first run must be a
// backfill (≈610 pages, ≈6.4 GB archived), which is started by hand, never from here.
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { readJson } from './lib/state.mjs';

const lastLine = (output) => output?.trim().split('\n').at(-1)?.slice(0, 300) ?? '';
// An incremental collect reads a few days of updates (minutes); a hung one must not hold the ingredient steps.
const TIMEOUT_MS = { collect: 2 * 60 * 60_000, deliver: 30 * 60_000 };
const failure = (result, step) => (result.timedOut ? `超时（${TIMEOUT_MS[step] / 60_000} 分钟）被停止` : `退出码 ${result.exitCode}：${lastLine(result.all)}`);
const collectRuns = async (trialsDir) => (await readdir(join(trialsDir, 'runs')).catch(() => [])).filter((d) => d.startsWith('collect-'));

export async function refreshTrials({ toolDir, trialsDir, envFile, log, problem }) {
  const collectorDir = resolve(toolDir, '../clinical-trials');
  const stateFile = join(trialsDir, 'state.json');
  if (!(await readJson(stateFile))?.watermark) {
    problem(`临床试验还没做过全量回填（${trialsDir} 没有 watermark），本次跳过试验`);
    return { skipped: 'no backfill' };
  }
  const run = (step, extra = []) =>
    execa(process.execPath, [`--env-file=${envFile}`, 'src/run.mjs', step, '--data-dir', trialsDir, ...extra], {
      cwd: collectorDir,
      all: true,
      reject: false,
      timeout: TIMEOUT_MS[step],
    });

  const earlier = new Set(await collectRuns(trialsDir));
  const collected = await run('collect', ['--mode', 'incremental']);
  if (collected.exitCode !== 0) {
    problem(`临床试验采集${failure(collected, 'collect')}`);
    return { collect: { exit_code: collected.exitCode ?? null, timed_out: collected.timedOut } };
  }
  // The collector names its runs collect-<ISO time>, complete or not (the state file only records complete
  // runs). Ours is the new one with a manifest: a collect started by hand meanwhile stops at the lock without one.
  let runId = null;
  for (const d of (await collectRuns(trialsDir)).filter((d) => !earlier.has(d)).sort().reverse())
    if (await readJson(join(trialsDir, 'runs', d, 'manifest.json'))) {
      runId = d;
      break;
    }
  const collectManifest = runId ? await readJson(join(trialsDir, 'runs', runId, 'manifest.json')) : null;
  const out = {
    collect: {
      exit_code: collected.exitCode,
      run_id: runId,
      complete: collectManifest?.complete ?? false,
      counts: collectManifest?.counts ?? null,
      requests: collectManifest?.requests ?? null,
    },
  };
  if (!out.collect.complete) problem('临床试验采集没有读完全部页面，水位线没有前移');

  const delivered = await run('deliver');
  if (delivered.exitCode !== 0) {
    problem(`临床试验交付${failure(delivered, 'deliver')}`);
    out.deliver = { exit_code: delivered.exitCode ?? null, timed_out: delivered.timedOut };
    return out;
  }
  const { last_delivery: last } = await readJson(stateFile);
  out.deliver = { exit_code: 0, dir: last.dir, counts: (await readJson(join(last.dir, 'manifest.json')))?.counts ?? null };
  log.info(out, 'trials refreshed');
  return out;
}
