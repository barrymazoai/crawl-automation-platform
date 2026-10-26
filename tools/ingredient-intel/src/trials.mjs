// Step "trials": the ClinicalTrials.gov collector (tools/clinical-trials, KAN-217) in the same scheduled job
// (owner 2026-10-26: trials are refreshed together with the branded ingredients). It runs as its own
// process, unchanged: an incremental collect, then a delivery for Supply Smart. Its first run must be a
// backfill (≈610 pages, ≈6.4 GB archived), which is started by hand, never from here.
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { readJson } from './lib/state.mjs';

const lastLine = (output) => output?.trim().split('\n').at(-1)?.slice(0, 300) ?? '';

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
    });

  const collected = await run('collect', ['--mode', 'incremental']);
  if (collected.exitCode !== 0) {
    problem(`临床试验采集退出码 ${collected.exitCode}：${lastLine(collected.all)}`);
    return { collect: { exit_code: collected.exitCode } };
  }
  // The collector names its runs collect-<ISO time>; the latest is this one, complete or not (the state
  // file only records complete runs).
  const runId = (await readdir(join(trialsDir, 'runs'))).filter((d) => d.startsWith('collect-')).sort().at(-1);
  const collectManifest = await readJson(join(trialsDir, 'runs', runId, 'manifest.json'));
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
    problem(`临床试验交付退出码 ${delivered.exitCode}：${lastLine(delivered.all)}`);
    out.deliver = { exit_code: delivered.exitCode };
    return out;
  }
  const { last_delivery: last } = await readJson(stateFile);
  out.deliver = { exit_code: 0, dir: last.dir, counts: (await readJson(join(last.dir, 'manifest.json')))?.counts ?? null };
  log.info(out, 'trials refreshed');
  return out;
}
