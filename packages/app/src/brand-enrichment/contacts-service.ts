import type { Contact, PositionClassification } from "@crawl-automation/v3-contracts";
import type { BrandEnrichmentRuns, SupplySmartContacts } from "./ports.js";
import type { TitleClassifier } from "./task-ports.js";
import { requireCompanyRun, saveOutput } from "./run-records.js";
import { acceptTitles, reuseTitles, type TitleAnswer } from "./title-answers.js";

export class BrandContactsService {
  constructor(
    private readonly deps: {
      runs: BrandEnrichmentRuns;
      contacts: SupplySmartContacts;
      classifier: TitleClassifier;
    },
  ) {}
  async classify(runId: string, signal: AbortSignal) {
    const run = await requireCompanyRun(this.deps.runs, runId);
    const contacts = await this.deps.contacts.ofCompany(run.companyId, signal);
    const taxonomy = await this.deps.contacts.positionTaxonomy(signal);
    const titles = [
      ...new Set(
        contacts
          .map((contact) => contact.title ?? contact.position)
          .filter((title): title is string => !!title),
      ),
    ];
    const known = titles.length ? await this.deps.contacts.knownPositions(titles, signal) : [];
    const { answers, unknown } = reuseTitles({ titles, known, taxonomy });
    if (unknown.length) {
      const classified = acceptTitles({
        unknown,
        taxonomy,
        answers,
        classified: await this.deps.classifier.classify({ titles: unknown, taxonomy }, signal),
      });
      await saveOutput(this.deps.runs, {
        runId,
        step: "title-classifications",
        output: classified,
      });
    }
    const items = classifications(contacts, answers);
    const result = items.length
      ? await this.deps.contacts.classifyPositions(items, signal)
      : { updated: 0, skipped: 0 };
    await saveOutput(this.deps.runs, {
      runId,
      step: "contacts",
      output: { ...result, total: contacts.length },
    });
    return contacts.length;
  }
}
function classifications(
  contacts: Contact[],
  answers: Map<string, TitleAnswer>,
): PositionClassification[] {
  return contacts.flatMap((contact) => {
    const answer = answers.get(contact.title ?? contact.position ?? "");
    return answer
      ? [
          {
            contactId: contact.id,
            function: answer.function,
            level: answer.level,
            method: answer.method,
          },
        ]
      : [];
  });
}
