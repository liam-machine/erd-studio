# Troubleshooting

Each section starts with what the user sees, then what to say and do. Keep the explanation to a
sentence or two — the user wants to get back to the setup, not learn how the plumbing works.

## Helper missing

**Seen as:** `command not found`, `No such file or directory`, or exit code 127 when running
`~/.erd-studio-cli/bin/erd-studio`.

The helper is installed by the ERD Studio VS Code extension when the user clicks **Set Up My AI
Helper**. The skill files can reach a project without it — a teammate may have committed them,
or the harness was installed another way. Say:

> "ERD Studio's checking tool isn't installed on this computer yet. In VS Code, open the Command
> Palette (Cmd+Shift+P on Mac, Ctrl+Shift+P on Windows/Linux), run **ERD Studio: Set Up My AI
> Helper**, then tell me 'done'."

Then run doctor again. There is no need to restart your AI assistant for the helper — only for
the skill itself.

If they cannot or do not want to (no VS Code on this machine, a locked-down laptop), <!-- dbt-only -->continue in
**canvas-fallback mode** (below)<!-- /dbt-only --><!-- no-dbt -->carry on
without it, as the walkthrough's step 1 says,<!-- /no-dbt --> and tell them the checks will be less exact.

## Launcher stale

**Seen as:** exit code 5 and a JSON error with code `launcher-stale`.

The helper runs on the Node.js that ships inside VS Code, and VS Code has updated since the
helper was written, so the path it remembers is gone. Say:

> "The checking tool needs a quick refresh after a VS Code update. Please open this project in
> VS Code once (or reload the window), then tell me 'done'."

Opening the project refreshes it automatically. Installing Node.js 18 or newer also fixes it
permanently, because the helper prefers `node` when it finds one — mention that only if the
problem comes back.

## The safety check paused a write

**Seen as:** a denied edit with a reason starting "ERD Studio: load the /erd-studio skill" (Claude
Code, GitHub Copilot), "load the $erd-studio skill" (Codex) or "activate the erd-studio skill"
(Gemini CLI), ending "before editing .erd-studio files, then retry."

This is expected, once per session. ERD Studio's hook pauses the very first change to an ERD
Studio file in each session, so the format rules are always loaded before anything is written.
Make sure the schema skill has been loaded (`/erd-studio` in Claude Code; read its `SKILL.md` in
full elsewhere), then retry the same write. You told the user about this <!-- dbt-only -->in Stage 4<!-- /dbt-only --><!-- no-dbt -->before your first write<!-- /no-dbt -->, so
one short line is enough: "That was the one-time safety check — carrying on."

If it denies **again** on the retry, the hook could not record that it had already paused this
session (it writes a small marker file in the temp folder). Tell the user and suggest restarting
the assistant; if it persists, they can remove ERD Studio's entry from the hook config — Claude
Code: `hooks.PreToolUse` in `.claude/settings.local.json`; GitHub Copilot: `hooks.preToolUse` in
`.github/copilot/settings.local.json`; Codex: `hooks.PreToolUse` in `.codex/hooks.json`; Gemini
CLI: `hooks.BeforeTool` in `.gemini/settings.json`. Do not edit those files yourself without
asking.

Codex runs a new or changed project hook only after the user trusts it: at startup it says a hook
needs review, and they approve it in `/hooks`. Until then there is no pause, which is harmless.
Cursor has no such check; <!-- dbt-only -->the walkthrough's own Stage 4 step 1<!-- /dbt-only --><!-- no-dbt -->loading the format rules before the first write<!-- /no-dbt --> does the same job.

## Format rules missing

**Seen as:** neither `.claude/skills/erd-studio/SKILL.md` nor `.agents/skills/erd-studio/SKILL.md`
exists in the project folder (and, in Claude Code, `/erd-studio` is not offered).

First rule out a file your tool will not open: if your file-reading tool refuses one of those
paths as *ignored* (Gemini CLI skips files `.gitignore` matches), it is there — read it with a
shell command instead (`cat <file>`, or `Get-Content <file>` in PowerShell).

