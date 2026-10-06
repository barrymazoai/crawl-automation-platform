import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadSqlCatalog, migrationBody, validateSqlCatalog } from "./sql-catalog.js";
import { parseMigrationConnection } from "../postgres/migration-repository.js";

const release = fileURLToPath(new URL("../../../../database/v3/", import.meta.url));

// Literal release pins: changing a historical file must not update its expected hash implicitly.
const legacyMigrations = [
  ["001_brand_sources.sql", "1ad9d934f29611281c4c0d8f80b5ffcea1554dbc0191701bddf6e65779b9d938"],
  ["002_api_receipts.sql", "55fc26ce1a01639dec010c7196dff5768fe1f9930ed89cfe667d9553adf04e67"],
  [
    "003_collection_submissions.sql",
    "c76ade02eabfb0c7eaf1e93aa0d7bb9b61ac0db205e4835fc52c52f744143278",
  ],
  ["004_workflow_delivery.sql", "2f5309ddbb844c63ee52e97bb69e1599c576d3b748ed840af855118b34d2a52a"],
  ["005_delivery_scan.sql", "c086e807e06b713243fd716845eea1533b7efd3f083c230b7aa1b6114820ae28"],
  [
    "006_processing_results.sql",
    "04b56ffd8ca33573632b28cc6be2dd164ba6eaded70a938f31d4da964bc43d76",
  ],
  ["007_review_records.sql", "cd3b0ae5a2e362be41b13ed6207dc4254789201baebab21e4804f5d112311381"],
  [
    "008_collected_products.sql",
    "c40a306991f06d2c62c8707fd7d6d74fb4bedeadc517d31ca710e5476377f3df",
  ],
  [
    "009_mixed_collected_products.sql",
    "ca531e41b925078a86427a01460b6d4a07d152ae21b0f40889e70f56051cf62a",
  ],
  [
    "010_label_collected_products.sql",
    "47c94e66d4ac8740ccd8da70a2a802b7cb2278e43c492b0ad6d9d9e9331c37be",
  ],
  [
    "011_label_processing_results.sql",
    "711e407819b1db73d88ba7f009e304c7b32ac740e0e7adff28c05dcdc62437a2",
  ],
  [
    "012_packaging_collected_products.sql",
    "dcc9a4d707c022242f33f34b70092dacf74fefbb581af24c4e40a6cf6a26096d",
  ],
  ["013_catalog_presence.sql", "b63b0cf8fb383df668ec326e47fe4e2826a18e839cfe0db52792cc87f67e1112"],
  [
    "014_catalog_product_input.sql",
    "b68df65a3093c8f185facc6729ca6726adc91f4bae20cee003d004370610e79b",
  ],
  [
    "015_resource_admission.sql",
    "a17108d3d5d854aed9b2587f09fe1bd28f10e3768467cd39e12785f79fd6a82e",
  ],
  ["016_visual_wire_v2.sql", "92518bf37aaa7730c08044b2dc1b938753e99838010fd71a28c6add15d77b328"],
  [
    "017_catalog_product_skip.sql",
    "b132d7890dbb2be036e6a51aa33fc9cae429855db49fcf9c7b26a266b39d00b6",
  ],
  ["018_product_history.sql", "727c29d4e353721c5f0a690a596e9e756cf41d131c4e38f63d51b1484a043a10"],
  [
    "019_history_provenance_index.sql",
    "f3b10c5bfdf6b3cb964c0d75f5a6d00b35517ea8cde123e08523ee598d58f648",
  ],
  [
    "020_product_enrichment.sql",
    "6411d818af3d8d29e2abe92ec316ca7f555aea5499574148ae7ee814a2b787e9",
  ],
  [
    "021_submission_guard_per_request.sql",
    "bd8cbcf3d510abee3ca5e6ea344f44b0c98fb21d856d74524882df2363b53a4c",
  ],
  ["022_process_exception.sql", "da8f3e064036e2fdf13309bc28bea2bec0f1ff863a30e8ecb4d09be1e4d60c08"],
  [
    "023_amazon_dynamic_queue.sql",
    "7d1958b2bec8c8334c313432aec20347c39ceb726ee5faeb1325ecedc5d296bc",
  ],
  ["024_amazon_html_fetch.sql", "56cfec756aa5c3046428b00d760637af99acbe84ac2bc2a798fdc57dfb06d55e"],
  ["025_product_runs.sql", "3b07bfa41403536f3e194d7314c84a30f18353da58507df35117eda14d677229"],
  [
    "026_review_evidence_comment.sql",
    "17a88db75cb6aa3b55d2785a80b10601da26c7b67bac7931f5b068100e1e2378",
  ],
  ["027_channel_queue.sql", "42e587f08ecfb009c42f39d61350ed37bbe77ffd4b7fb9fc1fe8c4c691ffec71"],
  ["028_listing_state.sql", "d67875465fe22250e1cbcf4ef8fc60846a9e09e60dc9a4225878f6b9269766d3"],
  ["029_formula_link.sql", "1bd9852d9915c573537806c8c8e3e643f84a5660928e2d03e99cca9072b6a654"],
  ["030_brand_scan.sql", "f0976e1147f3d7457124977dbee4b6240fdb6c7d3967e48493814442b9dad403"],
  ["031_history_grants.sql", "a98db8628f14aa13309144c36f54d0c8bf707164f69ef2b3255773e375a51ccd"],
];

