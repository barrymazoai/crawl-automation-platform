// Branded-ingredient links and clinical trials (tools/ingredient-intel, Tue/Fri on Server 一): one job pushes
// both, so each pushed run gives two reports. <data>/runs/<run>/report.json is the run's full summary; a run
// that did not push (dry run, or before pushing was switched on) is not a round of Supply Smart data.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const readReport = (file) => readFile(file, 'utf8').then(JSON.parse, () => null);

export async function ingredientIntelReports({ dataDir, crawler }) {
  const runs = join(dataDir, 'runs');
  const reports = [];
  for (const name of (await readdir(runs)).sort()) {
    const run = await readReport(join(runs, name, 'report.json'));
    if (!run) continue;
    if (run.pushed) {
      reports.push(brandedIngredient(run, crawler));
      if (run.push?.trials) reports.push(clinicalTrial(run, crawler));
    } else if (run.ok === false && reports.length) {
      // After the first push, a run that stopped is a failed round.
      reports.push(failed(run, 'branded_ingredient', crawler));
    }
  }
  // A run killed before writing report.json leaves only last-sync.json behind.
  const last = await readReport(join(dataDir, 'last-sync.json'));
  if (last && last.ok === false && !reports.some((r) => r.runId === last.run_id)) {
    reports.push(failed(last, 'branded_ingredient', crawler));
  }
  return reports;
}

function common(run, crawler) {
  const problems = run.problems ?? [];
  return {
    server: 'server-1',
    crawler,
    startedAt: run.started_at,
    finishedAt: run.finished_at ?? run.started_at,
    status: run.ok === false ? 'failed' : problems.length ? 'partial' : 'completed',
    scope: 'full',
    ...(run.ok === false || problems.length
      ? { error: { code: run.ok === false ? 'run_failed' : 'run_problems', message: problems.map(String).join('; ').slice(0, 500) || 'run did not finish' } }
      : {}),
  };
}

function brandedIngredient(run, crawler) {
  const pushed = run.push?.links?.pushed ?? {};
  const names = run.names ?? {};
  return {
    source: 'branded_ingredient',
    runId: run.run_id,
    ...common(run, crawler),
    // Every Supply Smart ingredient name is matched again each run.
    counts: {
      targets: names.names ?? 0,
      fetched: names.names ?? 0,
      failed: run.judge?.unanswered ?? 0,
      pushed: (pushed.added ?? 0) + (pushed.restored ?? 0) + (pushed.removed ?? 0),
    },
    breakdown: {
      names: { linked: names.linked_names ?? 0, new_names: names.new_names ?? 0, new_spellings: names.new_spellings ?? 0 },
      links: {
        before: run.push?.links?.before ?? null,
        after: run.push?.links?.after ?? null,
        added: pushed.added ?? 0,
        restored: pushed.restored ?? 0,
        removed: pushed.removed ?? 0,
      },
      model: { asked: run.judge?.asked ?? 0, candidates: run.judge?.candidates ?? 0, review: run.judge?.review ?? 0 },
    },
  };
}

function clinicalTrial(run, crawler) {
  const collect = run.trials?.collect ?? {};
  const push = run.push.trials;
  const counts = push.counts ?? {};
  return {
    source: 'clinical_trial',
    // clinicalTrial.ingest is sent under the delivery's run id, not the job's.
    runId: push.delivery,
    ...common(run, crawler),
    counts: {
      targets: collect.counts?.seen ?? 0,
      fetched: collect.counts?.seen ?? 0,
      failed: collect.requests?.failed ?? 0,
      pushed: push.trials ?? 0,
    },
    breakdown: {
      collect: {
        kept_new: collect.counts?.kept_new ?? 0,
        kept_updated: collect.counts?.kept_updated ?? 0,
        removed: collect.counts?.removed ?? 0,
        stored: collect.counts?.stored ?? 0,
      },
      trials: counts.trials ?? {},
      ingredient_links: counts.ingredientLinks ?? {},
      company_links: counts.companyLinks ?? {},
      product_links: counts.productLinks ?? {},
    },
  };
}

function failed(run, source, crawler) {
  return {
    source,
    runId: run.run_id,
    ...common({ ...run, ok: false }, crawler),
    counts: { targets: 0, fetched: 0, failed: 0, pushed: 0 },
  };
}
