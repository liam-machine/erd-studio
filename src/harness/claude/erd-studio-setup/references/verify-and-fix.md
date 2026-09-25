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
| `missingModelFiles[]` | Names in `logical.models` with no `logical-models/<name>.yml` file |
| `fixes[]` | What to change, already sorted: blocking first, then by model and column |
| `report` | The raw comparison — you rarely need it |
| `plan` | The same content as a canvas sync plan, with dbt as the source of truth everywhere |

Each fix:

| Field | Meaning |
|---|---|
| `severity` | `blocking` — must be fixed or explained for a clean result. `advisory` — dbt has no type for this column yet; not drift you can fix in ERD Studio |
| `kind` | What to do (section 2) |
| `model`, `column` | Where |
| `file` | The file to edit, relative to the project folder: the model's `logical-models/<model>.yml` or the domain JSON |
| `from`, `to` | Current logical value and the dbt value, for types and cardinalities. **Write `to`** |
| `relationship` | The connection, for relationship fixes |
| `explain` | One plain-English sentence — use it when describing the fix to the user |

## 2. Fix kinds → exact edits

| kind | Edit |
|---|---|
| `add-column` | Append `{ name, dataType, description }` to `columns` in `logical-models/<model>.yml`. `dataType` is `to` (the dbt type); if that is empty, use the SQL cast or `STRING` and add it to "types to confirm". Description from the inventory, or a draft ending in "(draft)" |
| `remove-column` | Delete the column from the yml, **and** delete any relationship in the domain JSON whose `fromModel`/`fromColumn` or `toModel`/`toColumn` names it |
| `set-type` | Set the column's `dataType` to `to` |
| `add-relationship` | Append `relationship` (with its `cardinality`) to `logical.relationships` in the domain JSON, then set `isForeignKey: true` on the `fromColumn` in the from-model's yml if it is not already |
| `remove-relationship` | Remove the matching entry from `logical.relationships`. This is always a question first — see section 3 |
| `set-cardinality` | Set `cardinality` on the matching relationship in the domain JSON to `to` |
| `resolve-phantom` | Always a question: rename it in `logical.models` (and its relationships) to the real dbt model name, or remove it from this domain. **Never** delete its `logical-models/*.yml` — other domains may use it |

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
2. Apply or ask about the fixes, following section 3.
3. Run the diff again.
4. Repeat — **at most 3 rounds.** Each round should shrink the list; if it does not, something
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
| `update-cardinality-in-logical` | `set-cardinality` (write `targetCardinality`) |
| `add-to-logical` / `remove-from-logical` | ask first — adding or removing a whole model from the domain |

Apply the same rules from section 3 about who decides. Delete `.erd-studio/.sync-plan.json` when
you are done, then ask the user to click **⊕ Diff** again to confirm. Treat the canvas's result as the
check, up to the same 3 rounds.

## 7. Fallback B — manual comparison

Only when neither the helper nor the canvas is available. Tell the user plainly that this is
best-effort and less exact than ERD Studio's own check.

For each model: read its dbt schema yml (and the manifest's node, if `target/manifest.json`
exists), list its columns and `data_type:` values, and compare them with the logical yml by name,
ignoring case. Compare `relationships` tests between two models in the domain with
`logical.relationships`. Fix the logical side as in section 2, and recommend opening the canvas
and clicking **⊕ Diff** as soon as they can.
