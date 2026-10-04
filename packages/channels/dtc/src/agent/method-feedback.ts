import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const Feedback = z.strictObject({
  codec: z.literal("dtc-method-feedback/1"),
  entries: z.array(
    z.strictObject({
      origin: z.url(),
      sha256: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
      tickets: z.array(z.string().min(1)).min(1),
      observation: z.string().min(1),
      correction: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
});

/** Carry verified defects with the exact cached revision, never with unrelated methods. */
export async function prepareMethodFeedback(input: {
  skillRoot: string;
  cwd: string;
  origin: string;
  sha256: string;
}) {
  const catalog = Feedback.parse(
    JSON.parse(await readFile(join(input.skillRoot, "methods/product-feedback.json"), "utf8")),
  );
  const entries = catalog.entries.filter(
    (entry) => entry.origin === input.origin && entry.sha256.includes(input.sha256),
  );
  if (entries.length) {
    await writeFile(
      join(input.cwd, "method-feedback.json"),
      JSON.stringify({ codec: catalog.codec, origin: input.origin, sha256: input.sha256, entries }),
      { flag: "wx" },
    );
  }
}
