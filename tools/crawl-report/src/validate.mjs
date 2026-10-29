// The request rules of crawlReport.submit that the crawler can check before sending (contract §2, §5).
export const SOURCES = ['amazon', 'costco', 'gnc', 'swanson', 'wholefoods', 'dtc', 'regulatory', 'branded_ingredient', 'clinical_trial'];
const STATUSES = ['completed', 'partial', 'failed'];
const COUNTS = ['targets', 'fetched', 'failed', 'pushed'];

export function problems(report) {
  const out = [];
  if (!SOURCES.includes(report.source)) out.push(`unknown source ${report.source}`);
  if (typeof report.runId !== 'string' || report.runId.length < 1 || report.runId.length > 200) out.push('runId must be 1–200 chars');
  if (!['server-1', 'server-2'].includes(report.server)) out.push(`unknown server ${report.server}`);
  if (!STATUSES.includes(report.status)) out.push(`unknown status ${report.status}`);
  if (!['full', 'partial'].includes(report.scope)) out.push(`unknown scope ${report.scope}`);
  const started = Date.parse(report.startedAt);
  const finished = Date.parse(report.finishedAt);
  if (Number.isNaN(started) || Number.isNaN(finished)) out.push('startedAt and finishedAt must be ISO times');
  else if (finished < started) out.push('finishedAt precedes startedAt');
  else if (finished > Date.now() + 86_400_000) out.push('finishedAt is more than a day in the future');
  for (const key of COUNTS) {
    if (!Number.isInteger(report.counts?.[key]) || report.counts[key] < 0) out.push(`counts.${key} must be a non-negative integer`);
  }
  if (report.status !== 'completed' && !report.error?.code) out.push(`a ${report.status} report needs an error`);
  if (report.ingestRunIds && (!report.ingestRunIds.length || report.ingestRunIds.some((id) => !id || id.length > 200))) {
    out.push('ingestRunIds must be non-empty run ids');
  }
  return out;
}
