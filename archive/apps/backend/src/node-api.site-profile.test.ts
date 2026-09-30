import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { mountNodeApi } from "./node-api.js";

/** 站点 profile 三个接口：列出（含下载链接）→ 登记（返回上传链接）→ confirm（HEAD 校验后 ready）。 */
function harness() {
  const rows = new Map<string, any>();
  const repository = {
    async listSiteProfiles(host: string) { return [...rows.values()].filter((r) => r.host === host && r.status === "ready"); },
    async upsertSiteProfile(input: any, keyPrefix: string) {
      const bucketKey = `${keyPrefix ? keyPrefix + "/" : ""}site-profiles/${input.host}/${input.fileName}`;
      rows.set(`${input.host}/${input.fileName}`, { host: input.host, file_name: input.fileName, bucket_key: bucketKey, sha256: input.sha256, byte_size: String(input.byteSize), profile_version: input.profileVersion ?? null, learned_by: input.learnedBy, status: "pending", updated_at: new Date() });
      return { host: input.host, fileName: input.fileName, bucketKey, sha256: input.sha256, byteSize: input.byteSize };
    },
    async getSiteProfile(host: string, fileName: string) { return rows.get(`${host}/${fileName}`) ?? null; },
    async confirmSiteProfile(host: string, fileName: string) { const r = rows.get(`${host}/${fileName}`); r.status = "ready"; return r; },
  };
  const verified: string[] = [];
  const storage = {
    async uploadUrl(key: string) { return `https://r2.test/put/${key}`; },
    async downloadUrl(key: string) { return `https://r2.test/get/${key}`; },
    async verify(key: string) { verified.push(key); },
  };
  const app = new Hono();
  mountNodeApi(app, { repository: repository as any, storage: storage as any, nodeTokens: new Map([["node-token-1234567890abcdef", ["browser"]]]), keyPrefix: "crawl-v2" });
  const call = (method: string, path: string, body?: unknown) => app.request(path, {
    method, headers: { authorization: "Bearer node-token-1234567890abcdef", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { call, verified, rows };
}

describe("site-profile 接口", () => {
  it("登记 → 上传链接落在 site-profiles/<host>/ 前缀下 → confirm 校验后才出现在列表里", async () => {
    const h = harness();
    expect((await (await h.call("GET", "/v1/node/site-profiles/liveowyn.com")).json()).files).toEqual([]);

    const registered = await h.call("POST", "/v1/node/site-profiles/liveowyn.com/files", { nodeId: "win-1", fileName: "liveowyn.com-0123456789.json", sha256: "a".repeat(64), byteSize: 1234, profileVersion: 4 });
    expect(registered.status).toBe(201);
    const { uploadUrl, file } = await registered.json();
    expect(file.bucketKey).toBe("crawl-v2/site-profiles/liveowyn.com/liveowyn.com-0123456789.json");
    expect(uploadUrl).toContain(file.bucketKey);
    // 还没 confirm：不可见
    expect((await (await h.call("GET", "/v1/node/site-profiles/liveowyn.com")).json()).files).toEqual([]);

    const confirmed = await h.call("POST", "/v1/node/site-profiles/liveowyn.com/files/liveowyn.com-0123456789.json/confirm", {});
    expect(confirmed.status).toBe(200);
    expect(h.verified).toEqual([file.bucketKey]);
    const listed = (await (await h.call("GET", "/v1/node/site-profiles/liveowyn.com")).json()).files;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ fileName: "liveowyn.com-0123456789.json", sha256: "a".repeat(64), byteSize: 1234, profileVersion: 4, learnedBy: "win-1" });
    expect(listed[0].downloadUrl).toContain(file.bucketKey);
  });

  it("host 与文件名要合法；未登记的文件 confirm 返回 404", async () => {
    const h = harness();
    expect((await h.call("POST", "/v1/node/site-profiles/liveowyn.com/files", { nodeId: "win-1", fileName: "../etc/passwd", sha256: "a".repeat(64), byteSize: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await h.call("POST", "/v1/node/site-profiles/nope.com/files/nope.com-0123456789.json/confirm", {})).status).toBe(404);
  });
});
