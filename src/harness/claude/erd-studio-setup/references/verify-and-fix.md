# Verify and fix

Stage 5 compares the logical model you wrote with the physical dbt project and fixes the logical
side until they match. The comparison is the **same code** as the canvas's **⊕ Diff** button
(on the Logical tab it compares against Physical), so a clean result here means a clean result
on the canvas.

## Contents
1. Reading `diff --json`
2. Fix kinds → exact edits
3. Who decides: the fix rules
4. The loop
5. Adding dbt relationship tests
6. Fallback A — the canvas writes a sync plan
7. Fallback B — manual comparison
8. Relationship checks (`check --json`)

---

## 1. Reading `diff --json`

```
~/.erd-studio-cli/bin/erd-studio diff --domain .erd-studio/<layer>/<domain>.json --json --semantic-dir .erd-studio
```

Exit code 0 means clean, 1 means differences were found (not a failure), 3 means the domain
file or project could not be read (the JSON `error` says why).

Top level:

| Field | Meaning |
|---|---|
| `inputs.manifest`, `inputs.catalog` | `ok` / `missing` / `stale` / `unreadable` — how much dbt information the comparison had. A missing catalog means fewer types to compare, not a broken result |
| `clean` | Every domain checked has zero blocking differences |
| `domains[]` | One entry per domain checked |

Per domain (`domains[i]`):

| Field | Meaning |
|---|---|
| `file`, `domain`, `layer` | Which diagram this is |
| `error` | Set when this one domain could not be checked; explain it and move on |
| `needsMigration` | The domain uses the older (v4) format. There are no fixes; suggest **ERD Studio: Migrate to v5** from the Command Palette, then re-run |
| `clean` | No blocking differences in this domain |
| `counts.blocking` / `counts.advisory` | How many differences of each kind |
| `counts.matchedModels` / `matchedColumns` / `matchedRelationships` | What matched — use these in the success line |
| `phantoms[]` | Models in the diagram that dbt does not have: `reason` is `absent` (not in the project at all) or `disabled` (dbt has it switched off). They are left out of the comparison |
| `missingModelFiles[]` | Names in `logical.models` with no model file (at the top of `logical-models/` or in any folder) |
| `unreadableModelFiles[]` | Model files that exist but are not valid YAML: `name`, `file`, `line`, `code` (e.g. `BLOCK_AS_IMPLICIT_KEY`), `kind`, `message`. ERD Studio sees these models as empty, so each gets one `fix-model-yaml` fix instead of its column fixes |
| `fixes[]` | What to change, already sorted: blocking first, then by model and column |
| `integrity[]` | The relationship checks (section 8) that concern this diagram. **Not** part of the comparison: they never make it unclean or change the exit code. Fix the ones in files you wrote this session; mention the rest |
| `report` | The raw comparison — you rarely need it |
| `plan` | The same content as a canvas sync plan, with dbt as the source of truth everywhere |

Each fix:

| Field | Meaning |
|---|---|
| `severity` | `blocking` — must be fixed or explained for a clean result. `advisory` — dbt has no type for this column yet; not drift you can fix in ERD Studio |
| `kind` | What to do (section 2) |
| `model`, `column` | Where |
| `file` | The file to edit, relative to the project folder: the model's yml under `logical-models/` (its real folder, when the library is grouped by layer) or the domain JSON. For a relationship it is wherever that relationship is defined — the yml of the model holding the foreign key when it is stored in the model library |
| `from`, `to` | Current logical value and the dbt value, for types and cardinalities — a cardinality pair reads in the direction of `relationship`. **Write `to`** (never `one-to-many`) |
| `relationship` | The connection, for relationship fixes. For `add-relationship` and `set-cardinality` it is exactly the entry to store: ends, direction, `cardinality` and, for `set-cardinality`, the `role` the entry already has |
| `movesFrom` | `set-cardinality` only: the file the relationship is in now, when it has to move to `file` |
| `alsoIn` | `remove-relationship` and `set-cardinality`: other files that hold a copy of the same relationship (the same two columns, either way round) — remove the copy from each, so it ends up stored once (or, for a removal, nowhere) |
| `explain` | One plain-English sentence — use it when describing the fix to the user |

## 2. Fix kinds → exact edits

