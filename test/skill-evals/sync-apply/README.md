# AI sync eval: a real Claude Code applies a sync plan

`npm test` checks SYNC.md with a deterministic applier
(`test/unit/syncPlanApply.harness.ts`, one branch per SYNC.md row, run by
`test/unit/syncPlanApply.dbml.test.ts`). This eval checks the other half: that
an AI assistant, reading only the skill files **Set Up My AI Helper** installs,
lands in the same place as the applier on the same plan.

```bash
npm run eval:sync-ai                    # the real run: Claude Code, about US$0.50–1, 5–10 minutes
npm run eval:sync-ai -- --self-check    # free: the applier stands in for Claude, to check the checks
npm run eval:sync-ai -- --keep          # keep the work folder after a pass too
```

**Run it when SYNC.md (or DBML.md, or the plan format) changes, and before a
release.** It is not part of `npm test` or CI: it needs a signed-in Claude Code
and costs money each run. Nothing under `test/**` ships in the VSIX.

## What it does

1. Copies `test/fixtures/dbt-project-dbml` to `/tmp/erd-sync-ai-XXXX/ai` (a
   short path: the assistant names it in every tool call), installs the AI
   helper with the real `HarnessService` (the Claude Code target: the schema
   skill with SYNC.md and DBML.md, the setup skill, the PreToolUse hook in
   `.claude/settings.local.json`), lays the harness's `applyScenario` over it
   and writes `.erd-studio/.sync-plan.json` through the real provider's Compare
   and Sync. The selection is the "mixed" one from
   `syncPlanApply.dbml.test.ts`: 20 entries that write both sides (a new table,
   new and changed Refs, column types, dbt columns and relationship tests).
2. Copies that project to `det/` and applies the plan there with the
   deterministic applier: the expected end.
3. Runs Claude Code headless in `ai/`:
   ```bash
   claude -p "Apply the ERD Studio sync plan in .erd-studio/.sync-plan.json following .claude/skills/erd-studio/SYNC.md" \
     --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node *)" \
     --output-format stream-json --verbose --setting-sources project,local --strict-mcp-config \
     --no-session-persistence --max-budget-usd 5
   ```
   `--setting-sources project,local` and `--strict-mcp-config` keep this
   machine's user settings, hooks and MCP servers out: the run sees what a
   fresh assistant in the user's repo sees. Each tool call is printed as it
   happens; the raw stream is saved as `transcript.jsonl` in the work folder.
4. Checks `ai/` against `det/`:
   - `doctor` reports no DBML error, and no DBML warning the applier's result
     does not also have;
   - the canvas Compare (the same provider round trip as the unit test) has no
     error, leaves no plan entry unresolved, and equals the applier's: every
     model's columns and every relationship, with status and cardinalities, so
     only the items the selection left out remain;
   - every `.dbml` file holds the same Refs as the applier's (names unquoted,
     a `<` Ref turned round to `>`): each new Ref is in the relationships file
     SYNC.md names, each changed one in place;
   - the schema yml files gained and lost exactly the applier's dbt tests.

   Not failures, but printed as notes: a plan file the assistant left in place
   (SYNC.md step 5 deletes it on success), and files only one side changed.

Exit code 0 when every check passes, 1 when one fails (the work folder is kept:
`diff -r ai det`), 2 when the eval could not run (no `claude`, or the fixture
or scenario changed so the plan or the applier no longer works).

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `CLAUDE_BIN` | `claude` on `PATH` | The Claude Code binary |
| `ERD_EVAL_MODEL` | Claude Code's default | Passed as `--model` |
| `ERD_EVAL_MAX_USD` | `5` | Passed as `--max-budget-usd` |
| `ERD_EVAL_TIMEOUT_MIN` | `20` | The run is killed after this many minutes |

## What to expect

The first run (2026-11-03, HARNESS_VERSION 43, Claude Code 2.1.317) passed every
check in 525 s, 37 turns, US$0.55. The assistant also tried `erd-studio doctor`
and `dbt compile` (SYNC.md step 3), which the allowed tools deny (there is no
dbt here), and so left the plan file in place, asking the user to run both
first. It also copied the dbt descriptions onto the columns it added, which the
applier does not; the checks compare Refs, Compare and tests, not layout or
notes.

`run.mjs` bundles `eval.ts` with esbuild (markdown as text, `vscode` → the test
mock, `vitest` → `vitest-shim.ts`, which gives the harness vitest's own
matchers outside the runner) and compiles it in memory under a file name in
`test/unit/`, so the harness finds the fixtures from its own `__dirname`.
Nothing is written into the repo.

This replaces `test/fixtures/sync-apply-assistant`, a one-off recorded run that
went stale whenever the plan changed.
