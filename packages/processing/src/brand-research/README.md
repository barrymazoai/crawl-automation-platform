# Brand research task adapters

`createBrandResearchTasks(deps)` returns `{ familyCheck, researcher, apolloJudge, reviewer, titles }`.
These structurally implement the frozen application task ports without an upward application import.
Patterns: **Factory**, **Ports and Adapters**, and **Template Method** for the shared capture lifecycle.
Zod validates all model answers; semantic checks enforce hard Apollo ties, cited ownership evidence and title taxonomy.

## Worker wiring

```ts
interface BrandResearchDeps {
  text: CodexTextConfig;
  capture: CodexExecutionConfig;
  ego: EgoSettings;
  publication: Pick<RetainedPublication, "publish">;
  workRoot: string;
  skillPaths: { ego: string; research: string[] };
  environment: NodeJS.ProcessEnv;
}
```

The composition root can construct this from existing worker configuration after checking that the optional
`processing.codex.text`, `browser` and `browser.dtcAgent` sections are present:

```ts
const tasks = createBrandResearchTasks({
  text: config.processing.codex.text,
  capture: config.browser.dtcAgent.codex,
  ego: config.browser.ego,
  publication: parts.publication,
  workRoot: config.processing.codex.text.workRoot,
  skillPaths: {
    ego: config.browser.dtcAgent.egoSkillPath,
    research: [], // Absolute SKILL.md paths, when additional research skills are configured.
  },
  environment: process.env,
});
```

The factory reuses `CodexTextConfigSchema`, `CodexExecutionConfigSchema` and `EgoSettingsSchema`. Both capture
tasks inherit **provider/model/reasoningEffort from `text.settings`**, overriding the DTC capture model selection;
configure Luna / medium in that existing text setting. Capture executable, home, timeout and disabled-server
settings come from `capture`. The platform sanitizes the subprocess environment. No Apollo key is passed in a prompt.
The application owns permits, Apollo calls/search budget, family admission/fan-out and task scheduling. In particular,
two browser tasks must not concurrently own the same exclusive Ego resource. No new client, CLI or service is added.

## Web search

`CodexCaptureInput.webSearch` (platform, default `"disabled"`) is passed through `captureArguments` as
`-c web_search="live"` after the inherited settings. The research task passes `"live"`; family passes
`"disabled"`. The prompt requires a blocked response when native search is unavailable, and an answer without
`webSearchUsed: true` raises `BRAND_RESEARCH.SEARCH_UNAVAILABLE`.

## Retained evidence and cleanup

Each capture has a new private workspace under `workRoot/brand-research/<run hash>/`, a host-owned Ego page and
hashed skill references. The fixed `save-page.mjs` module saves the page's rendered HTML without rewriting it,
with actual URL, observation time, byte count and SHA-256. It is a reusable snapshot method, not a content extractor.

The host closes the exact page in `finally` via `EgoAgentPage.close` before publishing retained materials.
That platform call verifies target absence and preserves user-control boundaries. `outcome.json` distinguishes
verified absence from pending cleanup, and failure/cancellation still archives saved materials using an independent
bounded signal. Cleanup errors cannot yield a successful task. All original workspaces remain available locally.

Publication uses the existing `RetainedPublication.publish` port, including its immutable local retention and
R2 read-back verification. Page archive keys contain the content hash; `archive.json` maps URLs/times/hashes to
those keys. The host fills `archiveKeys` and clue `archiveKey`; the model cannot provide external archive references.
No product extraction, application decision, retry, import or database access occurs here.

The task envelope is internal (`status`, `result`, `reason`, `webSearchUsed`); callers receive only the frozen
contract result after validation. A failed model answer remains in retained capture records when supplied by the
real capture runner.
