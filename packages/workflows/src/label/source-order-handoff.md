# R52 handoff — CRAWLV3-125

Implementation is left in the shared working tree. No commit, push, branch, deployment, migration, paid request, or production operation was performed.

## Integration required from R53 / the owner

For **new** channel plan operations, pass:

```ts
sourcePolicy: {
  version: "label-sources/1",
  order: "images-first" // or "text-first"
}
```

Use the exported channels-core `labelSourcePolicy(channel, optionalOrderOverride)` for defaults:
Amazon and `wholefoods-amazon-formula` use images first; GNC, Swanson, Costco and DTC use text first.

In `packages/app/src/pipeline/label-tasks.ts`, copy `sourcePlan.sourcePolicy` into the label task only when present.
That file was intentionally not edited. Keep `evidencePolicy: "label-image-first/6"`.
Do not add sourcePolicy to an old saved plan or a replayed handoff; opt in with a new plan/task operation.
No migration is required.

The worker's existing `inspectLabelImage` activity also accepts ordered progress requests (`{ input, states }`);
`prepareSingleLabelManifest` selects their final manifest. No new activity registration is needed.

## Behavior and safeguards

- Source ordering is versioned independently of the merge policy. Old inputs retain the old parallel flow or /5 walk.
- New plans retain inactive image fallback descriptors even when deterministic page facts are complete.
- A deterministic label-section check admits partial facts or Ingredients text; marketing-only text never invokes the text model.
- The child requests one image at a time. URL hints rank product-owned images; existing OCR keyword screening decides whether to invoke vision.
- Every attempted answer is re-read from its original evidence and exact registered task. The existing /6 merger decides completeness and conflicts. Two complementary panels can complete one label.
- Once a complete label is verified, remaining models, OCR operations and image downloads are skipped. Packaging admission can still prepare a full page document without invoking its model.
- Unknown execution, unverified evidence and identity conflicts stop in Review. Failed operations never retry themselves.
- Selected/skipped sources and reasons are logged; successful selection decisions are retained with the manifest. The source that progressed furthest supplies the primary Review reason, including when a later fallback file fails.
- Temporal markers: `label-source-order-v1` and `label-demand-files-v1`, both gated by the new input field.

## Files changed in the assigned area

- `packages/channels/core/src/planning/source-order.ts`
- `packages/channels/core/src/planning/source-order.test.ts`
- `packages/channels/core/src/planning/index.ts`
- `packages/channels/core/src/planning/plan-sources.ts`
- `packages/channels/core/src/planning/product-plans.test.ts`
- `packages/processing/src/label/label-plan-model.ts`
- `packages/processing/src/label/label-plans.ts`
- `packages/processing/src/label/label-selection.ts`
- `packages/processing/src/label/selection-model.ts`
- `packages/processing/src/label/ordered-model.ts`
- `packages/processing/src/label/ordered-evidence.ts`
- `packages/processing/src/label/ordered-selection.ts`
- `packages/processing/src/label/ordered-fixture.ts`
- `packages/processing/src/label/ordered-selection.test.ts`
- `packages/workflows/src/label/label-model.ts`
- `packages/workflows/src/label/label-workflow.ts`
- `packages/workflows/src/label/label-finish.ts`
- `packages/workflows/src/label/label-image-first.ts`
- `packages/workflows/src/label/label-stream.ts`
- `packages/workflows/src/label/label-demand-signals.ts`
- `packages/workflows/src/label/label-demand-feed.ts`
- `packages/workflows/src/label/label-ordered.ts`
- `packages/workflows/src/label/label-ordered.test.ts`
- `packages/workflows/src/label/label-source-order.bundle.test.ts`
- `packages/workflows/src/stream-label.ts`
- `packages/workflows/src/label/label-image-ocr.ts`
- `packages/workflows/src/label/label-stream-failures.ts`
- `packages/workflows/src/label/label-demand-feed.test.ts`
- `packages/workflows/src/label/label-saved-history.test.ts`
- `packages/workflows/src/label/label-workflow.test.ts`
- `packages/channels/core/src/planning/plan-fragment.ts`
- `packages/workflows/src/label/label-admission.ts`
- `packages/workflows/src/label/label-admission.test.ts`

## Necessary shared additive edits

- `packages/v3-contracts/src/channel-plan.ts`: optional sourcePolicy and labelPreparation schemas/fields. Existing inputs and outputs have no added defaults.
- `apps/worker/src/label/label-steps.ts`: forward labelPreparation from the verified plan and provide the existing verified source reader to selection. Other agents' measurement edits in this file were preserved.
- `packages/app/src/pipeline/label-reviews.ts`: optional primaryFailure evidence and use its code as the Review reason.

Assembly/merge policy, channel packages, product pipeline/collection workflows and label-tasks.ts were not edited.

## Verification

- `pnpm --filter @crawl-automation/channels-core exec vitest run src/planning`: 22 passed.
- `pnpm --filter @crawl-automation/processing exec vitest run src/label`: 123 passed. The final targeted `src/label/ordered-selection.test.ts` run passed 13 cases, including two additional preparation-conflict safeguards (125 distinct processing cases across these runs).
- Workflow unit/bundle files: label-workflow, label-ordered, label-demand-feed, label-admission, label-activity-options and label-source-order.bundle: 50 passed.
- All three assigned packages passed `run check-types`.
- ESLint passed all assigned files and the two edited shared application/worker files. Prettier checks passed those files. The compressed legacy contracts file received only additive edits and was not reformatted.
- `git diff --check` passed the edited paths.

The serverless saved-history replay test is present in `label-saved-history.test.ts`.
It was skipped because `CRAWLER_LABEL_REPLAY_HISTORY` was not supplied. Set it to an external, pre-source-order LabelWorkflow history JSON and run that test to verify the actual history against the current bundle.
Existing server-backed label replay/heartbeat tests were not run: common rules prohibit starting a Temporal test server here.
No browser/provider/end-to-end acceptance was run on this MacBook.

Open acceptance work: R53 configuration/task passthrough, a supplied historical replay, and one manually started product acceptance on the execution machines after the main session's Git deployment.
