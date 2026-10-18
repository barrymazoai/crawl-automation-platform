// Read-only accessors over one API v2 study ({ protocolSection, hasResults }).

export const nctId = (s) => s.protocolSection?.identificationModule?.nctId;
export const lastUpdate = (s) => s.protocolSection?.statusModule?.lastUpdatePostDateStruct?.date ?? null;

/** Lead sponsor and collaborators with their role: the only fields brand links may come from. */
export function parties(s) {
  const m = s.protocolSection?.sponsorCollaboratorsModule ?? {};
  const out = [];
  if (m.leadSponsor?.name) out.push({ role: 'lead_sponsor', name: m.leadSponsor.name, class: m.leadSponsor.class ?? null });
  for (const c of m.collaborators ?? []) if (c?.name) out.push({ role: 'collaborator', name: c.name, class: c.class ?? null });
  return out;
}

export const interventions = (s) => s.protocolSection?.armsInterventionsModule?.interventions ?? [];
export const armGroups = (s) => s.protocolSection?.armsInterventionsModule?.armGroups ?? [];

const PLACEBO = /\b(placebo|sham|control (product|supplement|group)|vehicle)\b/i;
export const isPlacebo = (intervention) => PLACEBO.test(`${intervention.name ?? ''} ${(intervention.otherNames ?? []).join(' ')}`);

/**
 * The text fields a product or ingredient may be named in, each with the field name used as evidence.
 * Summaries and eligibility are left out on purpose: they mention products a trial does not test.
 */
export function namedFields(s) {
  const p = s.protocolSection ?? {};
  const out = [];
  interventions(s).forEach((iv, i) => {
    out.push({ field: `interventions[${i}].name`, text: iv.name, intervention: iv });
    (iv.otherNames ?? []).forEach((name, j) => out.push({ field: `interventions[${i}].otherNames[${j}]`, text: name, intervention: iv }));
    if (iv.description) out.push({ field: `interventions[${i}].description`, text: iv.description, intervention: iv });
  });
  armGroups(s).forEach((arm, i) => {
    if (arm.description) out.push({ field: `armGroups[${i}].description`, text: arm.description, arm });
  });
  if (p.identificationModule?.briefTitle) out.push({ field: 'briefTitle', text: p.identificationModule.briefTitle });
  if (p.identificationModule?.officialTitle) out.push({ field: 'officialTitle', text: p.identificationModule.officialTitle });
  (p.conditionsModule?.keywords ?? []).forEach((k, i) => out.push({ field: `keywords[${i}]`, text: k }));
  return out;
}

export const isDietarySupplement = (s) => interventions(s).some((iv) => iv.type === 'DIETARY_SUPPLEMENT');
