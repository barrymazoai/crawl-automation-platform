# Coding rules

These rules apply to the restructured folders (`apps/{api,worker,cli}`, `packages/{app,workflows,channels,processing,
platform}`). Each rule is checked by a tool; older code comes under them as it moves.

| Command | Checks |
|---|---|
| `pnpm lint` | ESLint (`eslint.config.js`) and Prettier (`.prettierrc.json`) |
| `pnpm check:deps` | Layer boundaries (`.dependency-cruiser.cjs`) |
| `pnpm check:dupes` | Copied code (`.jscpd.json`) |
| `pnpm check:types` | TypeScript strict mode, every package |
| `pnpm test:v3` | All V3 unit tests (`vitest.v3.config.ts`) |
| `pnpm check` | All of the above except tests |

`lefthook` runs format and lint on staged files before each commit and `pnpm check` before each push.
GitHub Actions (`.github/workflows/ci.yml`) runs everything on every push to main.

## Files and functions

- One file, one job. At most 200 lines per file (400 for tests).
- At most 40 lines per function, 3 parameters (more become one named object), nesting depth 3, complexity 10.
- One statement per line; at most 100 characters per line.
- TypeScript only, strict mode. No `.mjs`.

## Names

- Full words: `requestId`, not `r`. Two characters minimum except `_`, `i`, `x`, `y`.
- Functions are named for what they do (`releasePermit`); files for what they hold (`run-service.ts`).
- No dates or version numbers in file names.

## Layers

- Imports go downward only (see ARCHITECTURE.md). Packages are imported by name, never through `../../x/src`.
- SQL only in repositories (`packages/platform`). HTTP only in `apps/api`. Temporal client only in `packages/platform`.
- A channel never imports another channel; channels and processing never import each other.

## Errors

- Every error code comes from the registry in `packages/platform`.
- Never decide by reading an error's message text; use its code.
- No empty `catch`. An error is handled or passed on.
- A failure is recorded with its real reason, never a generic one.

## Settings and secrets

- No machine paths, host names or IP addresses in code; they come from config.
- Settings are read once at startup and checked with zod. A wrong setting stops the start.
- No secrets in code or git.

## Libraries, not hand-written code

| Need | Library |
|---|---|
| HTTP API | tRPC on Hono (`@hono/trpc-server`), zod for input |
| Logging | pino; every line carries the run ID; no `console` |
| Dates and durations | date-fns |
| Wiring | awilix, one container per app |
| Command-line arguments | commander |
| Tests | vitest |

## Shared code

- Code needed by two channels moves to `packages/channels/core` or `packages/platform`.
- Never copy a file to make a variant of it.

## Operations

- No one-off scripts. An operation needed twice becomes an API procedure.
- Nothing writes to the database or Temporal except through a service.
- Code reaches a server only through git: commit to main, push, `git pull` on the server.

## Tests

- Every channel adapter is tested against saved real pages in its `fixtures/` folder.
- Every service method has a unit test with fake repositories and gateways.
- After a change, one product runs end to end before any batch.
- A test that documents a known bug uses `it.fails` with a comment giving the reason; remove `.fails` when fixed.
