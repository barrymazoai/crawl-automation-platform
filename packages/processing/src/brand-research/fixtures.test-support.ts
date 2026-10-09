import { sha256 } from "@crawl-automation/platform";
import type {
  ApolloBrandFacts,
  BrandResearch,
  FamilyFinding,
  OwnershipClue,
} from "@crawl-automation/v3-contracts";
import type { ResearchArchive, RetainedPage } from "./archive.js";
import type { BrandResearchDeps } from "./settings.js";

export const subject = { runId: "run-1", brandName: "Sprout", brandUrl: "https://sprout.example/" };
export const brand: ApolloBrandFacts = {
  name: "Sprout",
  domains: ["sprout.example"],
  formerDomains: ["old-sprout.example"],
  legalName: "Sprout LLC",
  address: "12 Leaf Road, Austin, TX",
  linkedinUrl: "https://www.linkedin.com/company/sprout/",
};
export const clue: OwnershipClue = {
  signal: "website_our_brands",
  ownerName: "Garden Group",
  ownerDomain: "garden.example",
  ownerCompanyId: null,
  quote: "Sprout is a Garden Group brand.",
  url: "https://garden.example/brands",
  archiveKey: null,
};
export const family: FamilyFinding = {
  landedUrl: subject.brandUrl,
  redirect: null,
  isNutrition: true,
  shape: "single",
  subBrands: [],
  otherDomains: [],
  clues: [],
  archiveKeys: [],
};
export const research: BrandResearch = {
  description: "Sprout makes nutritional supplements.",
  category: "nutrition",
  keywords: ["supplements"],
  legalName: brand.legalName,
  address: brand.address,
  linkedinUrl: brand.linkedinUrl,
  clues: [],
  checkedUrls: [subject.brandUrl],
  evidence: [{ url: subject.brandUrl, observedAt: "2026-10-09T00:00:00Z" }],
  archiveKeys: [],
};

export function page(url: string, text = "Sprout makes nutritional supplements."): RetainedPage {
  const html = `<html><body><p>${text}</p></body></html>`;
  const hash = sha256(Buffer.from(html));
  return {
    url,
    html,
    observedAt: "2026-10-09T00:00:00.000Z",
    path: "pages/abcd.html",
    sha256: hash,
    byteSize: Buffer.byteLength(html),
    archiveKey: `evidence/${hash}.html`,
  };
}

export function archive(pages = [page(subject.brandUrl)]): ResearchArchive {
  return { pages, archiveKeys: [...pages.map((saved) => saved.archiveKey), "archive.json"] };
}

export function deps(root: string): BrandResearchDeps {
  const config = {
    settings: { provider: "fixture", model: "fixture-model", reasoningEffort: "medium" },
    executable: process.execPath,
    codexHome: root,
    workRoot: root,
    runtimeProfileVersion: "fixture/1",
    timeoutMs: 1000,
  };
  return {
    text: config,
    capture: config,
    ego: { cliPath: process.execPath, taskSpaceId: 7 },
    publication: { publish: async () => undefined },
    workRoot: root,
    skillPaths: { ego: `${root}/SKILL.md`, research: [] },
    environment: {},
  };
}
