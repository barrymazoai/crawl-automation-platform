// One API v2 study → one trials.jsonl row. Values are taken as the registry gives them (dates keep
// their precision, "2016-09" or "2024-09-04"); an empty string becomes null so the row fits the contract.

const text = (v) => (typeof v === 'string' && v.trim() ? v : null);
const list = (v) => (Array.isArray(v) && v.length ? v.filter((x) => typeof x === 'string') : null);

export function trialRecord(study) {
  const p = study.protocolSection ?? {};
  const id = p.identificationModule ?? {};
  const status = p.statusModule ?? {};
  const design = p.designModule ?? {};
  const sponsors = p.sponsorCollaboratorsModule ?? {};
  const nct = id.nctId;
  const enrollment = design.enrollmentInfo?.count;
  return {
    nct_id: nct,
    title: text(id.briefTitle),
    official_title: text(id.officialTitle),
    overall_status: text(status.overallStatus),
    why_stopped: text(status.whyStopped),
    start_date: text(status.startDateStruct?.date),
    start_date_type: text(status.startDateStruct?.type),
    primary_completion_date: text(status.primaryCompletionDateStruct?.date),
    primary_completion_date_type: text(status.primaryCompletionDateStruct?.type),
    completion_date: text(status.completionDateStruct?.date),
    completion_date_type: text(status.completionDateStruct?.type),
    first_posted: text(status.studyFirstPostDateStruct?.date),
    last_update: text(status.lastUpdatePostDateStruct?.date),
    study_type: text(design.studyType),
    phase: list(design.phases),
    primary_purpose: text(design.designInfo?.primaryPurpose),
    enrollment: Number.isInteger(enrollment) && enrollment >= 0 ? enrollment : null,
    enrollment_type: text(design.enrollmentInfo?.type),
    conditions: list(p.conditionsModule?.conditions),
    keywords: list(p.conditionsModule?.keywords),
    interventions: (p.armsInterventionsModule?.interventions ?? [])
      .filter((iv) => text(iv.name))
      .map((iv) => ({
        name: iv.name,
        type: text(iv.type),
        description: text(iv.description),
        otherNames: list(iv.otherNames),
        armGroupLabels: list(iv.armGroupLabels),
      })),
    lead_sponsor: text(sponsors.leadSponsor?.name),
    lead_sponsor_class: text(sponsors.leadSponsor?.class),
    collaborators: (sponsors.collaborators ?? []).filter((c) => text(c.name)).map((c) => ({ name: c.name, class: text(c.class) })),
    primary_outcomes: (p.outcomesModule?.primaryOutcomes ?? [])
      .filter((o) => text(o.measure))
      .map((o) => ({ measure: o.measure, description: text(o.description), timeFrame: text(o.timeFrame) })),
    brief_summary: text(p.descriptionModule?.briefSummary),
    // Every reference type, as supplier-intel did; raw.protocolSection.referencesModule keeps the types.
    publications_linked: list((p.referencesModule?.references ?? []).map((r) => r.pmid).filter(Boolean)),
    has_results: typeof study.hasResults === 'boolean' ? study.hasResults : null,
    source_url: `https://clinicaltrials.gov/study/${nct}`,
    raw: study,
  };
}
