import { describe, expect, it } from "vitest";
import type { ApolloOrganization, ApolloTie } from "@crawl-automation/v3-contracts";
import { checkApolloAnswer } from "./apollo-answer.js";
import { brand } from "./fixtures.test-support.js";
import type { ApolloInput } from "./inputs.js";

const organization = { id: "sprout-id", primary_domain: "sprout.example" };
const input = (organizations: ApolloOrganization[] = [organization]): ApolloInput => ({
  brand,
  rounds: [{ query: { by: "domain", domain: "sprout.example" }, organizations }],
  searchesLeft: 2,
});
const accept = (tie: ApolloTie = "domain") => ({
  action: "accept",
  organizationId: "sprout-id",
  tie,
  note: "Supported by the site.",
});

describe("Apollo answer hard ties", () => {
  it.each([
    ["domain", { primary_domain: "www.sprout.example" }],
    ["former_domain", { website_url: "https://old-sprout.example/" }],
    ["linkedin", { linkedin_url: "https://linkedin.com/company/sprout?source=search" }],
    ["name_address", { name: "SPROUT LLC", raw_address: "12 Leaf Road Austin TX" }],
  ] satisfies [ApolloTie, Partial<ApolloOrganization>][])("accepts the %s tie", (tie, facts) => {
    expect(checkApolloAnswer(accept(tie), input([{ id: "sprout-id", ...facts }])).action).toBe(
      "accept",
    );
  });

  it("refuses an organization ID absent from the supplied rounds", () => {
    expect(() => checkApolloAnswer({ ...accept(), organizationId: "invented" }, input())).toThrow(
      expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }),
    );
  });
  it.each([
    ["domain", { primary_domain: "garden.example", name: "Sprout" }],
    ["domain", { primary_domain: "evil-sprout.example" }],
    ["former_domain", { primary_domain: "sprout.example" }],
    ["linkedin", { linkedin_url: "https://linkedin.com/company/garden" }],
    ["name_address", { name: "Sprout LLC", city: "Austin", state: "TX" }],
    ["name_address", { name: "Garden Group", raw_address: brand.address }],
  ] satisfies [ApolloTie, Partial<ApolloOrganization>][])(
    "rejects unsupported %s",
    (tie, facts) => {
      expect(() =>
        checkApolloAnswer(accept(tie), input([{ id: "sprout-id", ...facts }])),
      ).toThrow();
    },
  );
  it("allows parent-only without lending the parent organization to the brand", () => {
    const answer = {
      action: "parent_only",
      organizationId: "parent-id",
      tie: "domain",
      note: "Only Garden Group was found.",
    };
    expect(
      checkApolloAnswer(answer, input([{ id: "parent-id", primary_domain: "garden.example" }])),
    ).toEqual(answer);
    expect(() => checkApolloAnswer(answer, input())).toThrow();
  });
  it("supports former-domain and legal-name alternatives", () => {
    for (const query of [
      { by: "domain", domain: "old-sprout.example" },
      { by: "name", name: "Sprout LLC" },
    ]) {
      expect(checkApolloAnswer({ action: "search", query }, input()).action).toBe("search");
    }
  });
  it("requires the judge's tie for parent-only material instead of inventing one", () => {
    expect(() =>
      checkApolloAnswer(
        {
          action: "parent_only",
          organizationId: "parent-id",
          note: "Only the parent was found",
        },
        input([{ id: "parent-id", primary_domain: "garden.example" }]),
      ),
    ).toThrow(expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }));
  });
  it("refuses exhausted, repeated and invented searches", () => {
    const search = { action: "search", query: { by: "name", name: "Sprout" } };
    expect(() => checkApolloAnswer(search, { ...input(), searchesLeft: 0 })).toThrow();
    expect(() =>
      checkApolloAnswer(
        { action: "search", query: { by: "domain", domain: "https://www.sprout.example/" } },
        input(),
      ),
    ).toThrow();
    expect(() =>
      checkApolloAnswer({ action: "search", query: { by: "name", name: "Garden Group" } }, input()),
    ).toThrow();
  });
  it.each(["invalid json", { action: "guess" }, { ...accept(), tie: "similar_name" }])(
    "refuses malformed answers",
    (raw) => {
      expect(() => checkApolloAnswer(raw, input())).toThrow(
        expect.objectContaining({ code: "BRAND_RESEARCH.ANSWER_INVALID" }),
      );
    },
  );
});
