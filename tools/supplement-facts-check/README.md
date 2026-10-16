# Supplement Facts check

Finds synced products whose label has ingredients but no formula (Supply Smart `FORMULA_MISSING`) although one of
their gallery images prints a Supplement Facts panel — formulas the label pipeline missed. Owner request 2026-10-16.
It only finds candidates; it never writes to Supply Smart or the crawler database. Manual start only.

1. `export-products.sql`: run read-only against the Supply Smart database on a machine that holds its connection
   string; writes `manifest.tsv` (channel, external ID, product ID, image source, image URL). Data, not code: copy it
   to the run directory, never into git.
2. `node check.mjs <manifest.tsv> <runDir> [--ocr http://192.168.68.69:8081] [--lanes 1]` on Server 一: downloads
   each image, reads it with our Windows OCR service, appends one line per image to `<runDir>/images.jsonl`, and writes
   `<runDir>/products.tsv` at the end. Resumable: images already read are skipped; errors are tried again on the
   next start. SIGTERM finishes the current image and stops. Each OCR call carries a job ID and is cancelled when the
   tool gives up on it.
3. One OCR lane is lent from production: lower the `windows-ocr` capacity by one while the check runs and restore it
   afterwards (the tool does not take a resource permit itself).

`products.tsv` verdicts: `supplement-facts` (heading found — a missed formula), `facts-table-no-heading` (serving size
and daily value words without a heading — look at the image), `drug-facts`, `nutrition-facts`, `none`, `unfinished`.
