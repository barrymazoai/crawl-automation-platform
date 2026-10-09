import type { SupplySmartContacts } from "@crawl-automation/app";
import {
  ContactSchema,
  KnownPositionSchema,
  PositionClassificationResultSchema,
  PositionTaxonomySchema,
  type PositionClassification,
} from "@crawl-automation/v3-contracts";
import { z } from "zod";
import type { SupplySmartRpc } from "./supply-smart-rpc.js";

/** Contacts and position classification (spec §2.7): reuse known titles, classify only the rest. */
export class SupplySmartContactsClient implements SupplySmartContacts {
  constructor(private readonly rpc: SupplySmartRpc) {}

  ofCompany(companyId: string, signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "contact.getByCompanyId",
        input: { companyId },
        answer: z.array(ContactSchema),
      },
      signal,
    );
  }

  positionTaxonomy(signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "contact.positionTaxonomy",
        input: {},
        answer: PositionTaxonomySchema,
      },
      signal,
    );
  }

  async knownPositions(titles: string[], signal: AbortSignal) {
    const answer = await this.rpc.call(
      {
        api: "database",
        path: "contact.knownPositions",
        input: { titles },
        answer: z.object({ positions: z.array(KnownPositionSchema) }),
      },
      signal,
    );
    return answer.positions;
  }

  classifyPositions(items: PositionClassification[], signal: AbortSignal) {
    return this.rpc.call(
      {
        api: "database",
        path: "contact.classifyPositions",
        input: { items },
        answer: PositionClassificationResultSchema,
      },
      signal,
    );
  }
}
