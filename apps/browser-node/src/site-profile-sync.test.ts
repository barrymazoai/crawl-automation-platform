import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostFromProfileFileName, hostOfUrl, pullSiteProfiles, pushSiteProfiles, type SiteProfileClient } from "./site-profile-sync.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function fakeClient(remote: Record<string, string>) {
  const registered: any[] = []; const uploaded: string[] = []; const confirmed: string[] = [];
  const client: SiteProfileClient = {
    async siteProfiles(host) {
      return { files: Object.entries(remote).filter(([name]) => hostFromProfileFileName(name) === host).map(([fileName, text]) => ({ fileName, sha256: sha(text), byteSize: Buffer.byteLength(text), downloadUrl: `mem://${fileName}` })) };
    },
    async registerSiteProfile(host, input) { registered.push({ host, ...input }); return { uploadUrl: `mem://put/${host}/${input.fileName}` }; },
    async confirmSiteProfile(host, fileName) { confirmed.push(`${host}/${fileName}`); },
    async download(url, filename) { await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, remote[url.replace("mem://", "")]!); },
    async upload(url) { uploaded.push(url); },
  };
  return { client, registered, uploaded, confirmed };
}

describe("站点 profile 同步", () => {
  it("文件名 <host>-<hash10>.json 还原 host，host 自带的 '-' 不会被误剥", () => {
    expect(hostFromProfileFileName("liveowyn.com-0123456789.json")).toBe("liveowyn.com");
    expect(hostFromProfileFileName("my-brand.co.uk-abcdef0123.json")).toBe("my-brand.co.uk");
    expect(hostFromProfileFileName("notes.json")).toBeNull();
    expect(hostOfUrl("https://WWW.LiveOwyn.com/collections/all")).toBe("www.liveowyn.com");
  });

  it("开工前只拉本 host 的文件，本地已有且 sha 相同的跳过", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "profiles-"));
    const a = JSON.stringify({ version: 4, site: "a" });
    const { client } = fakeClient({ "liveowyn.com-0123456789.json": a, "other.com-0123456789.json": "{}" });
    expect(await pullSiteProfiles(client, dir, "liveowyn.com")).toEqual({ remote: 1, pulled: 1 });
    expect(await fs.readFile(path.join(dir, "liveowyn.com-0123456789.json"), "utf8")).toBe(a);
    expect(await fs.readdir(dir)).toEqual(["liveowyn.com-0123456789.json"]);
    // 第二次：已是同一份，不再下载
    expect(await pullSiteProfiles(client, dir, "liveowyn.com")).toEqual({ remote: 1, pulled: 0 });
  });

  it("收工后只推本次任务期间写过的 profile，带上 version，登记→上传→confirm 三步齐全", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "profiles-"));
    const old = path.join(dir, "stale.com-0123456789.json");
    await fs.writeFile(old, JSON.stringify({ version: 4 }));
    const past = new Date(Date.now() - 3_600_000); await fs.utimes(old, past, past);
    const since = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await fs.writeFile(path.join(dir, "liveowyn.com-0123456789.json"), JSON.stringify({ version: 4, discovery: {} }));
    await fs.writeFile(path.join(dir, "README.txt"), "ignore");
    const { client, registered, uploaded, confirmed } = fakeClient({});
    expect(await pushSiteProfiles(client, dir, since)).toEqual({ pushed: 1 });
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ host: "liveowyn.com", fileName: "liveowyn.com-0123456789.json", profileVersion: 4 });
    expect(registered[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(uploaded).toEqual(["mem://put/liveowyn.com/liveowyn.com-0123456789.json"]);
    expect(confirmed).toEqual(["liveowyn.com/liveowyn.com-0123456789.json"]);
  });
});
