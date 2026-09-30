import { expect, it } from "vitest";
import { CollectionApiConfigSchema } from "./collection-api.js";

const base = { databaseUrl: "postgres://test", port: 4188, delivery: {}, ui: [] };
it("listens on loopback by default and only on loopback or a Tailscale address", () => {
  expect(CollectionApiConfigSchema.parse(base).host).toBe("127.0.0.1");
  expect(CollectionApiConfigSchema.parse({ ...base, host: "100.76.126.12" }).host).toBe("100.76.126.12");
  for (const host of ["0.0.0.0", "192.168.68.74", "example.com"]) expect(CollectionApiConfigSchema.safeParse({ ...base, host }).success).toBe(false);
});