The setup skill reached the project without its companion — copied by hand, or installed for a
different assistant. Say:

> "ERD Studio's file-format guide isn't installed for this assistant yet. In VS Code, run
> **ERD Studio: Set Up My AI Helper** from the Command Palette, then tell me 'done'."

Then look for the file again. If they cannot install it, carry on using the formats and worked
example in `references/building-the-model.md`, tell them the files should be checked on the
canvas, and rely on <!-- dbt-only -->the Stage 5 diff<!-- /dbt-only --><!-- no-dbt -->the walkthrough's step 5 checks<!-- /no-dbt --> to catch mistakes.

## The skill does not show up

**Seen as:** the user says `/erd-studio-setup` (or `$erd-studio-setup`) is not offered, "Unknown
command", or the assistant does not pick up "set up ERD Studio".

Every assistant finds skills when it starts (or when a new chat begins), in the project folder it
was opened in: Claude Code reads `.claude/skills/`; GitHub Copilot, Codex, Gemini CLI and Cursor
read `.agents/skills/` (Copilot and Cursor also read `.claude/skills/`). Usual causes:
1. The assistant was already running when the skill was installed → start a new chat, or quit
   and start it again.
<!-- dbt-only -->2. It was started in a different folder than the dbt project (for example the repo root, when
   the dbt project is in `analytics/`) → quit, `cd` into the folder that holds
   `dbt_project.yml`, and start it there (for an assistant inside VS Code, open that folder).<!-- /dbt-only --><!-- no-dbt -->2. It was started in a different folder than the project (for example a parent folder) → quit,
   `cd` into the folder that holds `.erd-studio/` (or the one VS Code has open), and start it
   there (for an assistant inside VS Code, open that folder).<!-- /no-dbt -->
3. The skill was installed for a different assistant (only `.claude/skills/` exists, but they use
   Codex or Gemini CLI) → run **ERD Studio: Set Up My AI Helper** again; it installs for every
   assistant it detects. If it still does not detect theirs (an assistant installed where VS Code
   cannot see it), run **ERD Studio: Install AI Helper Files…** instead and tick
   "Agent Skills — GitHub Copilot, Codex, Gemini CLI, Cursor".
4. Gemini CLI has no per-skill command — ask it in a sentence: "Set up ERD Studio for this
   project."

## Windows

- Claude Code on Windows runs shell commands with **Git Bash** when it is installed, and the
  helper at `~/.erd-studio-cli/bin/erd-studio` works there as on macOS. Other assistants usually
  run commands in **PowerShell**.
- Without Git Bash (or in PowerShell), use `~/.erd-studio-cli/bin/erd-studio.cmd`, which in
  PowerShell is `& "$HOME\.erd-studio-cli\bin\erd-studio.cmd" doctor --json`. Tell the user
  you are using the Windows route.
- ERD Studio's safety-check hooks are bash scripts. Without Git Bash Claude Code's simply does
  nothing; GitHub Copilot's and Codex's are a no-op in PowerShell, and Gemini CLI may report its
  hook as failed and carry on — all harmless, you just will not see the <!-- dbt-only -->Stage 4<!-- /dbt-only --><!-- no-dbt -->one-time<!-- /no-dbt --> pause.
<!-- dbt-only -->- A virtual environment's dbt is at `.venv\Scripts\dbt.exe`. When *you* run it through the
  shell, write it with forward slashes — `.venv/Scripts/dbt.exe parse` — because Git Bash treats
  a backslash as an escape and would look for `.venvScriptsdbt.exe` (PowerShell accepts forward
  slashes too).<!-- /dbt-only -->

## Remote-SSH, WSL and dev containers