describe("release SQL catalog", () => {
  it("pins all 001–052 names and hashes in order", async () => {
    const catalog = await loadSqlCatalog(release);
    expect(catalog).toHaveLength(52);
    expect(catalog.map(({ name, sha256 }) => [name, sha256])).toEqual([
      ...legacyMigrations,
      [
        "032_brand_scan_amazon.sql",
        "65843e727968a5898f77f58850fe17bac8ca4d8648a08c76f3daf7cb5189566b",
      ],
      ["033_html_capture.sql", "76238d6091bedfecccc8ffd956c4c16caf00ec53bbbc1e77b665e144c86e9ec0"],
      [
        "034_amazon_queue_to_shared.sql",
        "48c557b965b4a32fd3c2e76da013ebb5c66948cda10dd1696064c4319ce53a83",
      ],
      [
        "035_html_capture_grants.sql",
        "718ac4d05626e331bcc666684a0e8d2c9f1495e9ef34b16314ee57a6c674cdc7",
      ],
      [
        "036_brand_scan_capacity.sql",
        "1ce8c3659622f4a281db90fc5511c4a927eb4a824d0a9de275290ae5657eccfe",
      ],
      [
        "037_wholefoods_brand_scan_capacity.sql",
        "c46077be3d5f657e709175ad85d04ff66b08e7633435999c536137b3f66b2fd7",
      ],
      [
        "038_costco_brand_scan_capacity.sql",
        "ae88a07cd47d8801e646577fec76458ebc8ad3d900ce9b215bfcb2f5bc423201",
      ],
      [
        "039_shared_enrichment.sql",
        "ea58f192cbb70f3705b4f5359bd7c2637be7f446caaba8f03b53b70afa601924",
      ],
      [
        "040_queue_followers_family_outcomes.sql",
        "727271d20210ed9c26d3c0d5b923648898e4f51c17f95994c0a177c438e882bd",
      ],
      [
        "041_usage_attribution.sql",
        "371346765ad7ea48cb33c90b43414b1fe95893f002159f1215e0d64989db520d",
      ],
      [
        "042_permit_stop_proof.sql",
        "33316cc5a57a39845956c659176cc9a3492dc6b0e62985ddeeca1d7e5c5c3d47",
      ],
      [
        "043_formula_lookup_indexes.sql",
        "148d2ee89b5c18a4d05b735b9eb358c8382f9c4d9cf196ae40e70bff9c1cebed",
      ],
      [
        "044_queue_operator_queries.sql",
        "e5b9b181360a8708030f63d4bd55982515985a21ba7d823368dc63c2ece96d8f",
      ],
      [
        "045_brand_scan_cancellation.sql",
        "b26e669f05005261632ca7e9ba7f5dce3a0c11fe17a1373f6e2697df1ad5516f",
      ],
      [
        "046_queue_scan_admission.sql",
        "7be503dd30ff3500209b53d023c61d45fb754047a7b1b5f65c943585825f7afc",
      ],
      [
        "047_dtc_brand_queue_scope.sql",
        "0ad7cf1d4d5d4041f4543584b478f93c8fba5319a157af6074b33e66feee8759",
      ],
      [
        "048_dtc_site_analysis.sql",
        "c008da5a65f1ed8e05a31ae1c196ca39f75563ad7b45c4c30755a3e8c96b3607",
      ],
      [
        "049_server2_browser_capacity.sql",
        "8e20ab1cbfa6948555a45f0814dae371c3627fa9db3f3467922a6f74470f1362",
      ],
      [
        "050_dtc_brand_tasks.sql",
        "4340cde6836a49377fc49ab5453c894d97a97f4e0bd38477bdfccb676b2a621a",
      ],
      [
        "051_label_one_part_products.sql",
        "5c8e6dcfd4729c0fdeadaa5f775a4db99b6dcaf009aefc9abe178ccc90007a97",
      ],
      [
        "052_queue_source_priority.sql",
        "3279be5ae45fe0bc244eb45ca35031223768703f00d25b2d4e7028e618f8900a",
      ],
    ]);
    expect(catalog.at(-1)?.name).toBe("052_queue_source_priority.sql");
  });

  it("preserves bytes and hashes exactly like the old UTF-8 tool", async () => {
    const catalog = await loadSqlCatalog(release);
    for (const migration of catalog) {
      const sql = await readFile(join(release, migration.name), "utf8");
      expect(migration.sha256).toBe(createHash("sha256").update(sql).digest("hex"));
      expect(migration.bytes).toEqual(Buffer.from(sql));
      expect(migrationBody(migration)).toBe(sql.replace(/\bBEGIN;/, "").replace(/COMMIT;\s*$/, ""));
    }
  });

  it.each([
    { names: [] },
    { names: ["002_gap.sql"] },
    { names: ["001_first.sql", "001_duplicate.sql"] },
    { names: ["not_versioned.sql"] },
  ])("rejects empty, missing and duplicate versions: %j", async ({ names }) => {
    const directory = await mkdtemp(join(tmpdir(), "migration-catalog-"));
    for (const name of names) {
      await writeFile(join(directory, name), "BEGIN; SELECT 1; COMMIT;");
    }
    await expect(loadSqlCatalog(directory)).rejects.toMatchObject({
      code: "MIGRATION.CATALOG_INVALID",
    });
  });

  it("loads the specified release, preserving line endings and the original name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "migration-catalog-"));
    const sql = "-- é \r\nBEGIN;\r\nSELECT 1;\r\nCOMMIT;\r\n";
    await writeFile(join(directory, "001_custom.sql"), sql);
    expect(await loadSqlCatalog(directory)).toMatchObject([{ name: "001_custom.sql", sql }]);
  });

  it("rejects reversed catalogs, altered bytes, and missing transaction wrappers", async () => {
    const catalog = await loadSqlCatalog(release);
    expect(() => validateSqlCatalog([...catalog].reverse())).toThrow();
    const original = catalog[0];
    expect(original).toBeDefined();
    if (!original) {
      throw new Error("catalog fixture missing");
    }
    for (const changes of [{ sql: "SELECT 1" }, { sha256: "0".repeat(64) }]) {
      expect(() => validateSqlCatalog([{ ...original, ...changes }])).toThrow();
    }
  });
});

describe("migration target", () => {
  it("accepts explicit credentials and returns the exact confirmation target fields", () => {
    expect(
      parseMigrationConnection("postgres://operator:p%40ss@localhost:55432/crawler_v3_dev"),
    ).toEqual({
      host: "localhost",
      port: 55432,
      database: "crawler_v3_dev",
      user: "operator",
      password: "p@ss",
    });
  });

  it.each([
    "",
    "postgres://localhost/crawler_v3_dev",
    "postgres://user:password@localhost/temporal",
    "postgres://user:password@remote.example/crawler_v3_test",
    "postgres://user:password@localhost/crawler_v3_test?host=other",
    "postgres://user:password@localhost/crawler_v3_test#target",
  ])("rejects invalid, unconfirmed or overridden targets: %s", (value) => {
    expect(() => parseMigrationConnection(value)).toThrow(
      expect.objectContaining({ code: "MIGRATION.TARGET_INVALID" }),
    );
  });
});