| kind | Edit |
|---|---|
| `fix-model-yaml` | **Fix these first.** The file at `file` does not parse (`line` says where). Almost always an unquoted value: wrap it in double quotes (see the quoting rule in building-the-model.md). A tab → spaces; a key twice → keep one; `---` or a code fence → remove it. Re-run the diff before any other fix — until the file parses, every other difference for that model is noise |
| `add-column` | Append `{ name, dataType, description }` to `columns` in `logical-models/<model>.yml`. `dataType` is `to` (the dbt type), in double quotes; if that is empty, use the SQL cast or `STRING` and add it to "types to confirm". Description: the inventory's text copied verbatim **inside double quotes** (escape any inner `"` as `\"`), or a draft ending in "(draft)" |
| `remove-column` | Delete the column from the yml, **and** delete every relationship that names it: in the domain JSON (`fromModel`/`fromColumn` or `toModel`/`toColumn`), in this model's own `relationships:` (`fromColumn`), and in any other model yml's `relationships:` that points at it (`toModel`/`toColumn`) |
| `set-type` | Set the column's `dataType` to `to` |
| `add-relationship` | Add `relationship` (with its `cardinality`) where the project keeps relationships — the `fromModel`'s yml `relationships:` (without `fromModel`) or `logical.relationships` in the domain JSON, by the `/erd-studio` skill's "Where relationships live" — then set `isForeignKey: true` on the `fromColumn` in that yml if it is not already. `relationship` is already on its many side; if you ever see a `one-to-many`, swap the ends and write `many-to-one` in the other model's yml |
| `remove-relationship` | Remove the matching entry from `file` — a model yml's `relationships:` or `logical.relationships` — and every copy in `alsoIn`. A relationship in a yml is shared by every diagram holding both models, so say so. This is always a question first — see section 3 |
| `set-cardinality` | Make the matching relationship (the same two columns, whichever way round it is written) read exactly as `relationship`, in the file `file` names — a model yml's `relationships:` or the domain JSON. When `movesFrom` is set, take the entry out of that file and add `relationship` to `file` (without `fromModel` in a yml), keeping its `role`. Remove every copy in `alsoIn`. When the ends in `relationship` are the other way round from the entry, replace the entry, keeping its `role`. A yml change shows in every diagram holding both models |
| `resolve-phantom` | Always a question: rename it in `logical.models` (and its relationships — in the domain JSON and in any model yml's `relationships:` whose `toModel` names it) to the real dbt model name, or remove it from this domain. **Never** delete its `logical-models/*.yml` — other domains may use it |

For `missingModelFiles`: if the model exists in dbt, write its yml from `inventory --models
<name>` (building-the-model.md). If it does not, treat it like a phantom and ask.

Edit the yml and JSON with Edit, keeping everything else in the file untouched — comments, key
order, other columns, and especially `viewConfig.positions`.

## 3. Who decides: the fix rules

Physical (the dbt project) is the source of truth by default, but *how* you apply that depends on
who owns the model.

**Models created this session** (in your "created this session" list): apply blocking fixes
without asking — you just wrote them from dbt, so a difference is your mistake or a detail the
inventory could not show. Batch all edits to one file into one Edit where you can.

Exception — **a relationship only logical has** (`remove-relationship`) between models you
created: ask, because the link may be real and simply untested in dbt:

> "dbt doesn't test the link from `fct_order.customer_id` to `dim_customer` yet. I can add a
> `relationships` test to your dbt yml so it shows up in both views (recommended), or drop it
> from the diagram. Which would you like?"

**Models that existed before this session:** they may be someone's deliberate design. Do not
change them silently. Group every blocking fix for them into one plain-English summary and ask
once:

> "Your existing `dim_customer` design differs from dbt in 3 places: it has a `loyalty_tier`
> column dbt doesn't, and `email` is `TEXT` in the design but `VARCHAR(255)` in dbt, and … Match
> dbt (recommended), or keep your design as it is?"

If a pre-existing model appears in other domains, say so — its file is shared, so the change
shows everywhere. If they keep their design, stop fixing those items and list them as "kept by
choice" at the end; they do not count against you.

**Intentional differences — the Target-design backlog.** Before applying or recommending any
fix, read the "Target-design backlog" section of `.erd-studio/modelling-approach.md`, if there is
one. Differences listed there are intentional: report them as backlog items, recommend **keep**,
and never apply the matching fix — whether the
model was created this session or existed before, and whether the difference is a column, a
relationship or a phantom. They count as "kept by choice", not against a clean result.

**Advisory fixes** are never applied. List them once at the end: "dbt doesn't know these column
types yet. Generating the catalog (Stage 2) will fill them in."

## 4. The loop

1. Run the diff.
2. Fix every `fix-model-yaml` first, then run the diff again — the other fixes for that model
   only mean something once its file parses.
3. Apply or ask about the fixes, following section 3.
4. Run the diff again.
5. Repeat — **at most 3 rounds.** Each round should shrink the list; if it does not, something
   is off that edits will not solve (a stale manifest, a model dbt disables, a case the rules do
   not cover). Stop, list what remains using each fix's `explain`, and suggest opening the domain
   and clicking **⊕ Diff** in the canvas toolbar to look at it together.

Success line, from `counts`:

> ✓ Logical and physical match (5 models, 41 columns, 4 relationships)

Be honest about what was compared. A model whose only evidence is its SQL file has no columns
in dbt, and the comparison skips its columns — so if any chosen model had `columnCount` 0, add:
"2 models have no column information in dbt yet, so there was nothing to compare for them."
Never say "everything matches" over empty models.

## 5. Adding dbt relationship tests

Only with the user's yes — this is the one place the walkthrough edits dbt files. It is worth
offering because a connection dbt tests appears in **both** views, and dbt then checks it on
every run.

Add the test to the model's schema yml — the inventory's `ymlFile` for the from-model. If the
model has no yml, create one next to its SQL file (`models/marts/fct_order.yml`) with
`version: 2` and a `models:` list. Match the file's existing style: `data_tests:` or `tests:`,
and the `arguments:` nesting if the file already uses it. Use `arguments:` for dbt 1.10+ and
Fusion:

```yaml
models:
  - name: fct_order
    columns:
      - name: customer_id
        data_tests:
          - relationships:
              arguments:
                to: ref('dim_customer')
                field: customer_id
              config:
                severity: warn
```

Older style (dbt before 1.10):

```yaml
      - name: customer_id
        tests:
          - relationships:
              to: ref('dim_customer')
              field: customer_id
              config:
                severity: warn
```

Explain `severity: warn` in one line: "I've set these to warn rather than fail, so if the data
has a few orphan rows today your dbt runs keep working — you can make them strict later."

Cardinality comes from `unique` tests: without a `unique` test on `dim_customer.customer_id`, dbt
sees the link as many-to-many. If the target column has no `unique` test, offer to add `unique`
and `not_null` (also `severity: warn`) in the same change.

Afterwards run `dbt parse` if dbt is available (ERD Studio also reads the yml directly, so the
link appears even without dbt), then run the diff again.

## 6. Fallback A — the canvas writes a sync plan

Use this when the helper cannot run. Ask the user to:

> 1. Open the domain from the ERD Studio sidebar.
> 2. On the **Logical** tab, click **⊕ Diff** in the toolbar.
> 3. In the comparison panel that opens, click **⊕ Sync**.
> 4. In the window that opens, click **Keep all** in the **Physical** column for each model, and
>    pick the Physical side for any row still waiting (relationships have their own rows). Then
>    click **Apply Changes** at the bottom.
> 5. Come back here and tell me when it's done. (If VS Code offers **Execute with Claude**, you
>    can skip that — I'll take it from here.)

That writes `.erd-studio/.sync-plan.json`. Read it. Its `columns[]`, `relationships[]` and
`models[]` entries carry an `action` and, for types, `resolvedDataType` — always write
`resolvedDataType`, never `sourceDataType`/`targetDataType`. The logical-side actions map to the
edits above:

| Sync-plan action | Same as |
|---|---|
| `add-column-to-logical` | `add-column` |
| `remove-column-from-logical` | `remove-column` |
| `update-type-in-logical` | `set-type` (write `resolvedDataType`) |
| `add-relationship-to-logical` | `add-relationship` |
| `remove-relationship-from-logical` | `remove-relationship` (ask first, section 3) |
| `update-cardinality-in-logical` | `set-cardinality`, but the plan carries no `relationship`: build it from the action's ends and `targetCardinality`, which reads in the direction of those ends. A `one-to-many` is never written as `one-to-many` — swap the ends and write `many-to-one` (in a model yml, the other model's file). When the stored entry's ends run the other way round from what you built, replace the entry, keeping its `role` — never just change its `cardinality` in place |
| `add-to-logical` / `remove-from-logical` | ask first — adding or removing a whole model from the domain |

