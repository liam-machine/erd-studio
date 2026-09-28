---
name: erd-studio-setup
description: >-
  Friendly, step-by-step setup for ERD Studio in an existing dbt project, for people who may be
  new to dbt or data modelling. Checks the dbt CLI (install, profiles.yml, dbt parse, catalog),
  detects how the project is modelled (medallion or staging/marts layers; Kimball, Data Vault,
  One Big Table or Activity Schema tables) and confirms it with the user - or mirrors dbt exactly
  when no style shows - builds ERD Studio logical models and domains from the dbt project, then
  checks them with the ERD Studio diff until logical matches physical.
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

The finished result is: one or more ERD Studio *domains* whose logical model follows the team's
modelling approach and has been checked against the dbt project with the ERD Studio diff, and
either matches it or has every remaining difference explained.

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
  – 2. Refresh dbt's project files (skipped — not needed without dbt)
  → 3. Choose a business area and modelling style
    4. Write the logical model
    5. Check it against dbt
    6. Open it in ERD Studio
  ```

  Mark a skipped step "–" with a few words why, never "✓" — a tick claims work that did not happen.
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
  `.agents/skills/erd-studio/` of the project folder. ERD Studio installs whichever folder the
  user's assistants read, so check both and read the one that exists, in full. Its `SYNC.md`
  guide sits next to it. If neither exists, see `references/troubleshooting.md` → "Format rules
  missing".
- Wherever this skill says the user can "run `/erd-studio-setup` again", use your own row's form.
- **Approvals.** Every assistant asks before it changes a file or runs a command unless the user
  has allowed it. Tell the user once, in Stage 4, in words that fit their assistant, and say that
  approving is expected. Describe only buttons you are sure your assistant has.
- **Shell.** Your commands may run in bash, zsh, Git Bash or PowerShell. On Windows, see the
  helper's Windows route below.
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
  this check (Copilot can run it if Claude hooks are enabled in its settings, and it then lets
  every change through).

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
- For `diff`, exit code 1 is **not** a failure — it means "differences found", which is exactly
  what Stage 5 is for.
- On Windows, if the shell cannot run the file above (PowerShell always cannot), use
  `~/.erd-studio-cli/bin/erd-studio.cmd` (in PowerShell: `& "$HOME\.erd-studio-cli\bin\erd-studio.cmd" …`).
  Tell the user which route you are using.

If no route to the helper works, carry on in **canvas-fallback mode** (see the end of this file)
and tell the user its checks are less exact.

---

## Stage 0 — Say hello and explain

Greet the user and explain, in about five short lines:

- ERD Studio shows data two ways. **Physical** is what really exists in the dbt project — it is
  read-only and ERD Studio works it out for itself. **Logical** is the design: the tables, their
  keys, and how they connect.
- This walkthrough builds the logical view from what already exists, following the way their
  project is already modelled, then checks it against physical until they match.
- It takes six steps (show the checklist) and nothing in their dbt project changes unless they
  say so.

Then ask "Ready?". Once doctor has run (Stage 1), if `erd.logicalModels > 0` add one line: "You
already have N logical models — I won't change any of them without asking first."

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
- **`fusion-v2`** — explain that this is dbt's new engine (dbt Fusion). Everything works; the
  column types come from `dbt compile --write-catalog` instead of `dbt docs generate`.
- **`cloud-cli`** — explain that this is the dbt platform CLI: it runs the project on dbt's
  servers and signs in with `dbt_cloud.yml`, not `profiles.yml`, so the files ERD Studio reads
  may not appear on this machine. Offer two routes: carry on from the project files alone (the
  default), or install dbt Core in a local environment (`references/dbt-setup.md`).
- **`unknown`** — say dbt answered in a way you did not recognise, show the first line of
  `rawVersionOutput`, and treat it like Core.
- **Not found** (`dbt.found: false`) — first ask **one** question, because dbt is often
  installed but hidden in an environment this terminal cannot see:

  > "Do you usually run dbt from a particular terminal or environment? If so, run `which dbt`
  > there (`where dbt` on Windows) and paste what it prints — or say 'no dbt'."

  If they paste a path, re-run doctor with `--dbt '<that path>'` — single-quoted, and on Windows
  with the backslashes turned into forward slashes (`'C:/Users/me/…/dbt.exe'`), because your
  shell may treat a backslash as an escape. Remember that path and pass the same `--dbt` on
  **every later doctor run**, exactly like `--project`; without it doctor reports dbt missing
  again. If they say no dbt, explain that **dbt is optional**: ERD Studio can read the `.sql` and
  `.yml` files directly, and dbt adds exact column lists and types. Offer the install steps for
  their operating system from `references/dbt-setup.md`, ask whether to install now or carry on
  without it, and never insist.

If `profiles.required` is true and `profiles.found` is false, explain what `profiles.yml` is (the
file that tells dbt which warehouse to use and how to sign in) and offer to create one from the
templates in `references/dbt-setup.md`. `dbt parse` needs a profile to exist but connects to
nothing, so placeholder values (the templates' `env_var('…', 'placeholder')` defaults) are enough.

If `erd.domainFormatIssues` lists files, say some existing diagrams use an older file format and
suggest **ERD Studio: Migrate to v5** (VS Code Command Palette) before checking them; new ones are fine.

Show the checklist and move on.

## Stage 2 — Refresh dbt's project files

First explain the two files ERD Studio reads from dbt, in one line each:

- The **manifest** (`manifest.json`) is dbt's map of every model, column and test. `dbt parse`
  builds it in seconds without touching the warehouse.
- The **catalog** (`catalog.json`) holds the real column types, read from the warehouse. It needs
  a working connection and can take a minute.

Then work through doctor's `nextSteps`, which are already in the right order:

- **`run-deps`** — the project uses dbt packages that are not downloaded yet. Say "Downloading
  the dbt packages this project uses," then run `dbt deps` (with the same dbt as below).
- **`run-parse` / `refresh-parse`** — offer to run `dbt.commands.parse`.
- **`run-catalog`** — offer `dbt.commands.catalog`, warning that it connects to the warehouse.
  It is fine to skip; say what it would add (exact types) and that you can do it later.

Run exactly the command doctor gives in `dbt.commands` — it has the right path, e.g.
`.venv/bin/dbt parse` (`.venv/Scripts/dbt.exe parse` on Windows), never an activate-then-run pair:
every command runs in a fresh shell, so activation would not stick.

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

## Stage 3 — Choose a business area and modelling style

### 3a. The business area

Say "Listing the models in your dbt project," then run `inventory --summary`. Summarise in two or
three lines: how many models, which folders, and how many are already in ERD Studio
(`alreadyModelled`).

Explain two terms, one line each:
- A **domain** is one focused diagram of related tables for one business area — for example
  "orders". It is saved as `.erd-studio/<layer>/<domain>.json`.
- A **layer** is a folder for organising diagrams, usually matching a stage of the warehouse such
  as silver or gold. It can be changed later.

Then propose **one concrete default** the user can accept with "yes". Pick it like this:
- If the user named an area, use the models whose names or folders match it.
- Otherwise use the largest `clusters` entry (models connected by dbt relationship tests),
  trimmed to at most 15 models, or else the biggest folder.
- Use the most common `suggestedLayer` among those models; if it is `null`, use `core`.
- Name the domain after the business area in lowercase, e.g. `orders` or `customer-360`.

> "Let's start with **orders** (9 models, including `fct_order` and `dim_customer`) in the
> **gold** layer — layers are just folders for organising diagrams, you can change them later.
> OK?"

Only if they say no, show a short numbered list of the other clusters or folders to choose from.
A first run works best with one domain of at most 15 models — a small diagram is easy to check.

Explain one rule now, because it surprises people later: **lines are only drawn between tables
in the same domain.** Keep a fact table and its dimensions together; a dimension used by several
areas (like `dim_customer`) can be added to each domain — shared by name, not copied.

Models listed in `skipped` cannot be used (a name ERD Studio does not accept, or disabled in dbt);
mention them in one line if any fall in the chosen area.

### 3b. The modelling style

How a project is modelled decides what each table's role, grain and history mean. Two things
describe it, usually combined: **layering** — where data sits (medallion bronze → silver → gold,
or dbt's staging → intermediate → marts) — and **table shape** — how tables are designed (Kimball,
Data Vault, One Big Table, Activity Schema, Inmon / 3NF). `conventions` reports both, with
evidence. Never ask cold: **detect, then confirm.** Read `references/modelling-approaches.md` now.

- **If `.erd-studio/modelling-approach.md` exists**, read it and confirm in one line: "I'll follow
  your saved approach: Kimball dimensional modelling — say 'change it' to update." Do not
  re-detect. On "change it", ask them to describe it and follow the last bullets below.
- **A table shape detected, `shape.confidence` strong** → one plain sentence with the evidence
  (and the layering, if found) and a yes default, alone in its message:

  > "Your project looks like a medallion layout (bronze → silver → gold) with Kimball-style
  > marts — `dim_`/`fct_` tables, and snapshots keep customer history. I'll model it that way.
  > Sound right? Or describe how your team does it."

  Mention only what `conventions` found, in plain words; with both, add that the layout is where
  data sits and the style how tables are shaped.
- **Weak or mixed** (`shape.confidence` weak) → best guess and alternative in one question:

  > "Your tables look mostly Kimball-style (`dim_`/`fct_` names), but `hub_customer` looks like
  > Data Vault. I'll model it the Kimball way — sound right, or is it Data Vault? Or describe how
  > your team does it."

  With no `alternatives`, drop the "or is it …" part. "Not sure" means the best guess.
- **Not from names** (`shape.sources` has no `names`) → say so honestly; with only `structure`
  it is a guess from table shape, worded as one (section 4 has each style, incl. `inmon-3nf`):

  > "Your tables are shaped like a Data Vault — `customer_hub` and `order_hub` hold hash keys
  > with load dates, and `customer_sat` tracks changes with a hashdiff. I'll model it that way —
  > sound right? Or describe how your team does it."

- **No table shape detected** (`shape.style` none) → first glance at the inventory's model
  descriptions: one that clearly describes a style is a weak guess, asked as above (section 4).
  Otherwise do not make the user pick. Say, with no question (after the layering, if found —
  "Your project uses dbt's staging → marts layout."): "I couldn't see a particular modelling
  style, so I'll draw your model exactly as dbt has it." No lookup, play-back, saved approach
  file or conformance review; `modelRole` and `grain` only where unambiguous (section 4); a style
  is an optional Stage 6 next step. Recommend none.
- **On a yes**, or when the user **describes it in their own words** (instead, or after "change
  it"), identify the technique(s) and **look up the standard** (section 1): narrate it ("Looking
  up Kimball's dimensional modelling standards on kimballgroup.com"), use a web tool if you have
  one, else the bundled summary, and say which you used. Never block on the lookup.
- An unrecognised technique or unclear house rules get **at most one** clarifying question.
- **Play it back** as 3–6 short, concrete bullets, then ask "Sound right?" (default yes):

  > "Here's how I'll apply that:
  > - Facts store one row per business event, at the lowest detail available.
  > - Dimensions like customer and product are shared across areas, not copied.
  > - Dimensions get a surrogate key; the source system's id is kept as a natural key.
  > - Customer history is kept as SCD Type 2 — a new row whenever details change.
  > Sound right?"

  Define each term the first time (grain, surrogate key, SCD — `references/dbt-explained.md`).
- Keep the agreed rules for Stage 4 (none when no style was agreed). You save them there.

## Stage 4 — Write the logical model

1. Say "Loading ERD Studio's file-format rules first," and load them the way your row in "Your
   AI assistant" says — the one source of truth for the file formats. One exception: do **not**
   show the user their "Building Models from External Sources" steps (column listing, scope,
   reconcile block); `inventory` supplies the columns and the Stage 5 `diff` reconciles more
   strictly, so report one line per batch ("copied 24 columns from dbt into 6 model files").
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
   this set of models — which is why you ask for exactly the chosen models.
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
     types and descriptions copied from the inventory, never invented — **plus the approach's
     design fields** (`modelRole`, `grain`, `scdType`, `additiveType`, `isNaturalKey`,
     `rationale`), following `references/modelling-approaches.md` section 2 (with no agreed
     style, only what section 4 allows). The approach never renames, adds or removes a column
     or a relationship: those come from dbt, and the diff checks them;
   - the domain file, `.erd-studio/<layer>/<domain>.json`, listing the models and copying the
     inventory `relationships` exactly.
   Models that already have a model file (in any folder) are **referenced by name, never rewritten** —
   they may be someone's careful design and other domains may share them.
7. Keep a list, **created this session**, of every model yml you wrote (Stage 5 needs it).
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
- **`needsMigration`** — older file format; suggest **ERD Studio: Migrate to v5**, skip it now.
- Re-run the diff after each round of edits. **Stop after 3 rounds.** If anything remains, list
  it using each fix's `explain` text and suggest opening the domain and clicking **⊕ Diff** in
  the canvas toolbar to look at it together.

At the end:
- List the **advisory** rows once: "dbt doesn't know these column types yet. Generating the
  catalog (Stage 2) will fill them in." They do not block a clean result.
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
  click the domain. ERD Studio auto-arranges the diagram (auto layout) the first time it opens; they can re-run it any time with **Layout** in the toolbar or Shift+L.
  The **Logical** / **Physical** tabs are at the top, and **⊕ Diff** compares the view you are on with the other one.
- Summarise the files you wrote, the approach you applied (or that you drew dbt as it is), and
  the **to confirm** list, if any: guessed column types, and any role or grain left blank
  because it was unclear. With a target design, say "logical is a target design: N backlog
  items" (every backlog line) and point to the backlog in `.erd-studio/modelling-approach.md`.
- Suggest next steps:
  - fill in any descriptions marked "(draft)" and the blanks on the "to confirm" list;
  - with no agreed style, optionally: "If your team follows a modelling style, such as Kimball
    or Data Vault, tell me and I'll apply it and check your project against it.";
  - run `/erd-studio-setup` again for another business area — it is safe to re-run, existing
    models are kept and the saved approach is reused;
  - after changing dbt, run `dbt parse` and click **⊕ Diff** on the canvas;
  - future logical ↔ dbt changes can go through the canvas: **⊕ Diff** → **⊕ Sync** → **Apply
    Changes** writes a sync plan the schema skill's SYNC.md guide carries out (with a target
    design, backlog items are listed too and kept, being marked intentional).
- If the inventory hinted at connections dbt does not test yet (a `<thing>_id` column pointing
  at a model with that key, e.g. `fct_order.customer_id → dim_customer`), offer once: "Adding
  `relationships` tests to your dbt yml would make them appear in both views. Want me to do that?"
  The only dbt edit, and only on a yes; then run `dbt parse` (if available) and the diff again.

---

## Canvas-fallback mode (no helper available)

When no route to the helper works:
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

Tell the user once that checks in this mode are less exact than with the helper.

## Reference files

Read these when the stage calls for them — not all up front:

| File | Read it when |
|---|---|
| `references/dbt-explained.md` | You are about to use a term the user may not know |
| `references/dbt-setup.md` | Installing dbt, writing `profiles.yml`, a dbt command failed |
| `references/modelling-approaches.md` | Stage 3b (the modelling style), Stage 4 (applying it), the Stage 5 review |
| `references/building-the-model.md` | Stage 4, before writing any file |
| `references/verify-and-fix.md` | Stage 5, and for adding dbt relationship tests |
| `references/troubleshooting.md` | The helper is missing or stale, the skill or its format rules cannot be found, the safety check keeps blocking, Windows / remote setups |
