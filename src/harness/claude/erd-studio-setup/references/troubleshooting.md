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

If they cannot or do not want to (no VS Code on this machine, a locked-down laptop), continue in
**canvas-fallback mode** from SKILL.md and tell them the checks will be less exact.

## Launcher stale

**Seen as:** exit code 5 and a JSON error with code `launcher-stale`.

The helper runs on the Node.js that ships inside VS Code, and VS Code has updated since the
helper was written, so the path it remembers is gone. Say:

> "The checking tool needs a quick refresh after a VS Code update. Please open this project in
> VS Code once (or reload the window), then tell me 'done'."

Opening the project refreshes it automatically. Installing Node.js 18 or newer also fixes it
permanently, because the helper prefers `node` when it finds one — mention that only if the
problem comes back.

## The safety check paused a write (Claude Code only)

**Seen as:** a denied Edit/Write with the reason "ERD Studio: load the /erd-studio skill
(file-format rules) before editing .erd-studio files, then retry."

This is expected, once per session. ERD Studio's hook pauses the very first change to an ERD
Studio file in each Claude Code session, so the format rules are always loaded before anything is
written. Make sure `/erd-studio` has been invoked, then retry the same write. You told the user
about this in Stage 4, so one short line is enough: "That was the one-time safety check —
carrying on."

If it denies **again** on the retry, the hook could not record that it had already paused this
session (it writes a small marker file in `/tmp`). Tell the user and suggest restarting Claude
Code; if it persists, they can remove the ERD Studio entry from `hooks.PreToolUse` in
`.claude/settings.local.json`. Do not edit that file yourself without asking.

Other assistants have no such check; the walkthrough's own Stage 4 step 1 does the same job.

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
canvas, and rely on the Stage 5 diff to catch mistakes.

## The skill does not show up

**Seen as:** the user says `/erd-studio-setup` (or `$erd-studio-setup`) is not offered, "Unknown
command", or the assistant does not pick up "set up ERD Studio".

Every assistant finds skills when it starts (or when a new chat begins), in the project folder it
was opened in: Claude Code reads `.claude/skills/`; GitHub Copilot, Codex, Gemini CLI and Cursor
read `.agents/skills/` (Copilot and Cursor also read `.claude/skills/`). Usual causes:
1. The assistant was already running when the skill was installed → start a new chat, or quit
   and start it again.
2. It was started in a different folder than the dbt project (for example the repo root, when
   the dbt project is in `analytics/`) → quit, `cd` into the folder that holds
   `dbt_project.yml`, and start it there (for an assistant inside VS Code, open that folder).
3. The skill was installed for a different assistant (only `.claude/skills/` exists, but they use
   Codex or Gemini CLI) → run **ERD Studio: Set Up My AI Helper** again; it installs for every
   assistant it detects. If it still does not detect theirs (an assistant installed where VS Code
   cannot see it), run **ERD Studio: Install AI Coding Harness** instead and tick
   "Agent Skills — GitHub Copilot, Codex, Gemini CLI, Cursor".
4. Gemini CLI has no per-skill command — ask it in a sentence: "Set up ERD Studio for this dbt
   project."

## Windows

- Claude Code on Windows runs shell commands with **Git Bash** when it is installed, and the
  helper at `~/.erd-studio-cli/bin/erd-studio` works there as on macOS. Other assistants usually
  run commands in **PowerShell**.
- Without Git Bash (or in PowerShell), use `~/.erd-studio-cli/bin/erd-studio.cmd`, which in
  PowerShell is `& "$HOME\.erd-studio-cli\bin\erd-studio.cmd" doctor --json`. Tell the user
  you are using the Windows route.
- Claude Code's safety-check hook is a bash script. Without Git Bash it cannot run and simply
  does nothing — harmless, you just will not see the Stage 4 pause.
- A virtual environment's dbt is at `.venv\Scripts\dbt.exe`. When *you* run it through the
  shell, write it with forward slashes — `.venv/Scripts/dbt.exe parse` — because Git Bash treats
  a backslash as an escape and would look for `.venvScriptsdbt.exe` (PowerShell accepts forward
  slashes too).

## Remote-SSH, WSL and dev containers

When VS Code is connected to a remote machine, WSL or a container, the extension runs **there**,
and so does any AI assistant that runs inside VS Code or was started from VS Code's terminal. The
helper is installed in the remote home folder. If the user started a terminal assistant (Claude
Code, Codex, Gemini CLI, Copilot CLI) on their local machine while the project lives remotely,
the helper will be missing: ask them to start it from VS Code's integrated terminal instead.

## Manifest stale or unreadable

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

## The helper found the wrong project

**Seen as:** doctor reports `project.found: false`, or a project name the user does not
recognise.

The helper looks for `dbt_project.yml` in the current folder, its parents, then a few levels
down. In a repository with several dbt projects, ask which one and pass `--project <folder>` on
every helper command from then on.

## The project is very large

If `inventory --summary` lists hundreds of models, do not read them all out. Summarise by folder,
propose one small area (at most 15 models) and use `inventory --models` for just those. The user
can re-run the setup (`/erd-studio-setup`, or their assistant's form of it) for each
further area.
