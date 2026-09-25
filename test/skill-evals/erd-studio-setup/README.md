# `/erd-studio-setup` skill evals

Prompts and expectations for evaluating the setup skill whose source lives in
`src/harness/claude/erd-studio-setup/` (the folder keeps its historical `claude/` name; the
content is tool-neutral and installs into both `.claude/skills/` and `.agents/skills/`). They
follow the skill-creator plugin's `evals.json` schema
(`skill_name`, `evals[].id / prompt / expected_output / files / expectations`), plus four extra
fields per eval that skill-creator ignores:

| Field | Meaning |
|---|---|
| `name` | Descriptive id, used as the run directory name |
| `fixture` | Which project under `test/fixtures/` the run starts from |
| `setup` | What to change in a **temp copy** of the fixture before the run (stub dbt, deleted folders, PATH) |
| `harness` | Which AI assistant runs it: `claude-code` (default), `codex`, `gemini-cli`, `github-copilot` |

Nothing here is run by `npm test`, and `test/**` never ships in the VSIX. These evals need a real
assistant session, so they are run by hand when the skill text changes.

## The cases

| # | Name | Fixture | What it checks |
|---|---|---|---|
| 1 | beginner-no-dbt | `dbt-project-modern-tests` | dbt is optional; the one "where is dbt?" question; plain-language terms; a file-only build |
| 2 | venv-dbt-core | `dbt-project` | Core in `.venv`, dbt run by path, `$ARGUMENTS` honoured, end-to-end clean diff |
| 3 | fusion | `dbt-project` | Triggers without the slash command; Fusion's `compile --write-catalog` |
| 4 | cloud-cli | `dbt-project` | No `profiles.yml` demanded; remote artefacts; file-only fallback |
| 5 | existing-user-with-logical-models | `dbt-project` (as is) | Pre-existing models asked about once, never rewritten; v4 domains → Migrate to v5 |
| 6 | thin-project-sql-only | `dbt-project` minus every yml | Thin-project branch, drafted columns, honest success line |
| 7 | modelling-kimball | `dbt-project` | Approach given up front (beats the detection, no confirm question), lookup + named source, playback, saved `modelling-approach.md`, valid `modelRole`s, still a clean diff, conformance review |
| 8 | modelling-data-vault | `dbt-project` | Detected style confirmed with evidence, then overridden in the user's words; Data Vault mapped onto the closest roles via `rationale.roleChoice`, never an invalid `modelRole` |
| 9 | modelling-not-sure | `dbt-project-modern-tests`, no web tools | "Not sure" to the detected Kimball style = go with it; bundled summary named as the source |
| 10 | modelling-custom-house-rules | `dbt-project` | House rules as an override of the detection: verbatim quote, one clarifying question max, no renames; target design = intentional drift backlog |
| 11 | harness-codex | `dbt-project`, `.agents/skills/` only | `$erd-studio-setup`; schema skill read from `.agents/skills/erd-studio/`; no Claude-only guidance |
| 12 | harness-gemini-plain-sentence | `dbt-project`, `.agents/skills/` only | Activation from a sentence; no slash commands suggested |
| 13 | harness-copilot | `dbt-project`, `.agents/skills/` only | `/erd-studio-setup` in Copilot; no Claude-only guidance |
| 14 | modelling-detected-medallion-kimball | `dbt-project` + bronze models + a snapshot | `inventory.conventions` read, never an open question: one confirm sentence naming medallion (bronze → silver → gold) and Kimball with evidence and a yes default; layout vs style explained; bronze `layers.json` entry |
| 15 | modelling-detected-data-vault-package | `dbt-project` + `automate_dv` in `packages.yml` + hub/sat/lnk models | Data Vault detected (strong, from the package) with Kimball marts as the second part of the picture; closest roles only |
| 16 | modelling-no-signal-mirror | `dbt-project-modern-tests` with the `dim_`/`fct_` prefixes, the `marts/` folder and the "dimension"/"facts" description wording removed | No style detected: "I couldn't see a particular modelling style…", no style pushed, no lookup / approach file / conformance review, dbt mirrored faithfully |
| 17 | modelling-kimball-in-spirit | `dbt-project-modern-tests` renamed without prefixes, descriptions saying "dimension table", an `order_total` amount on orders | Kimball detected from descriptions + table shape (strong, `sources` without `names`): the confirmation says honestly the models aren't named `dim_`/`fct_` but read like Kimball, never "I couldn't see a particular modelling style" |
| 18 | modelling-data-vault-by-structure | `dbt-project-modern-tests` with the marts replaced by an unprefixed raw vault (`customer_hub`, `order_hub`, `customer_order_link`, `customer_sat`: hash keys, hashdiff, load date, record source) | Data Vault detected from table structure alone (weak): confirmed as a guess from table shape, hubs/satellites never called dimensions/facts, closest roles only |
| 19 | modelling-3nf-weak-guess | `dbt-project-modern-tests` with the marts replaced by seven normalised entity / association tables joined by relationship tests, no amounts | `inmon-3nf` offered only as a question ("…or should I just draw it as dbt has it?"); "not sure" mirrors dbt — no approach file, no conformance review |

