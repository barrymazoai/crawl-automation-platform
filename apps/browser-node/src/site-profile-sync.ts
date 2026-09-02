/**
 * 站点 profile 同步：控制面按 host 把 Skill 学到的探索路线托管在对象存储里，
 * 本节点开工前拉到本地 profileDir 交给 Skill 复跑，收工后把本次新学/更新的推回去。
 * 换节点不用搬文件——任何节点拿同一个 token 都能拉到同一份 profile。
 *
 * 文件名沿用 Skill 的 profile-store 约定：<host>-<hash10>.json。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileSha256 } from "@crawl-automation/runtime";

export interface SiteProfileClient {
  siteProfiles(host: string): Promise<{ files: Array<{ fileName: string; sha256: string; byteSize: number; downloadUrl: string }> }>;
  registerSiteProfile(host: string, input: { fileName: string; sha256: string; byteSize: number; profileVersion?: number | null }): Promise<{ uploadUrl: string }>;
  confirmSiteProfile(host: string, fileName: string): Promise<unknown>;
  download(downloadUrl: string, filename: string): Promise<void>;
  upload(uploadUrl: string, filename: string, hash: string, contentType: string): Promise<void>;
}

/** 从 profile 文件名还原 host：去掉末尾的 -<hash10>.json；host 自己可能含 '-'，所以只剥最后一段。 */
export function hostFromProfileFileName(fileName: string): string | null {
  const match = fileName.match(/^(.+)-[0-9a-f]{10}\.json$/i);
  return match ? match[1]!.toLowerCase() : null;
}

export function hostOfUrl(url: string) {
  return new URL(url).hostname.toLowerCase();
}

/** 开工前：把控制面上这个 host 的全部 ready profile 拉到本地。已有且 sha256 相同的跳过。 */
export async function pullSiteProfiles(client: SiteProfileClient, profileDir: string, host: string, log?: (event: object) => void) {
  await fs.mkdir(profileDir, { recursive: true });
  const { files } = await client.siteProfiles(host);
  let pulled = 0;
  for (const file of files) {
    const target = path.join(profileDir, file.fileName);
    const existing = await fileSha256(target).catch(() => null);
    if (existing === file.sha256) continue;
    await client.download(file.downloadUrl, target);
    if (await fileSha256(target) !== file.sha256) throw new Error(`profile ${file.fileName} 下载后 sha256 不一致`);
    pulled += 1;
  }
  log?.({ type: "site_profile_pulled", host, remote: files.length, pulled });
  return { remote: files.length, pulled };
}

/**
 * 收工后：把 profileDir 里本次任务期间写过的 profile 推回控制面。
 * 按 mtime >= since 判断"本次写过"，不限 host——portfolio 站会顺手学到子品牌站的 profile。
 */
export async function pushSiteProfiles(client: SiteProfileClient, profileDir: string, since: Date, log?: (event: object) => void) {
  const names = await fs.readdir(profileDir).catch(() => [] as string[]);
  let pushed = 0; const skipped: string[] = [];
  for (const fileName of names) {
    if (!fileName.endsWith(".json")) continue;
    const host = hostFromProfileFileName(fileName);
    if (!host) { skipped.push(fileName); continue; }
    const filename = path.join(profileDir, fileName);
    const stat = await fs.stat(filename);
    if (stat.mtime < since) continue;
    const sha256 = await fileSha256(filename);
    const profileVersion = await fs.readFile(filename, "utf8").then((text) => {
      const parsed = JSON.parse(text) as { version?: unknown };
      return typeof parsed.version === "number" ? parsed.version : null;
    }).catch(() => null);
    const { uploadUrl } = await client.registerSiteProfile(host, { fileName, sha256, byteSize: stat.size, profileVersion });
    await client.upload(uploadUrl, filename, sha256, "application/json");
    await client.confirmSiteProfile(host, fileName);
    pushed += 1;
    log?.({ type: "site_profile_pushed", host, fileName, profileVersion, byteSize: stat.size });
  }
  if (skipped.length) log?.({ type: "site_profile_skipped_unrecognized", files: skipped });
  return { pushed };
}
