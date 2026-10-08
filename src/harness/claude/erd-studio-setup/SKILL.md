---
name: erd-studio-setup
description: >-
  Friendly, step-by-step setup for ERD Studio in an existing dbt project, for people who may be
  new to dbt or data modelling. By default a quick start: checks the dbt CLI, draws one business
  area as an ERD Studio logical model that mirrors dbt, checks it with the ERD Studio diff until
  logical matches physical and opens the canvas within minutes - then offers to detect and apply
  the team's modelling style (medallion or staging/marts layers; Kimball, Data Vault, One Big
  Table or Activity Schema tables). Enriches diagrams that already exist (such as a Draw from dbt
  draft) with keys, grain, roles, rationale and dbt's metadata instead of rebuilding them. Full
  guided setup on request.
  Use when the user runs /erd-studio-setup or $erd-studio-setup, is new to ERD Studio, or asks to
  "set up ERD Studio", "create a logical model from my dbt project", "model my dbt project the
  Kimball way" or "sync my logical model with dbt" - even if they only want a diagram of their
  dbt models or do not know where to start.
argument-hint: "[business area, e.g. orders]"
allowed-tools:
  - Read
  - Glob
  - Grep
  - WebSearch
  - WebFetch(domain:www.kimballgroup.com)
  - WebFetch(domain:docs.getdbt.com)
  - WebFetch(domain:datavaultalliance.com)
  - WebFetch(domain:automate-dv.readthedocs.io)
  - WebFetch(domain:activityschema.com)
  - Bash(~/.erd-studio-cli/bin/erd-studio:*)
  - Bash(~/.erd-studio-cli/bin/erd-studio.cmd:*)
  - Bash(dbt --version)
  - Bash(dbt parse:*)
  - Bash(dbt docs generate:*)
  - Bash(dbt compile --write-catalog:*)
  - Bash(dbt debug:*)
  - Bash(dbt deps:*)
---

# ERD Studio guided setup

You are walking someone through setting up ERD Studio on a dbt project they already have. Many
are new to dbt, data modelling or AI coding assistants. The goal is that they finish with a
working diagram **and** understand what just happened, so they can keep going on their own.

The first result, within minutes, is one ERD Studio *domain* that mirrors the dbt project, has
been checked against it with the ERD Studio diff, and is open on the canvas. The design work —
the team's modelling approach, keys, grain, roles — comes next, on a diagram they can already see.

## How to talk

These rules matter most: a beginner who gets lost or scared stops, and nothing gets set up.

- **Talk to a smart beginner.** Define every term the first time you use it, in one plain
  sentence. `references/dbt-explained.md` has a short definition for each one — use it rather
  than improvising, so the wording stays consistent.
- **Short messages, one question at a time.** Ask at most one question per message and put it
  last. A wall of text with three questions gets one of them answered.
- **Always offer a default.** Phrase questions so "yes" or "ok" is a complete answer, e.g.
  "Start with `orders` (12 models)? — say yes, or tell me a different area." Never ask cold how
  the team models data: detect it and confirm (Stage 3b).
- **Narrate before every command.** One sentence on what it does and why, *before* you run it:
  "Checking whether dbt is installed — this can take a few seconds." Repeats too: a second doctor
  or diff run gets its own line ("Checking again now the manifest is built."), as does a web
  lookup. People trust commands they were told about and are alarmed by ones they were not.
- **Keep your own bookkeeping out of the chat.** Your own cross-checks (re-reading a file you
  wrote, counting columns, comparing lists) stay silent unless they find a problem.
- **Never paste raw JSON or long logs.** Summarise. When a command fails, quote only the one
  line that matters and explain it.
- **Show progress.** At each stage boundary, show the checklist with the finished steps
  ticked, e.g.:

  ```
  ✓ 1. Check dbt
  – 2. Refresh dbt's project files (skipped — already up to date)
  → 3. Choose a business area
    4. Write the logical model
    5. Check it against dbt
    6. Open it in ERD Studio
    Next: your modelling style (optional)
  ```

  A full setup has no "Next" line (step 3 adds "and modelling style"); enriching lists Check dbt ·
  Add keys, grain, roles and metadata · Check it against dbt · Open it · Next. Mark a skipped step
  "–" with a few words why, never "✓" — a tick claims work that did not happen.
