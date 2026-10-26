import { expect, it } from "vitest";
import { failureDetails } from "./review-details.js";

it("redacts signed URLs, credentials and markup before they reach an immutable Review", () => {
  const details = failureDetails({
    message: "outer",
    cause: {
      details: [
        {
          check: "ppd-missing",
          reason: "image https://cdn.example.com/a.jpg?X-Amz-Signature=abc123 refused",
          flags: ["Authorization: Bearer secret-token", "<html><body>blocked</body></html>"],
          evidenceKeys: ["v3/dtc/gallery/a.json", "https://bucket/x?sig=1", "bad key"],
        },
      ],
    },
  });
  const text = JSON.stringify(details);
  expect(details?.check).toBe("ppd-missing");
  expect(details?.evidenceKeys).toEqual(["v3/dtc/gallery/a.json"]);
  for (const leaked of ["X-Amz-Signature", "secret-token", "<html", "sig=1"]) {
    expect(text).not.toContain(leaked);
  }
});

it("redacts a bare error message used as the reason", () => {
  const reason = failureDetails(new Error("fetch https://x.test/p?token=t1 failed"))?.reason;
  expect(reason).toMatch(/^fetch \[/u);
  expect(reason).not.toContain("t1");
});

it("keeps the archived page of a capture that landed off the product page (CAPTURE.LANDING_PAGE)", () => {
  const objectKey = "v3/amazon-html/op-1/original.html";
  const details = failureDetails({
    message: "activity failed",
    cause: {
      details: [
        {
          finalUrl: "https://www.amazon.com/clp/B0DZ582FSX",
          archiveKey: objectKey,
          reason: "landing page /clp/B0DZ582FSX",
          evidence: { objectKey },
        },
      ],
    },
  });
  expect(details).toMatchObject({
    reason: "landing page /clp/B0DZ582FSX",
    evidenceKeys: [objectKey],
  });
});
