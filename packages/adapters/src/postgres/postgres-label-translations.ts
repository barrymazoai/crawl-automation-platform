import { createHash } from "node:crypto";
import type { LabelTranslationStore } from "@crawl-automation/app";
import type { Queryable } from "@crawl-automation/platform";
import { z } from "zod";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const Language = z.string().regex(/^[a-z]{2}$/);
const Row = z.object({ source_text: z.string(), english: z.string() });

/** Printed label texts and their English translation (database/v3/076): append-only, the first one stays. */
export class PostgresLabelTranslations implements LabelTranslationStore {
  constructor(
    private readonly database: Queryable,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async find(language: string, texts: readonly string[]): Promise<Map<string, string>> {
    const found = new Map<string, string>();
    if (!texts.length) {
      return found;
    }
    const rows = await this.database.query(
      `SELECT source_text, english FROM label_translation
        WHERE language = $1 AND source_sha256 = ANY($2::text[])`,
      [Language.parse(language), [...new Set(texts)].map(sha256)],
    );
    for (const row of rows) {
      const { source_text: text, english } = Row.parse(row);
      found.set(text, english);
    }
    return found;
  }

  async save(
    language: string,
    translations: readonly { text: string; english: string }[],
    model: string,
  ): Promise<void> {
    const at = this.now().toISOString();
    for (const { text, english } of translations) {
      await this.database.query(
        `INSERT INTO label_translation (language, source_sha256, source_text, english, model, translated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (language, source_sha256) DO NOTHING`,
        [Language.parse(language), sha256(text), text, english, model, at],
      );
    }
  }
}
