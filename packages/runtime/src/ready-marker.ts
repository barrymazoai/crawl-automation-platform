import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * v2 流水线的原子发布原语（泛化 apps/browser-node/scripts/publish-capture-batch.mjs 的模式）。
 *
 * 约定：一个阶段把全部产物写进目录后，最后调用 publishReadyMarker 放置 `<name>` 标记；
 * 下游只消费带标记的目录。标记不可覆盖——重复发布同名标记会抛错，内容不一致的重试
 * 因此会被暴露而不是被静默吞掉。
 */

export async function writeJsonAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}

export async function publishReadyMarker(directory: string, name: string, payload: unknown) {
  const markerPath = path.join(directory, name);
  const temporary = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  try {
    // link 在目标已存在时抛 EEXIST：不可覆盖守卫是原子的，没有先检查后写入的竞态窗口。
    await fs.link(temporary, markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`ready 标记已存在，禁止覆盖: ${markerPath}`);
    }
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return markerPath;
}

export async function readReadyMarker<T = unknown>(directory: string, name: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function hasReadyMarker(directory: string, name: string) {
  return (await readReadyMarker(directory, name)) !== null;
}

/** 列出 root 下所有带指定 ready 标记的子目录（按名称排序），供下游轮询消费。 */
export async function listReadyDirectories(root: string, name: string) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const ready: string[] = [];
  for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (await hasReadyMarker(path.join(root, entry.name), name)) ready.push(path.join(root, entry.name));
  }
  return ready;
}
