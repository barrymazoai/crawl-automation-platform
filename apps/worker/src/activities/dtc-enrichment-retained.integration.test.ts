import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EnrichmentTitleReader } from "@crawl-automation/app";
import { createDtcAdapter, dtcSitePolicy } from "@crawl-automation/channel-dtc";
import { ChannelRegistry } from "@crawl-automation/channels-core";
import { ArtifactResolver } from "@crawl-automation/platform";
import { decodeEnrichment, enrichmentInput } from "@crawl-automation/processing";
import {
  EnrichmentRequestSchema,
  EnrichmentSubjectSchema,
  LabelCollectedProductSchema,
} from "@crawl-automation/v3-contracts";

const directory = process.env["CRAWL_RETAINED_DTC_ENRICHMENT"];

it.skipIf(!directory)(
  "replays Solaray's retained verified projection into website package metadata",
  async () => {
    if (!directory) {
      throw new Error("Retained evidence directory required; run on a Mini only");
    }
    const retained = JSON.parse(await readFile(join(directory, "input.json"), "utf8"));
    const request = EnrichmentRequestSchema.parse(retained.request);
    const original = EnrichmentSubjectSchema.parse(retained.subject);
    const collection = LabelCollectedProductSchema.parse(retained.collection);
    const bytes = await readFile(join(directory, "projection.json"));
    const noNetwork = async (): Promise<never> => {
      throw new Error("Network forbidden in retained replay");
    };
    const resolver = new ArtifactResolver(
      { read: async () => bytes, retain: noNetwork },
      { read: noNetwork, create: noNetwork },
    );
    const registry = new ChannelRegistry([
      createDtcAdapter([
        dtcSitePolicy({
          siteKey: "solaray.com",
          platform: "shopify",
          catalogUrl: "https://solaray.com/collections/all",
        }),
      ]),
    ]);
    const subject = await new EnrichmentTitleReader(registry, resolver).read(
      request,
      original,
      AbortSignal.timeout(5000),
    );
    expect(subject.websiteVariant).toMatchObject({ variantId: "32703815778364", title: "100 ct" });
    expect(subject.websiteVariant?.evidence.sha256).toBe(request.sourcePlan?.source.sha256);
    const old = enrichmentInput(collection, original.title);
    const current = enrichmentInput(collection, subject.title, subject.websiteVariant);
    expect(current.formulaHash).toBe(old.formulaHash);
    expect(current.inputHash).not.toBe(old.inputHash);
    expect(
      decodeEnrichment(
        JSON.stringify({
          unifiedName: "Zinc Copper",
          baseName: "Zinc Copper",
          form: "capsule",
          variant: { count: 100, size: null, flavor: null, strength: null },
          healthFunctions: [],
          confidence: 1,
          notes: null,
        }),
        current.input,
      ).variant.count,
    ).toBe(100);
    expect(retained.subject).toEqual(original);
  },
);
