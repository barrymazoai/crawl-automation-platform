import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GncCompanyIdentityState } from "./company-identity-state.js";

describe("GncCompanyIdentityState", () => {
  it("claims one company at a time and recovers interrupted work", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gnc-company-identity-"));
    const state = new GncCompanyIdentityState(path.join(directory, "state.sqlite"));
    state.seed([
      { companyId: "a", companyName: "A", canonicalName: null, website: null },
      { companyId: "b", companyName: "B", canonicalName: null, website: null },
    ]);
    expect(state.claim()?.companyId).toBe("a");
    expect(state.claim()?.companyId).toBe("b");
    expect(state.claim()).toBeNull();
    state.recoverInterrupted();
    expect(state.claim()?.companyId).toBe("a");
    state.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
});