Apply the same rules from section 3 about who decides. Delete `.erd-studio/.sync-plan.json` when
you are done, then ask the user to click **⊕ Diff** again to confirm. Treat the canvas's result as the
check, up to the same 3 rounds.

## 7. Fallback B — manual comparison

Only when neither the helper nor the canvas is available. Tell the user plainly that this is
best-effort and less exact than ERD Studio's own check.

For each model: read its dbt schema yml (and the manifest's node, if `target/manifest.json`
exists), list its columns and `data_type:` values, and compare them with the logical yml by name,
ignoring case. Compare `relationships` tests between two models in the domain with the
relationships the domain draws: its own `logical.relationships` plus every model yml
`relationships:` entry whose two models are both in the domain. Fix the logical side as in section 2, and recommend opening the canvas
and clicking **⊕ Diff** as soon as they can.

## 8. Relationship checks (`check --json`)

```
~/.erd-studio-cli/bin/erd-studio check --json --semantic-dir .erd-studio
```

Checks every relationship in the ERD Studio files — the model library and every domain file —
with the same rules the canvas uses. It reads no dbt files, so it is quick. Exit code 0 means no
errors, 1 means errors (with `--strict`, warnings too) or a file it could not check at all,
3 means the project or the ERD Studio folder was not found. If it answers *Unknown command "check"*, the helper is older than these
checks: run `doctor --json` instead and re-read your relationships against the schema skill's
rules.

