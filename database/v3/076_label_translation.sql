BEGIN;
-- KAN-243 (owner 2026-11-11, Germany plan option A): a label's printed text, copied as printed in another language
-- (German on amazon.de), and its English translation. Supply Smart receives the English text; the copy, its evidence
-- and every retained answer keep the printed German. One row per printed text and language, translated once and
-- reused by every later delivery; append-only, the first translation stays in force.
CREATE TABLE label_translation (
  language text NOT NULL CHECK (language ~ '^[a-z]{2}$'),
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_text text NOT NULL CHECK (length(source_text) BETWEEN 1 AND 20000),
  english text NOT NULL CHECK (length(english) BETWEEN 1 AND 20000),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
  translated_at timestamptz NOT NULL,
  PRIMARY KEY (language, source_sha256)
);

-- Append-only for the runtime: no UPDATE or DELETE.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'v3_runtime') THEN
    GRANT SELECT, INSERT ON label_translation TO v3_runtime;
  END IF;
END $$;
COMMIT;
