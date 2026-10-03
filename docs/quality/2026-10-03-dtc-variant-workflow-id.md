# DTC descendant workflow ID — CRAWLV3-177

Status: implementation and regression checks in progress; not deployed.

HMW run `1ec309df-1094-4e91-9681-b4eb282dfd7d` passed the 30 Day variant source preflight. The old child name concatenated `product-run-<UUID>`, `dtc-variant-<64 hex>` and then `-label`. This exceeded the resource ledger's 120-character execution ID contract. Label history event 38 rejected `reserveResources` with Zod's workflowId regex error, before any `ocrFile` activity. The receipt step subsequently reported `RECEIPT.OCR_UNCONFIRMED`; no OCR service retry is warranted. The complete failed history is retained on Server 一 at `manual-releases/dtc-native-20261002/variant176-hmw-label-history.json`.

New variant child workflows use `dtc-variant-<Temporal replay-safe UUID>`. This stays bounded, leaves room for Label/enrichment descendants and isolates independent parent executions. Operation IDs and variant evidence remain unchanged in child arguments/results. The `dtc-variant-workflow-id-v1` patch preserves old naming when replaying previous histories; resource contracts are not widened and permission/cleanup rules are unchanged.

Regression coverage uses production-length parent and variant operation IDs and parses actual ResourceRequestSchema in test activities. It must reach both the OCR and enrichment resource gates, keep siblings isolated, release every permit and replay pre-patch histories. Tests use isolated Temporal on Mini; no provider activity runs on the MacBook. Existing failed Review and originals remain unchanged. Any downstream acceptance will be a separately identified manual run using retained source evidence, without a website recapture.
