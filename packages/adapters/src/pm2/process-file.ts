import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JobDefinition, JobProcessFile } from "@crawl-automation/app";
import { ecosystem, readEcosystem } from "./ecosystem.js";
import { pm2Errors } from "./pm2-errors.js";

export interface ProcessFileOptions {
  file: string;
  backups: string;
}

/** One ecosystem per machine; preserve original bytes, not a reserialized approximation. */
export class Pm2ProcessFile implements JobProcessFile {
  private previous: string | null | undefined;

  constructor(private readonly options: ProcessFileOptions) {}

  async read(): Promise<JobDefinition[]> {
    const bytes = await readOptional(this.options.file);
    const jobs = bytes === null ? [] : readEcosystem(bytes);
    this.previous = bytes;
    return jobs;
  }

  async replace(jobs: readonly JobDefinition[]): Promise<{ backup: string | null }> {
    const next = `${JSON.stringify(ecosystem(jobs), null, 2)}\n`;
    const current = await readOptional(this.options.file);
    if (this.previous === undefined || current !== this.previous) {
      throw pm2Errors.create("PM2.FILE_CHANGED");
    }
    let backup: string | null = null;
    try {
      backup = await this.backup(current);
      await mkdir(dirname(this.options.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.options.file}.writing-${randomUUID()}`;
      await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.options.file);
      this.previous = next;
      return { backup };
    } catch (error) {
      throw pm2Errors.create("PM2.FILE_WRITE_FAILED", { cause: error, details: { backup } });
    }
  }

  private async backup(bytes: string | null): Promise<string | null> {
    if (bytes === null) {
      return null;
    }
    await mkdir(this.options.backups, { recursive: true, mode: 0o700 });
    const path = join(this.options.backups, `ecosystem.before-${Date.now()}-${randomUUID()}.json`);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    return path;
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