When VS Code is connected to a remote machine, WSL or a container, the extension runs **there**,
and so does any AI assistant that runs inside VS Code or was started from VS Code's terminal. The
helper is installed in the remote home folder. If the user started a terminal assistant (Claude
Code, Codex, Gemini CLI, Copilot CLI) on their local machine while the project lives remotely,
the helper will be missing: ask them to start it from VS Code's integrated terminal instead.

## Merge conflicts

**Seen as:** any of these, from doctor<!-- dbt-only --> or the diff<!-- /dbt-only -->, at any stage:
- doctor's `resolve-merge-conflicts` step — `erd.conflictedDomainFiles` lists each diagram file
  (`file`, `line`);
- a `fix-model-yaml` step or fix whose model file's entry in doctor's `erd.unreadableModelFiles`
  <!-- dbt-only -->or the diff's `unreadableModelFiles` <!-- /dbt-only -->has `mergeConflict: true` (the step and the fix themselves
  carry no such field);
<!-- dbt-only -->- a diff `error` with code `merge-conflict` (a diagram file the diff could not load);<!-- /dbt-only -->
- in a DBML project, doctor's `resolve-merge-conflicts` step naming a `.dbml` file — its entry
  in `erd.dbmlProblems` has `mergeConflict: true` (a table file, a relationships file or a
  diagram; `layoutMergeConflict` when the markers are inside a diagram's `erd_layout`; never a
  `fix-dbml-file`).
- doctor's `resolve-merge-conflicts` step naming `.erd-studio/fields.yml` — its entry in
  `erd.fields.problems` is `fieldsYamlInvalid` with `mergeConflict: true` (never a
  `fix-fields-file`); the canvas uses the starting set until it is resolved.

The file still holds git's conflict markers (`<<<<<<<` … `=======` … `>>>>>>>`): two people
changed the same lines, git kept both versions, and ERD Studio cannot read the file until one is
chosen. Only the user knows which version is right — it is often a teammate's work. This is
**not** a YAML slip: do not quote, delete or tidy anything in it.

1. Stop and raise it before anything else — no <!-- dbt-only -->dbt command, no <!-- /dbt-only -->other file edit.
2. Tell the user the file and line in plain words:

   > "`.erd-studio/gold/orders.json` still has two versions of the same lines from line 42 — git
   > left both after a merge, and ERD Studio can't open it until one is chosen."

3. Read the file and look at what differs between the two versions. Each conflict runs from a
   `<<<<<<<` line to a `>>>>>>>` line, split by `=======`; the labels after `<<<<<<<` and
   `>>>>>>>` name the two sides. Do not assume which one is "theirs": during a rebase the two
   swap (`HEAD` is then the branch being rebased onto), so describe each version by what it
   contains, not by its label. A file can hold several — doctor names only the first line, so
   check for every `<<<<<<<`.
   - **Only `viewConfig.positions` differ** (where tables sit on the canvas): say either side is
     safe — the design is the same, only the layout differs. Offer to keep either one, and edit
     only once the user says which. The same goes for a DBML diagram's `erd_layout` (its
     positions): keep one side's lines whole, never a mix, and ERD Studio saves no position
     until the markers are gone.
   - **A conflicted relationships file** (`<layer>/relationships/`) usually means both sides added relationships: offer
     to keep both sides' Ref lines and both sides' `use` lines, then run doctor; a Ref that now
     appears twice is reported (`duplicateRef`) — delete one copy.
   - **Anything else differs:** describe each version in one line and ask which to keep. Do not
     recommend one.
4. Never pick a side unasked. Never run `git add`, `git checkout --ours` / `--theirs`,
   `git merge`, `git commit`, `git restore`, `git stash` or any other git command — finishing the
   merge is the user's job, in their own git tool.
5. If the user names a side, Edit the file: keep that version's lines, delete the other version
   and the three marker lines, change nothing else. Your edit saves the file, so re-run doctor
   <!-- dbt-only -->(or the diff) <!-- /dbt-only -->straight away — "Checking again now the conflict is resolved." — and remind
   them to finish the merge in git.