## Running them

1. **Build and install the pieces the skill calls.**
   ```bash
   npm run build
   ```
   Then, in an Extension Development Host, run **ERD Studio: Set Up My AI Helper** once so
   `~/.erd-studio-cli/bin/erd-studio` exists. (Or, for a quick loop without VS Code, write your
   own shim: `mkdir -p ~/.erd-studio-cli/bin && printf '#!/bin/sh\nexec node "%s" "$@"\n'
   "$PWD/dist/cli.js" > ~/.erd-studio-cli/bin/erd-studio && chmod +x ~/.erd-studio-cli/bin/erd-studio`.)

2. **Prepare a temp copy per eval** as its `setup` says, e.g. for eval 6:
   ```bash
   work=$(mktemp -d) && cp -R test/fixtures/dbt-project "$work/proj"
   rm -rf "$work/proj/target" "$work/proj/.erd-studio"
   find "$work/proj/models" -name '*.yml' -delete
   ```
   Install the skill into the copy by running the extension's harness install against it, or by
   copying `src/harness/claude/erd-studio-setup/` to `$work/proj/.claude/skills/erd-studio-setup/`
   together with the `/erd-studio` skill from `test/fixtures/dbt-project/.claude/skills/erd-studio/`.
   For the `codex` / `gemini-cli` / `github-copilot` evals install into `.agents/skills/` instead
   (and have no `.claude/` folder), so the run proves the skill finds its schema skill there; the
   extension's install writes the portable Agent Skills frontmatter (no `allowed-tools`,
   no `argument-hint`) — a hand copy should strip those two keys too.

   Stub dbt executables are tiny shell scripts that print the version text named in `setup` and
   exit 0 for the listed commands. Put them on `PATH` (or at `.venv/bin/dbt`) for that run only.

3. **Run with skill and baseline**, using skill-creator's workflow
   (`/skill-creator:skill-creator` → "Running and evaluating test cases"). Workspace:
   `test/skill-evals/erd-studio-setup-workspace/iteration-N/<name>/{with_skill,without_skill}/`
   — gitignore it or keep it outside the repo. The runs are conversational, so the subagent
   should play the user: answer each question with the default ("yes") unless the eval's prompt
   says otherwise — the detected-style confirmation is answered "yes" unless the prompt gives
   another answer in brackets — and save the transcript plus the resulting `.erd-studio/` folder
   as outputs. Non-Claude runs use that tool's own session (`codex`, `gemini`, Copilot Chat agent
   mode or `copilot`); skill-creator's baseline comparison applies to Claude Code runs only.

4. **Grade** each run against `expectations`. Several are checkable by script against the saved
   outputs:
   - the final `node dist/cli.js diff --project <copy> --domain <file> --json` exit code
     (eval 2 expects 0);
   - pre-existing `logical-models/*.yml` files are byte-identical to the fixture (eval 5);
   - every `logical.relationships` entry appears in `inventory --models … --json` output
     (evals 1 and 6);
   - no `dbt run|build|seed|snapshot` in the transcript's commands (eval 2);
   - `.erd-studio/modelling-approach.md` exists and quotes the user's words (evals 7–10, 14, 15),
     and does **not** exist after eval 16;
   - `inventory --summary --json` on the prepared copy reports the `conventions` the eval assumes
     (evals 14–16) — check this before the run, so a failed setup is not graded as a skill failure;
   - every `modelRole` in the written `logical-models/*.yml` is one of the nine values in
     `ModelRole` (`src/types/semantic.ts`) (evals 7–16);
   - no `Shift+Tab`, `accept edits` or `safety check` in a non-Claude transcript (evals 11–13).
   The rest (tone, one question per message, narration) need a human or grader-agent read.

5. **Iterate** on `SKILL.md` and `references/*.md`, then re-run into `iteration-N+1`.

## Description triggering

Evals 3 and 12 have no slash command, so they also check that the description makes the
assistant pick the skill up from natural phrasing (eval 12 in Gemini CLI, which has no per-skill
command at all). For a fuller check, use skill-creator's
"Description Optimization" loop with trigger queries such as "turn my dbt models into an ERD",
"set up ERD Studio", "model my dbt project the Kimball way", and near-misses such as "write a dbt test for fct_order" (which should
**not** trigger it). The description must stay under 1024 characters.

## Variants worth adding later

- A custom `erdStudio.semanticDir` (e.g. `docs/erd`): install via the extension so
  `applySemanticDir()` rewrites `.erd-studio` in the skill text, and check every write lands in
  the custom folder while `~/.erd-studio-cli` stays untouched.
- Windows PowerShell without Git Bash: the `.cmd` route.
- A stale launcher (shim exiting 5): the skill should ask for a VS Code reopen, not a reinstall.
