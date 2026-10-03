import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DtcAgentFileTransport } from "./file-transport.js";
import { variantCaptureFixture } from "./variant-capture-fixture.js";

let test: Awaited<ReturnType<typeof variantCaptureFixture>>;
beforeEach(async () => {
  test = await variantCaptureFixture();
});
afterEach(async () => {
  await rm(test.root, { recursive: true, force: true });
});

it("isolates mixed flavour text/images and preserves every website variant including sold-out", async () => {
  const members = await test.publish();
  expect(
    members.map((member) => [member.status, member.variant.variantId, member.variant.available]),
  ).toEqual([
    ["ready", "1", false],
    ["ready", "2", true],
  ]);
  expect(new Set(members.map((member) => member.operationId)).size).toBe(2);
  for (const member of members) {
    if (member.status !== "ready") {
      throw new Error(member.status === "review" ? member.reason : "Unexpected mixed fixture");
    }
    const plan = member.planned.sourcePlan;
    const saved = JSON.parse(Buffer.from(test.data.get(plan.source.objectKey) ?? []).toString());
    const projection = saved.evidence;
    expect(test.input.planning.read(saved, member.variant.url, plan.owner).evidence.brandRaw).toBe(
      "Actual Brand",
    );
    expect(projection.variantId).toBe(member.variant.variantId);
    expect(projection.variants).toEqual(test.input.parsed.evidence.variants);
    expect(projection.detailsHtml).toContain(
      member.variant.variantId === "1" ? "Orange peel" : "Berry extract",
    );
    expect(projection.detailsHtml).not.toContain(
      member.variant.variantId === "1" ? "Berry extract" : "Orange peel",
    );
    expect(projection.imageCandidates).toHaveLength(1);
    expect(projection.imageCandidates[0].variantId).toBe(member.variant.variantId);
    expect(member.planned.family).toMatchObject({ differsBy: "flavour" });
    const transport = new DtcAgentFileTransport(test.publication, {
      operationId: member.operationId,
      url: member.variant.url,
      egressId: "test-egress",
    });
    const response = await transport.get(
      new URL(projection.imageCandidates[0].url),
      undefined,
      {},
      new AbortController().signal,
    );
    const bytes = [];
    for await (const chunk of response.body) {
      bytes.push(chunk);
    }
    expect(Buffer.concat(bytes).toString()).toBe(`retained-image-${member.variant.variantId}`);
    const other = test.input.images.find(
      (image) => image.url !== projection.imageCandidates[0].url,
    );
    await expect(
      transport.get(new URL(other?.url ?? ""), undefined, {}, new AbortController().signal),
    ).rejects.toThrow();
  }
  expect(test.input.record.fields).not.toHaveProperty("sku");
  expect(test.input.record.gallery).toHaveLength(2);
});

it("reads legacy single-brand projections while rejecting a mismatched native brand proof", async () => {
  const legacy = { ...test.input.parsed.evidence, brandRaw: test.input.site.siteKey };
  expect(
    test.input.planning.read(legacy, test.input.request.url, test.input.parsed.identity).evidence
      .brandRaw,
  ).toBe(test.input.site.siteKey);
  const [member] = await test.publish();
  if (!member || member.status !== "ready") {
    throw new Error("fixture");
  }
  const plan = member.planned.sourcePlan;
  const saved = JSON.parse(Buffer.from(test.data.get(plan.source.objectKey) ?? []).toString());
  saved.evidence.brandRaw = "Other Brand";
  expect(() => test.input.planning.read(saved, member.variant.url, plan.owner)).toThrow();
});

it.each([
  "missing",
  "duplicate",
  "wrong-state",
  "unarchived-method",
  "changed-original",
  "wrong-gallery",
  "unresolved",
])("keeps the healthy sibling when one variant has %s evidence", async (failure) => {
  const contexts = test.input.review.variantContexts ?? [];
  const context = contexts[0] as Record<string, unknown>;
  if (failure === "missing") {
    contexts.shift();
  }
  if (failure === "duplicate") {
    contexts.push(context);
  }
  if (failure === "wrong-state") {
    context.methodPath = "method-2.json";
  }
  if (failure === "unarchived-method") {
    context.methodPath = "absent.json";
  }
  if (failure === "changed-original") {
    await writeFile(join(test.root, "variant-1.html"), "changed");
  }
  if (failure === "wrong-gallery") {
    context.galleryUrls = [test.input.record.gallery[1]?.url];
  }
  if (failure === "unresolved") {
    contexts[0] = {
      variantId: "1",
      status: "unresolved",
      reason: "Cannot access sold-out option",
      evidence: ["variant-1.html"],
    };
  }
  expect((await test.publish()).map((member) => member.status)).toEqual(["review", "ready"]);
});

