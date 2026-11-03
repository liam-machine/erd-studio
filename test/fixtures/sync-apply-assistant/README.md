# A sync plan applied by a real assistant

`syncPlanApply.dbml.test.ts` applies sync plans with a test-only applier
(`test/unit/syncPlanApply.harness.ts`) written from SYNC.md. This folder is
the check on that applier: the same plan, applied by an AI assistant that
read only the installed skill files.

- `plan.json`: the plan, with `generatedAt` blanked. It is the mixed selection
  on `test/fixtures/dbt-project-dbml` after `applyScenario`, written by the
  canvas's Sync (`ERD_SYNC_APPLY_EXPORT=<dir> npx vitest run test/unit/syncPlanApply.dbml.test.ts`
  writes the project before the apply to `<dir>/ai` and the applier's result
  to `<dir>/det`).
- `files/`: every file the assistant changed or created, at its project path.

How it was made (2026-11-03): a Claude Opus session was given `<dir>/ai` and
told to follow `.claude/skills/erd-studio/SYNC.md` and `DBML.md` as installed
by Set Up My AI Helper (HARNESS_VERSION 43). It did not read the applier or
any file in `<dir>/det` before it finished. It was not blind, though: it had
seen the names of the files the applier changed, and the assertions
`syncPlanApply.dbml.test.ts` makes for the other selections. A fresh session that has seen neither
would be a stricter check. It skipped SYNC.md step 3 (`dbt compile`): the
fixture has no warehouse profile. It then ran step 4 (Compare).

Result: the same Compare as the applier's result (no unresolved entry, eight
relationships matched, the same four unselected columns left), the same dbt
tests added, and `erd-studio doctor` reports no DBML error. The files differ
from the applier's only in layout: column alignment, the dbt descriptions
copied as `note`s and `description`s, a `Note` on the new table, and the order
of two Refs in `orders.dbml`.

`syncPlanApply.dbml.test.ts` ("an assistant following SYNC.md…") lays
`files/` over a fresh copy and checks that it still compares the same as the
applier. When the plan changes (the fixture, the scenario or the plan format),
that test fails: export again, have an assistant apply the new plan, and
replace `plan.json` and `files/` with the new result.