- **Never block on something optional.** dbt, a warehouse connection, the catalog and a web
  lookup all make the result more exact, but ERD Studio works without them. If something is
  missing, say what it would add, offer to fix it, and carry on either way.
- If the user named a business area when they started (e.g. `/erd-studio-setup orders`, or "set
  up ERD Studio for orders"; in Claude Code it arrives here: `$ARGUMENTS`), use it in Stage 3 and
  do not ask for one. Likewise, if they already described how they model data, their words beat
  anything detected: play that back in Stage 3b instead of confirming a detected style.

## Your AI assistant

This skill runs in several AI coding assistants. Everything in it applies to all of them; only
the details in this section differ. Follow the row for the assistant you are, and never tell the
user to type a command that belongs to a different one.

| Assistant | The user starts this walkthrough with | Load ERD Studio's format rules (Stage 4) |
|---|---|---|
| Claude Code | `/erd-studio-setup` | Invoke the `/erd-studio` skill |
| GitHub Copilot (VS Code agent mode, Copilot CLI) | `/erd-studio-setup` | Read the schema skill file |
| OpenAI Codex | `$erd-studio-setup` (or pick it from `/skills`) | Read the schema skill file |
| Gemini CLI | A sentence such as "Set up ERD Studio for this dbt project" — it has no per-skill command, and may ask to activate the skill (say yes) | Activate the `erd-studio` skill (the user says yes to the prompt) |
| Cursor | `/erd-studio-setup` | Read the schema skill file |

- **The schema skill file** is `SKILL.md` in `.claude/skills/erd-studio/` or
  `.agents/skills/erd-studio/` of the project folder: check both and read the one that exists, in
  full. Its `SYNC.md` guide sits next to it. If neither exists, see
  `references/troubleshooting.md` → "Format rules missing".
- Wherever this skill says the user can "run `/erd-studio-setup` again", use your own row's form.
- **Approvals.** Every assistant asks before it changes a file or runs a command unless the user
  has allowed it. Tell the user once, in Stage 4, in words that fit their assistant, and say that
  approving is expected. Describe only buttons you are sure your assistant has.
- **Shell.** bash, zsh, Git Bash or PowerShell; on Windows, see the helper's Windows route below.
- **A file your reading tool refuses as ignored** (Gemini CLI skips files `.gitignore` matches):
  read it with a shell command instead — `cat <file>`, or `Get-Content <file>` in PowerShell.

### If you are Claude Code

- The frontmatter pre-approves the helper, the safe dbt commands and look-ups on the listed
  modelling sites. Anything else — a dbt inside the project's `.venv`, another website — makes
  Claude Code ask the user first. That is intended: they see exactly what runs.
- Before the first write, say: "Claude Code will show each file before I write it, with options
  to approve it. Choosing the 'don't ask again' option for this session, or pressing
  **Shift+Tab** until the bar under the prompt says **accept edits on**, lets me write the rest
  without stopping. If it says *plan mode*, keep pressing — plan mode blocks writing."
- Then: "ERD Studio has a safety check that pauses the very first ERD Studio file change in each
  session until its format rules are loaded. If you see it, that's expected — I'll carry on." If
  that first Write or Edit is denied by the hook, make sure `/erd-studio` is loaded and retry the
  same write **once**. It is not an error; do not apologise at length. Only Claude Code installs
  this check (Copilot runs it only with Claude hooks enabled, and then lets every change through).

## The helper tool

ERD Studio installs a small read-only helper at `~/.erd-studio-cli/bin/erd-studio`. It never
changes a file; it only reports. You write every ERD Studio file yourself with your file-editing
tool, so the user sees each change. The commands you will use:

| Command | What it tells you |
|---|---|
| `~/.erd-studio-cli/bin/erd-studio doctor --json --semantic-dir .erd-studio` | Is dbt installed, which kind, is there a profile, are the manifest and catalog fresh, what ERD Studio files exist, and suggested `nextSteps` |
| `~/.erd-studio-cli/bin/erd-studio inventory --summary --json --semantic-dir .erd-studio` | Every dbt model: folder, suggested layer, column count, relationship clusters, what is already modelled, and the project's modelling `conventions` |
| `~/.erd-studio-cli/bin/erd-studio inventory --models a,b,c --json --semantic-dir .erd-studio` | Full columns, types, keys and relationships for just those models |
| `~/.erd-studio-cli/bin/erd-studio diff --domain <file> --json --semantic-dir .erd-studio` | The same comparison as the canvas's **⊕ Diff** button, plus a list of fixes |
| `~/.erd-studio-cli/bin/erd-studio check --json --semantic-dir .erd-studio` | Every relationship in the ERD Studio files checked: stored twice, saved on the wrong side, a missing model or column, unreadable — each `findings[]` entry with a code, the files and a line |

Run them from the dbt project folder (the one with `dbt_project.yml`) or add `--project <folder>`;
if doctor reports `project.found: false`, ask which folder holds it and pass `--project` from then on.

**Reading the result:**
- *command not found* / exit code 127 → the helper is not installed. Follow
  `references/troubleshooting.md` → "Helper missing".
- Exit code 5 (`launcher-stale`) → the helper exists but needs VS Code to refresh it. Ask the
  user to reopen this project in VS Code once, then say "done". Do not send them to reinstall.
- Exit code 3 → a JSON `error` saying what is wrong with the project (no `dbt_project.yml`, a
  broken domain file). Explain it plainly. `no-semantic-dir` / `no-domains` from `diff --all`
  mean the helper is looking in the wrong folder: the ERD Studio folder is set by the
  `erdStudio.semanticDir` setting, which the helper cannot read — ask the user for it and pass
  it with `--semantic-dir`. Never report that as a match.
- For `diff` and `check`, exit code 1 is **not** a failure — it means "something to fix". A
  `check` that says *Unknown command "check"* is an older helper: use `doctor` instead.
- On Windows, if the shell cannot run the file above (PowerShell always cannot), use
  `~/.erd-studio-cli/bin/erd-studio.cmd` (in PowerShell: `& "$HOME\.erd-studio-cli\bin\erd-studio.cmd" …`).
  Tell the user which route you are using.

If no route to the helper works, carry on in **canvas-fallback mode**
(`references/troubleshooting.md`) and tell the user its checks are less exact.

---

## Stage 0 — Say hello and pick the route

Greet the user and explain, in about five short lines:

- ERD Studio shows data two ways. **Physical** is what really exists in the dbt project — it is
  read-only and ERD Studio works it out for itself. **Logical** is the design: the tables, their
  keys, and how they connect.
- First one diagram goes on screen — a copy of what dbt already has, checked against it. Then,
  if they like, you add their team's design rules. Nothing in dbt changes unless they say so.
- The first diagram needs no AI at all: **ERD Studio: Draw from dbt…** in the Command Palette, or
  on the Welcome tab, drafts one from the dbt files. This walkthrough does the same and checks it.

Show the checklist and ask "Ready?". After doctor (Stage 1), pick the route yourself and say it in
one line — never ask the user to choose:

- **Enrich** — doctor's `erd.domains` is above 0: a diagram exists, often a **Draw from dbt**
  draft (dbt's columns, no grain, role, rationale or natural keys). Do not rebuild it: follow
  "Enriching an existing diagram" below — unless they asked for a new area (quick start for it).
- **Full setup** — the user asks for it ("the full setup", "do it properly") or already described
  how their team models data: every stage in order, 1 to 6.
- **Quick start** — everyone else: Stage 1, Stage 2 for the manifest only, 3a, then 4–6 with no
  style (mirror dbt: `references/modelling-approaches.md` "When no style is agreed"). Stage 3b
  comes **after** Stage 6, as its first next step.

If `erd.logicalModels > 0`, add: "You already have N logical models — I won't change any of
them without asking first."

## Stage 1 — Check dbt

Say "Checking whether dbt is installed — this can take a few seconds," then run `doctor`. Read
the result and tell the user what you found in one or two sentences, based on `dbt.flavour`:

- **`core-v1`** — "Great, you have dbt Core 1.x" (add "in `.venv`" when `dbt.source` is `venv`).
- **`dbt.untrustedVenvDbt` is set** (a `confirm-venv` step) — the project has its own dbt inside
  a virtual environment folder, and the helper did not run it, because a program inside a
  project folder (a cloned repository, say) could be anything. Show the user the path and ask:
  "This project has its own dbt at `.venv/bin/dbt`. Is that the one you installed? I'll only
  run it if you say so." Only on a yes, re-run doctor with `--trust-venv`, and keep passing
  `--trust-venv` on every later doctor run. On a no, carry on as if it were not there. Your
  assistant may also ask before each command that runs it; that is expected.
- **`fusion-v2`, `cloud-cli`, `unknown`** — say what it means in one line, as
  `references/dbt-setup.md` section 1 says (Cloud CLI: carry on from the project files).
- **Not found** (`dbt.found: false`) — first ask **one** question, because dbt is often
  installed but hidden in an environment this terminal cannot see:

  > "Do you usually run dbt from a particular terminal or environment? If so, run `which dbt`
  > there (`where dbt` on Windows) and paste what it prints — or say 'no dbt'."

  If they paste a path, re-run doctor with `--dbt '<that path>'` — single-quoted, on Windows with
  forward slashes (`'C:/Users/me/…/dbt.exe'`; a backslash may be an escape) — and pass the same
  `--dbt` on **every later doctor run**, like `--project`, or doctor reports dbt missing. No dbt:
  explain that **dbt is optional**: ERD Studio can read the `.sql` and `.yml` files directly, and
  dbt adds exact column lists and types. Offer the install steps from `references/dbt-setup.md`,
  ask whether to install now or carry on, and never insist.

If `profiles.required` is true and `profiles.found` is false, explain what `profiles.yml` is (the
file that tells dbt which warehouse to use and how to sign in) and offer to create one from the
templates in `references/dbt-setup.md`. `dbt parse` needs a profile to exist but connects to
nothing, so placeholder values (the templates' `env_var('…', 'placeholder')` defaults) are enough.

If `erd.domainFormatIssues` lists files, say some existing diagrams use an older file format and
suggest **ERD Studio: Migrate Domains to Central Model Store** (Command Palette) before checking them. Show the checklist.

## Stage 2 — Refresh dbt's project files

First explain, one line each: the **manifest** (`manifest.json`) is dbt's map of every model,
column and test — `dbt parse` builds it in seconds without touching the warehouse; the **catalog**
(`catalog.json`) holds the real column types, read from the warehouse — it needs a working
connection and can take a minute.

Then work through doctor's `nextSteps`, which are already in the right order:

- **`run-deps`** — the project uses dbt packages that are not downloaded yet. Say "Downloading
  the dbt packages this project uses," then run `dbt deps` (with the same dbt as below).
- **`run-parse` / `refresh-parse`** — offer to run `dbt.commands.parse`.
- **`run-catalog`** — full setup only: offer `dbt.commands.catalog`, warning that it connects to
  the warehouse; fine to skip. Otherwise do not run it now: say it adds exact types, offered later.
- **`fix-relationships` / `check-relationships`** — about relationships already in the project, not ones you wrote: tell the user in one line and point them at **ERD Studio: Repair Relationships…** (or the file the step names). Never edit them yourself.

Run exactly the command in doctor's `dbt.commands` (it has the right path, e.g. `.venv/bin/dbt parse`), never an activate-then-run pair: each command runs in a fresh shell, so it would not stick.

Only ever run `dbt --version`, `debug`, `deps`, `parse`, `docs generate` and `compile
--write-catalog` here — never `dbt run`, `build`, `seed` or `snapshot`, which change warehouse data.

If a command fails, quote the one key error line, look it up in
`references/dbt-setup.md` → "Common errors", explain it, and offer (a) the fix or (b) carrying on
without that file. Afterwards re-run doctor — introduce it like any other command ("Checking
again now that the manifest is built.") — and report what you have as short ✓ / – lines:

```
✓ dbt Core 1.9 (in .venv)
✓ profiles.yml found
✓ manifest.json — fresh
– catalog.json — skipped (column types will come from your .yml files)
```

## Stage 3 — Choose a business area (and, in a full setup, the modelling style)

### 3a. The business area

Say "Listing the models in your dbt project," then run `inventory --summary`. Summarise in two or
three lines: how many models, which folders, and how many are in ERD Studio (`alreadyModelled`).

Explain two terms, one line each:
- A **domain** is one focused diagram of related tables for one business area — for example
  "orders". It is saved as `.erd-studio/<layer>/<domain>.json`.
- A **layer** is a folder for organising diagrams, usually matching a stage of the warehouse such
  as silver or gold. It can be changed later.

Then propose **one concrete default** the user can accept with "yes". Pick it like this:
- If the user named an area, use the models whose names or folders match it first, then the rest
  of their `clusters` entry (connected by relationship tests), up to 15 in all.
- Otherwise use the largest `clusters` entry (models connected by dbt relationship tests),
  trimmed to at most 15 models, or else the biggest folder.
- Use their most common `suggestedLayer` (`null` → `core`); name the domain after the area in
  lowercase, e.g. `orders` or `customer-360`.

> "Let's start with **orders** (9 models, including `fct_order` and `dim_customer`) in the
> **gold** layer — layers are just folders for organising diagrams, you can change them later.
> OK?"

Only if they say no, list other clusters or folders (numbered). One domain of at most 15 models
works best: a small diagram is easy to check.

Explain one rule now, as it surprises people: **lines are only drawn between tables in the same
domain.** Keep a fact and its dimensions together; a shared one (`dim_customer`) can be in each.

Mention in one line any `skipped` models in the chosen area (a name ERD Studio does not accept, or
disabled in dbt): they cannot be used.

### 3b. The modelling style

**When.** In a full setup, now. In a quick start or when enriching, only after Stage 6, once
the user says yes to the style offer — never before the first canvas.

How a project is modelled decides what each table's role, grain and history mean. Two things
describe it, usually combined: **layering** — where data sits (medallion bronze → silver → gold,
or dbt's staging → intermediate → marts) — and **table shape** — how tables are designed (Kimball,
Data Vault, One Big Table, Activity Schema, Inmon / 3NF). `conventions` reports both, with
evidence. Never ask cold: **detect, then confirm.** Read `references/modelling-approaches.md` now
(section 4's table has the wording for every case).

- **If `.erd-studio/modelling-approach.md` describes a style** (more than a `## Metadata` list),
  confirm it in one line: "I'll follow your saved approach: Kimball dimensional modelling — say
  'change it' to update." Do not re-detect. On "change it", ask them to describe it (last bullets).
- **A table shape detected, `shape.confidence` strong** → one plain sentence with the evidence
  (and the layering, if found) and a yes default, alone in its message:

  > "Your project looks like a medallion layout (bronze → silver → gold) with Kimball-style
  > marts — `dim_`/`fct_` tables, and snapshots keep customer history. I'll model it that way.
  > Sound right? Or describe how your team does it."

  Mention only what `conventions` found, in plain words; with both, add that the layout is where
  data sits and the style how tables are shaped.
- **Weak or mixed** (`shape.confidence` weak) → the best guess and the first alternative in one
  question ("…I'll model it the Kimball way — sound right, or is it Data Vault?"). With no
  `alternatives`, drop the "or is it …" part. "Not sure" means the best guess.
- **Not from names** (`shape.sources` has no `names`) → say so honestly; with only `structure`
  it is a guess from table shape, worded as one (an `inmon-3nf` guess is always a real question).
- **No table shape detected** (`shape.style` none) → first glance at the inventory's model
  descriptions: one that clearly describes a style is a weak guess, asked as above. Otherwise do
  not make the user pick; say (after the layering, if found) "I couldn't see a particular
  modelling style, so I'll draw your model exactly as dbt has it." — after a quick start, "…so
  your diagram stays exactly as dbt has it; if your team follows one, describe it." No lookup,
  play-back, approach file or review; `modelRole`/`grain` only where unambiguous (section 4).
- **On a yes**, or when the user **describes it in their own words** (instead, or after "change
  it"), identify the technique(s) and **look up the standard** (section 1): narrate it ("Looking
  up Kimball's dimensional modelling standards on kimballgroup.com"), use a web tool if you have
  one, else the bundled summary, and say which you used. Never block on the lookup.
- An unrecognised technique or unclear house rules get **at most one** clarifying question.
- **Play it back** as 3–6 short, concrete bullets ("Here's how I'll apply that:" — e.g. "Facts
  store one row per business event, at the lowest detail available", "Customer history is kept
  as SCD Type 2 — a new row whenever details change"), then ask "Sound right?" (default yes).
  Define each term the first time (grain, surrogate key, SCD — `references/dbt-explained.md`).
- Keep the agreed rules for Stage 4 (none when no style was agreed). You save them there.

## Stage 4 — Write the logical model

1. Say "Loading ERD Studio's file-format rules first," and load them as your row in "Your AI
   assistant" says — the one source of truth for the formats. Do **not** show the user their
   "Building Models from External Sources" steps (column listing, scope, reconcile block): the
   Stage 5 `diff` reconciles more strictly; report one line per batch ("copied 24 columns…").
2. Prepare the user for the approval prompts they are about to see (see "Your AI assistant";
   Claude Code has two extra lines to say).
3. **Save the modelling approach**, only when a style was agreed, as
   `.erd-studio/modelling-approach.md` — new, or updated after "change it" — in the shape
   `references/modelling-approaches.md` section 5 shows: the technique, the user's words quoted
   verbatim, the evidence it was detected from, the rules, how each maps to ERD Studio fields,
   the sources you used and today's date. Tell them in one line: "Saved your modelling approach
   to `.erd-studio/modelling-approach.md` — future AI edits will follow it."
4. Say "Reading the full details of the models you picked," and run `inventory --models <the
   comma-separated names>`. Its `relationships` are exactly the lines the diff will expect for
   this set of models — which is why you ask for exactly the chosen models. Then **metadata**, on
   every route, with or without a style: read `references/metadata.md`, follow sections 2–4.
5. **Check for a thin project.** If most chosen models have `columnCount` 0, or their
   `provenance.columns` is only `file`, say "dbt doesn't list these columns anywhere yet, so ERD
   Studio can only see that the tables exist", then offer, in this order: (1) the catalog
   command, if dbt and a profile work (the models must have been built once); (2) drafting the
   columns from each model's final `SELECT` list, marked "(draft)", every drafted type added to
   "types to confirm"; (3) adding `relationships` tests to their dbt yml, opt-in and *before* the
   diff (`references/verify-and-fix.md` → "Adding dbt relationship tests").
6. Write the files by following `references/building-the-model.md`:
   - `layers.json`, only if it is missing or lacks the chosen layer;
   - one model file per model **not** already in the library (which folder: see that file) — columns,
     types and descriptions copied from the inventory (text in double quotes), never invented —
     **plus the approach's design fields** (`modelRole`, `grain`, `scdType`, `additiveType`,
     `isNaturalKey`, `rationale`), following `references/modelling-approaches.md` section 2 (with no agreed
     style, only what section 4 allows), **plus the metadata list's values from dbt**
     (`references/metadata.md` section 5). The approach never renames, adds or removes a column
     or a relationship: those come from dbt, and the diff checks them;
   - the domain file, `.erd-studio/<layer>/<domain>.json`, listing the models and copying the
     inventory `relationships` exactly.
   Models that already have a model file (in any folder) are **referenced by name, never rewritten** —
   they may be someone's careful design and other domains may share them.
7. Keep a list, **created this session**, of every model yml you wrote (Stage 5 needs it). Then
   run `doctor` and fix each `fix-model-yaml` file:line it lists first (usually a value to quote),
   then `check` and fix every finding in a file you wrote (`references/verify-and-fix.md` §8).
8. Tell the user what you wrote in one or two lines ("Wrote 8 model files and the `orders`
   diagram, marking 2 facts and 6 dimensions the Kimball way"), not file by file.

## Stage 5 — Check it against dbt

Explain "drift" before showing any: *drift* is any difference between the logical design and what
dbt actually has — a column one side has and the other does not, a different type, or a missing
connection. Then say "Comparing your logical model with the dbt project — the same check as the
**⊕ Diff** button on the canvas," and run `diff --domain .erd-studio/<layer>/<domain>.json`.

Then loop, following `references/verify-and-fix.md`, which maps every fix to its exact edit:

- **Blocking fixes on models created this session** — apply them without asking (physical is
  the source of truth for those), batching edits per file. One exception: a relationship that
  exists only in logical becomes a question — "dbt doesn't test this link yet. Add a
  relationships test to your dbt yml (recommended), or drop it?"
- **The Target-design backlog comes first.** If `.erd-studio/modelling-approach.md` has a
  "Target-design backlog", the differences listed there are intentional: report them as backlog
  items, recommend **keep**, and never apply the matching fix — on any model, including a shared
  one like `dim_customer` that an earlier run gave a target design.
- **Blocking fixes on models that existed before this session** — do not change them silently.
  Group them, describe them in plain English, and ask **once**: "Match dbt (recommended), or keep
  your design as it is?" Mention if a model is used by other domains, since its file is shared.
  If the user has already told you to leave their existing designs alone, their wish beats the
  default: recommend **keep** instead, and just list the drift so they know it is there.
- **`phantoms`** — models in the diagram that dbt does not have. Always ask (unless the backlog
  lists it as intentional): usually a typo or a model not built yet. Offer to rename it to the
  real dbt name or remove it from this domain. Never delete a model file under `logical-models/`.
- **`fix-model-yaml`** first, always — the file does not parse; fix that line, re-run the diff.
- **`needsMigration`** — older file format; suggest **ERD Studio: Migrate Domains to Central Model Store**, skip it now.
- Re-run the diff after each round of edits. **Stop after 3 rounds.** List what remains using
  each fix's `explain` text and suggest looking at it together with **⊕ Diff** on the canvas.

At the end:
- List the **advisory** rows once ("dbt doesn't know these column types yet — the catalog, Stage
  2, fills them in"). They do not block a clean result.
- Report success honestly from the diff's `counts`: "✓ Logical and physical match (N models, M
  columns, K relationships)". If some models have no column information in dbt, say so too — "N
  models have no column information in dbt yet, so there was nothing to compare for them" — and
  never call an empty comparison a full match.

**Then, only when a style was agreed, review against it** (`references/modelling-approaches.md`
section 6; skip it with no style): list, as plain-English suggestions, where the dbt project
departs from the saved rules. Offer (a) keep logical = physical (recommended — the diagram stays
in sync), or (b) record the improvements as a **target design**, saying plainly that the
remaining differences are then intentional, a to-do list, not errors. For (b) follow section 6
exactly: backlog from the review's findings, never from the diff; only column and relationship
changes in the logical model; never rename a model; never edit dbt files.

## Stage 6 — Open it in ERD Studio

- Tell the user how to see it: open the **ERD Studio** sidebar in VS Code, expand the layer,
  click the domain. ERD Studio auto-arranges it the first time it opens (re-run with **Layout**
  or Shift+L). **Logical** / **Physical** tabs are at the top; **⊕ Diff** compares them. Hovering
  a table's name or a column shows its description and metadata.
- Summarise the files you wrote, the approach you applied (or that you drew dbt as it is), and
  the **to confirm** list, if any: guessed column types, and any role or grain left blank
  because it was unclear. With a target design, say "logical is a target design: N backlog
  items" (every backlog line) and point to the backlog in `.erd-studio/modelling-approach.md`.
- Suggest next steps:
  - **quick start or enrich, first:** "Want me to apply your team's modelling style — keys,
    grain, SCD? That's the next step." (default yes). On a yes: Stage 3b, then the approach's
    design fields (Stage 4 steps 1–3 and step 6's design fields; metadata is settled) — for
    models not written this session, after one "Add these?" — then Stage 5 with its review and
    this summary again. No style found and none described: stop, the mirror is complete;
  - if the catalog was skipped: generating it (Stage 2) fills in exact column types;
  - any metadata next step `references/metadata.md` asks for (sections 3, 5 and 6);
  - fill in any descriptions marked "(draft)" and the blanks on the "to confirm" list;
  - another business area: run `/erd-studio-setup` again (safe — existing models are kept, the
    saved approach reused), or draft it with **Draw from dbt…** and run this again to enrich it;
  - after changing dbt, run `dbt parse` and click **⊕ Diff** on the canvas;
  - future logical ↔ dbt changes can go through the canvas: **⊕ Diff** → **⊕ Sync** → **Apply
    Changes** writes a sync plan the schema skill's SYNC.md guide carries out (with a target
    design, backlog items are listed too and kept, being marked intentional).
- If the inventory hinted at connections dbt does not test yet (a `<thing>_id` column pointing
  at a model with that key, e.g. `fct_order.customer_id → dim_customer`), offer once: "Adding
  `relationships` tests to your dbt yml would make them appear in both views. Want me to do that?"
  The only dbt edit, and only on a yes; then run `dbt parse` (if available) and the diff again.

## Enriching an existing diagram

The diagram's columns and connections already mirror dbt; what is missing is the design dbt does
not record. Add it — never rebuild, rename, or change a column, type or relationship.

1. Glob `.erd-studio/*/*.json` and propose one domain (the one named, else the largest): "You
   already have the **orders** diagram (8 models). I'll add what dbt doesn't record — keys,
   grain, roles and why — and leave its columns and connections alone. OK?"
2. Load the format rules and prepare the approval prompts (Stage 4 steps 1–2). Read the domain
   and model files, run `inventory --models <its models>`, then Stage 5 on the domain (these
   models existed before this session: drift is asked once).
3. Draft, per model, only what is missing and backed by evidence: `isPrimaryKey` /
   `isForeignKey` from the inventory (`references/building-the-model.md` table); `grain` where a
   unique test backs it; `isNaturalKey` on an obvious source business key; `modelRole` only where
   the name or description already says it (values: `references/modelling-approaches.md` §2);
   `rationale.purpose` from dbt's description; dbt's metadata (`references/metadata.md`, offered
   with these drafts). Anything unclear goes on the "to confirm" list.
4. Show the drafts as one short list per model, ask "Add these?" once, and write them on a yes.
5. Re-run the diff, then Stage 6 — whose first next step is the modelling-style offer.

## Reference files

Read these when the stage calls for them — not all up front:

| File | Read it when |
|---|---|
| `references/dbt-explained.md` | You are about to use a term the user may not know |
| `references/dbt-setup.md` | Installing dbt, writing `profiles.yml`, a dbt command failed |
| `references/modelling-approaches.md` | Stage 3b (the modelling style), Stage 4 (applying it), the Stage 5 review |
| `references/metadata.md` | Stage 4 and enriching, before writing model files: dbt's `meta:` and the team's metadata list |
| `references/building-the-model.md` | Stage 4, before writing any file |
| `references/verify-and-fix.md` | Stage 5, and for adding dbt relationship tests |
| `references/troubleshooting.md` | The helper is missing or stale (canvas-fallback mode), the skill or its format rules cannot be found, the safety check keeps blocking, Windows / remote setups |