it("reports both old unscoped variants as Review without inventing a default formula", async () => {
  delete test.input.review.variantContexts;
  const members = await test.publish();
  expect(members.map((member) => member.status)).toEqual(["review", "review"]);
  expect([...test.data.keys()].some((key) => key.includes("projection.json"))).toBe(false);
});

it.each([
  "missing-review",
  "mixed-gallery",
  "unarchived-proof",
  "changed-final-context",
  "missing-preflight",
])(
  "isolates a variant with %s while retaining the healthy sibling and full inventory",
  async (failure) => {
    const context = (test.input.review.variantContexts ?? [])[0] as Record<string, unknown>;
    if (failure === "missing-review") {
      delete context["galleryReview"];
    }
    if (failure === "mixed-gallery") {
      test.input.review.imageAssignments.forEach((image) => {
        image.variantId = null;
      });
      context["galleryUrls"] = test.input.record.gallery.map((image) => image.url);
    }
    if (failure === "unarchived-proof") {
      const first = (context["galleryReview"] as { evidence: string[] }[])[0];
      if (!first) {
        throw new Error("Fixture gallery missing");
      }
      first.evidence = ["never-observed.png"];
    }
    if (failure === "changed-final-context") {
      context["reason"] = "Changed after preview";
    }
    if (failure === "missing-preflight") {
      const raw = JSON.parse(await readFile(join(test.root, "variant-preflight.json"), "utf8"));
      raw.contexts.shift();
      const index = test.input.files.findIndex((file) => file.path === "variant-preflight.json");
      test.input.files.splice(index, 1);
      await test.save("variant-preflight.json", JSON.stringify(raw));
    }
    const members = await test.publish();
    expect(members.map((member) => member.status)).toEqual(["review", "ready"]);
    expect(members.map((member) => member.variant.sku)).toEqual(["ORANGE", "BERRY"]);
    expect(test.input.record.gallery).toHaveLength(2);
  },
);

it("uses an explicit website-shared scope only when retained and does not infer it from null image bindings", async () => {
  const contexts = test.input.review.variantContexts as Record<string, unknown>[];
  for (const context of contexts) {
    context.methodPath = "base-method.json";
    context.basis = "website-shared";
    context.reason = "Website explicitly names both options for these details";
    context.sharedScope = {
      rule: { source: 0, pointer: "/product/shared_scope" },
      text: "These product details and the shared gallery apply to Orange and Berry.",
    };
    context.difference = { kind: "size", group: "Size" };
  }
  test.input.review.imageAssignments.forEach((image) => {
    image.variantId = null;
  });
  await test.preflight();
  const members = await test.publish();
  expect(members.map((member) => member.status)).toEqual(["ready", "ready"]);
  expect(members[1]).toMatchObject({ planned: { family: { differsBy: "size" } } });
});

it.each(["missing", "quote", "location", "source"])(
  "rejects a %s that does not prove the saved shared-scope statement",
  async (changed) => {
    const context = (test.input.review.variantContexts as Record<string, unknown>[])[0];
    if (!context) {
      throw new Error("Fixture context missing");
    }
    Object.assign(context, {
      methodPath: "base-method.json",
      basis: "website-shared",
      reason: "The same product carousel is displayed for both website variants",
      sharedScope:
        changed === "missing"
          ? undefined
          : {
              rule: {
                source: changed === "source" ? 1 : 0,
                pointer: changed === "location" ? "/product/missing" : "/product/shared_scope",
              },
              text:
                changed === "quote"
                  ? "Invented same-formula claim"
                  : "These product details and the shared gallery apply to Orange and Berry.",
            },
    });
    expect((await test.publish()).map((member) => member.status)).toEqual(["review", "ready"]);
  },
);

it("does not relabel an R2 publication failure as variant ambiguity", async () => {
  vi.spyOn(test.publication, "publish").mockRejectedValue(new Error("R2 unavailable"));
  await expect(test.publish()).rejects.toThrow("R2 unavailable");
});

it("limits an explicit-variant task to the requested website identity", async () => {
  test.input.parsed.identity.variantId = "2";
  const members = await test.publish();
  expect(members).toHaveLength(1);
  expect(members[0]).toMatchObject({
    status: "ready",
    variant: { variantId: "2", sku: "BERRY", price: "34.99" },
  });
});