6. If the user resolves it themselves instead, re-run doctor <!-- dbt-only -->(or the diff) <!-- /dbt-only -->once they say the file
   is saved, then carry on from where you stopped.

## DBML files

A DBML project (doctor's `erd.storage` is `dbml` or `mixed`) reports its files' problems in
`erd.dbmlProblems`: `file`, `line`, `code`, `severity` and `message`. Only errors raise a next
step, but fix these warnings too in any file you wrote: `missingUse`, `missingRelationshipsUse`,
`unquotedValue` (`natural_key: true` → `natural_key: 'true'`) and `usePathMismatch`. The message
gives the exact line. ERD Studio reads on without the fix, but other DBML tools reject the file
and every diagram that imports it. A `foreignMetadata` warning is a Metadata block outside the
table's own file: do what its message says, moving its properties into the table file (as inline
settings in a `.dbml` one) and removing the block.
Other warnings are information.

- **`fix-dbml-file`** — a `.dbml` file ERD Studio or other DBML tools cannot read. The usual cause
  is an unquoted text value: `grain: One row per order` → `grain: 'One row per order'` (the
  message says "Quote the value"). Others: a `use`, `Ref` or inline
  `[ref: …]` inside a table file (move it to a `<layer>/relationships/` file, as the message
  says), a table file holding two Tables or a name other than its file's, a Ref that is stored
  twice (`duplicateRef`: delete one), or a table name in two table files (`duplicateTableName`:
  ask the user which to rename, keeping the warehouse name in `alias`). Fix the line, then re-run
  doctor. Never "fix" a file by reformatting it. Warnings about where a file sits
  (`dbmlOutsideKnownFolders`, `dbmlLayerNotConfigured`, `schemaFolderMismatch`) name where it
  belongs: tell the user, and move a file only when they agree.
- **`fix-fields-file`** — `.erd-studio/fields.yml` has an error, and doctor's `erd.fields` names
  its line and what is wrong: a key that is reserved (`note` is a DBML setting), not lower case or
  listed twice, a `choice` without its `values`, an unknown `type`. Fix that line as the message
  says, then re-run doctor. A file with git conflict markers is `resolve-merge-conflicts`, never
  this step: the user picks the side to keep, never you. Its warnings (a misspelt built-in such as `purpse`) are worth a
  one-line question. Never delete the file or a field the team listed without asking.
- **`resolve-format-conflicts`** — the same table (or diagram) exists as both YAML/JSON and DBML
  (`x.yml` and `x.dbml`); only one is read. Show the user both files and ask which to keep;
  never delete or convert either yourself.
- **`finish-dbml-conversion`** — a **Convert Project to DBML** stopped part way (some files
  converted, their YAML/JSON sources still there). Ask the user to run **ERD Studio: Convert
  Project to DBML** again in VS Code: it checks every file and finishes. Never finish it by hand.
- **`reconvert-dbml-project`** — the DBML files are from an ERD Studio 1.9 pre-release, whose folder
  layout 2.0 does not read. Show the user doctor's message; undoing that conversion and running
  **ERD Studio: Convert Project to DBML** again is theirs to do (git, then VS Code). Never move,
  edit or delete the 1.9 files yourself.
- **`import-dbml-file`** — a `.dbml` in a `diagrams/` folder declares its own Tables and imports none:
  it is a single-file DBML (a dbdiagram.io download or an export), not an ERD Studio diagram. Ask
  the user to run **ERD Studio: Import DBML…** on it.
- **<!-- dbt-only -->diff / <!-- /dbt-only -->export error codes**: `dbml-invalid` — a `.dbml` diagram does not parse (the message
  names the file and line; fix it as above); `not-a-diagram` — the `--domain` you passed is a
  table or relationships file: pass the diagram (`.erd-studio/<layer>/diagrams/<name>.dbml`).

<!-- dbt-only -->## Manifest stale or unreadable