Top level: `clean`, `mode` (`library` — relationships live in model files — or `domain` — in
each domain file), `counts` (`errors`, `warnings`, `info`, `byCode`), `unchecked[]` (files
it could not check at all, each with its `file`, `reason` and `kind`: `model` — a model yml that
does not parse, so its relationships were never read; `domain` — a domain JSON it could not read
or load; `layers` — a `layers.json` it could not use, so a layer folder may have been skipped. Fix
a file you wrote; tell the user about the rest), `olderFormat[]` (domain files still in the v4 format: Repair Relationships…
does not change them until they are migrated) and `findings[]`. Each
finding has a `code`, a `severity`, a plain `message`, the `files` involved (project-relative),
a `line` when known and `records[]` (each stored entry: its `file`, its ends as written, its
`cardinality` and `role`).

| code | Meaning | What to do in a file you wrote |
|---|---|---|
| `REL001` | The same two columns are stored more than once (either way round). An error when the copies disagree | Keep one entry, in its home (the many-side model's yml, or the domain file in a per-domain project); delete the others. If they disagree, ask which is right |
| `REL002` | A `one-to-many` in a model yml | Take it out, swap the ends and add it as `many-to-one` to the other model's yml |
| `REL003` | An end names a model that is not in the model library — or, for a domain JSON's own entry, a model that is not one of that domain's `logical.models` (the diagram cannot draw it) | Fix the name, add the model to the domain, or ask whether to remove the relationship |
| `REL004` | An end names a column its model does not have | Fix the column name (or add the column, if dbt has it) |
| `REL005` | A name matches only when case is ignored | Spell it exactly as the model's file does |
| `REL006` | A note: the direction contradicts the keys (e.g. the `fromColumn` is its model's whole primary key) | Check the direction against the schema skill's rule; ask when unsure. Never fails a run |
| `REL008` | An entry could not be read as written (no `cardinality`, an unknown one such as `one_to_many`, a missing end, a stray `fromModel:` in a yml, a `role` longer than 60 characters), in a model yml or a domain JSON, or a `relationships:` that is not a list; `line` says where in a yml, the message names the entry's position in a domain JSON | Fix that entry; ERD Studio never rewrites it for you |
| `REL009` | A note: a domain file repeats a relationship the model library already holds | Remove the domain file's copy if you wrote it |

Fix only what is in files you wrote this session. Anything else is the user's: list it in plain
words and suggest **ERD Studio: Repair Relationships…** from the Command Palette, which shows
every change before it writes anything. Re-run `check` after your edits.
