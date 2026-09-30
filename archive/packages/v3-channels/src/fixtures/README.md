# Retained parser fixtures

The three `swanson-*-public.json` files are small public page projections retained
on 2026-09-09 and 2026-09-10. Amazon's shared in-memory test fixture uses them to
construct a catalog identity. They contain no private configuration, credentials,
HTML documents, or model workspaces. They are test inputs, not production data to
migrate.

Tests read this directory by default; `V3_CHANNEL_FIXTURE_ROOT` overrides it. It is used by the
Amazon HTTP/archive/provider and purchase data-flow tests. These tests use fake
transport and storage; they do not call ScraperAPI or a model.

The `amazon-static-*.html.gz` files are existing retained static parser samples.