- **`stale`** — the dbt files changed after `manifest.json` was written, so dbt's map is out of
  date. Offer `dbt parse` (seconds, no warehouse). Without dbt, carry on: ERD Studio also reads
  the `.yml` files directly, so the comparison is still close.
- **`unreadable`** — the file exists but is not valid JSON, usually because dbt was writing it at
  that moment or crashed half-way. Wait a moment and run doctor again; if it persists, `dbt parse`
  rewrites it.
- **`missing`** — dbt has not run in this project yet. Offer `dbt parse`, or carry on without it.

## Catalog older than the manifest

**Seen as:** `artifacts.catalog.status: older-than-manifest`.

The column types were read from the warehouse before the latest project changes. It is still
useful; offer to re-run the catalog command (it connects to the warehouse) or carry on.
<!-- /dbt-only -->
## Relationships drawn backwards

**Seen as:** doctor's `turn-round-relationships` step; `erd.backwardsRelationships` lists each one
(its `fromModel` / `fromColumns` as stored, and the `domains` that draw it).

An older ERD Studio (1.6.7) could save a relationship from a dimension's key to a fact — the
wrong way round. ERD Studio draws it as stored with a ⚠ on the line. Name each one in a line
("`dim_customer.customer_key → fct_order.customer_key` starts at dim_customer's key, so it was
probably drawn backwards") and ask once whether to turn them round. On a yes, either point the
user at the ⚠ → **Turn round** on the canvas (one undo step), or edit the files yourself: write
it as a `many-to-one` from the column that is not a key to the key, in that column's model file,
and remove the old entry. Leave any the user says were drawn that way on purpose.

<!-- dbt-only -->## The helper found the wrong project

**Seen as:** doctor reports `project.found: false`, or a project name the user does not
recognise.

The helper looks for `dbt_project.yml` in the current folder and its parents — stopping at
the first folder that holds `.erd-studio/`, which is then the project when no dbt project is
found — then a few levels down. In a repository with several dbt projects, ask which one and pass `--project <folder>` on
every helper command from then on.

With no dbt project anywhere, it uses the nearest folder holding `.erd-studio/` (this one or
above) and reports `dbtProject: false` with `skippedChecks`: that is a folder without dbt, not a
wrong project — follow `references/without-dbt.md`.
<!-- /dbt-only --><!-- no-dbt -->## The helper found the wrong project

**Seen as:** doctor's `projectRoot` is not the folder you are working in.

The helper looks for the project in the current folder and its parents — the first folder that
holds `.erd-studio/` — and a few levels down. Pass `--project <folder>` (this folder: `--project .`)
on every helper command from then on.
<!-- /no-dbt --><!-- dbt-only -->
## The project is very large

If `inventory --summary` lists hundreds of models, do not read them all out. Summarise by folder,
propose one small area (at most 15 models) and use `inventory --models` for just those. The user
can re-run the setup (`/erd-studio-setup`, or their assistant's form of it) for each
further area.

## Canvas-fallback mode (no helper available)

When no route to the helper works, follow SKILL.md's stages with these changes:
- **Stage 1–2:** run `dbt --version` yourself (if the user agrees) and skip the rest of doctor.
- **Stage 3:** build the inventory by hand — Glob for `dbt_project.yml`'s `model-paths` (usually
  `models/**/*.yml` and `models/**/*.sql`), Read the schema yml files for model names, columns,
  `data_type:` and `relationships` / `unique` tests. For the modelling style, apply the
  `conventions` rules in `references/modelling-approaches.md` section 4 yourself (names,
  descriptions, table shape, folders, `packages.yml`, snapshots), then confirm as usual.
- **Stage 4:** as normal, but only copy relationships that a dbt `relationships` test declares
  between two chosen models.
- **Stage 5:** use "Fallback A" in `references/verify-and-fix.md` (the canvas writes a sync plan
  you then read), and if that is not possible, "Fallback B" (a best-effort manual comparison,
  labelled as such).

Tell the user once that checks in this mode are less exact than with the helper.<!-- /dbt-only -->
