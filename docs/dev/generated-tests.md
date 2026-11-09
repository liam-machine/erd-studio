# Generated tests (property tests) for the importers

`test/unit/generated/` holds [fast-check](https://fast-check.dev) property
tests for the SQL DDL import (every dialect the picker offers), the Power BI
import (TMDL and TMSL) and Import DBML, and the DBML round trip. Instead of
hand-written inputs they generate schemas, write them in each format, then
break the text the ways real files are broken, and check the rules every
importer keeps on every input.

## The rules checked

| Rule | How it is checked |
|---|---|
| No throw | every importer call runs inside the property; a throw fails it with the input |
| Import or report | a failed import names at least one problem; a SQL import's tables found = imported + reported (the ledger's `table` entries); a Power BI table is imported or named in the ledger (by table or file); a DBML file that reads imports every table it defines |
| Nothing swallowed | every table the break did not touch is imported (by name when the names are plain), with all its columns (Power BI); SQL: every `CREATE TABLE` still in the file is counted in `tablesFound` |
| Located | every problem has its file and a line inside it (`lineCount` counts the empty line after a final line break, as an editor shows it); every `problem` ledger entry has a file and line, unless it is about a whole file |
| No long echo | no string the user can read (problem messages, notes, Not imported, the log lines, the draft) holds more than 100 characters of the source verbatim; table and column names are allowed (a long one is cut by the importer) |
| Linear time | sizes n and 8·n (tables; one statement's columns): the big run's time ≤ 4 × 8 × the small one's (`timeRatio`: alternating runs, the fastest of each, measured again up to 3 times when over the limit, so a busy machine does not fail it but a quadratic step does) |
| Converted DBML reads | the DBML a SQL or Power BI import converts to always reads back through Import DBML |

## What is generated

`schemaArbitraries.ts` draws a format-neutral schema: 1–5 tables, 1–5
columns each, primary keys of 0–2 columns, foreign keys to a whole key
(composite ones too, some one-to-one), unique columns, table and column
comments. Names are plain, reserved words (`order`, `user`, `table`…),
accented / CJK / Cyrillic / Greek, with spaces, mixed case, an embedded
quote, or huge (100–300 characters).

Writers (`sqlWriter.ts`, `semanticModelWriter.ts`, `dbmlWriter.ts`) write
it with the knobs that must not change the result: quoting, keyword case,
CRLF, a BOM, inline or `ALTER TABLE` / `Ref:` foreign keys, a schema
qualifier, comments between tokens and at line ends (holding `;`, `(` and
quotes), TMDL tabs or spaces, TMSL indent.

`breaks.ts` then applies one break inside one table: truncate the file, drop
a comma, a bracket or a quote, an unknown type, a reserved word as a bare
name, the table defined twice, a very long statement (up to 900 columns per
PR, 5,000 on the big run), another dialect's syntax, a stray line from
another tool (`\connect`, `GO`, merge-conflict markers, `/*`), a deleted
line, broken indentation.

## Running them

```bash
npx vitest run test/unit/generated            # the per-PR run: seeded, small (about 15–25 s)
FC_RUNS=2000 npx vitest run test/unit/generated            # the big run: 2,000 inputs per property (scaled per property)
FC_RUNS=2000 FC_SEED=random npx vitest run test/unit/generated   # another seed every run (printed on failure)
FC_SEED=42 npx vitest run test/unit/generated              # one other fixed seed
```

`FC_RUNS` also makes the size tests bigger and the long statements longer.
The per-PR run uses the fixed seed `20261109`, so it is the same inputs on
every machine.

## When a property fails

fast-check prints the shrunk counterexample (the smallest input it found)
and its seed and path. Reproduce it with the seed (`FC_SEED=<seed>
FC_RUNS=<n>`), fix the importer **generally** (the class of input, not the
one file), and keep the counterexample as a test in
`test/unit/generated/regressions.test.ts`, written out by hand, with a
comment naming the fix.

A property that fails only under load and passes alone (a size test) is
machine noise: say so in the PR rather than raising the limit.

## The DBML round trip

`dbmlRoundTrip.ts`: import → export → import, pure (no files written).
Import DBML's reader and planner into an empty project; the plan's tables and
relationships through core's `toDisplaySubjectArea`; exported with core's
`toDbmlRich` (the repo's DBML exporter); imported again. Run on generated
DBML, on the DBML the SQL and Power BI imports convert to (generated, and
each real-world sample), on every committed DBML file
(`test/fixtures/real-world-imports/dbml-qut-workbench`, `test/fixtures/dbml/`),
and on DBML other tools wrote (`test/fixtures/dbml-other-tools/`, with their
sources and licences in its README).

**Compared exactly** (`canonicalImport`): each table's name, schema and
unique indexes; each column's name, type, primary-key, NOT NULL and unique
flags, in order; each relationship as its column pairs from the foreign-key
end, its cardinality, and whether its pairs are one composite link.

**Differences allowed, and why:**

- **One-to-many** comes back as the equivalent many-to-one (the export
  writes every Ref from its foreign-key end); the comparison reads both from
  the foreign-key end.
- **The `unique` the export adds** to a one-to-one's foreign-key column (or
  the unique index over a composite one's) is not kept on import: the
  relationship already says it. A `unique` the source itself declared is kept
  (the export's `meta_json` carries it).
- **A composite link's label** (`compositeKey`) is made again on import;
  only its grouping is compared.
- **Not compared here**: notes and descriptions, defaults, checks, enums,
  index names and types, sticky notes, positions and the Project. ERD
  Studio's own fields and `meta` are compared field by field by
  `test/unit/dbmlRoundTrip.test.ts` (which also lists what DBML trims); what a
  foreign file's DBML-only settings become is kept under `meta.dbml` and
  travels in `meta_json`.

## Files

| File | What it is |
|---|---|
| `schemaArbitraries.ts` | the schema and name arbitraries, `FC_RUNS` / `FC_SEED` |
| `breaks.ts` | the breaks, spans and each format's kit |
| `invariants.ts` | the checks: echo, locations, ledger counts, `timeRatio` |
| `sqlWriter.ts`, `sqlRun.ts` | SQL in each dialect; the SQL import up to the draft |
| `semanticModelWriter.ts` | TMDL and TMSL |
| `dbmlWriter.ts`, `dbmlRoundTrip.ts` | DBML; the round trip |
| `*.property.test.ts` | the properties |
| `regressions.test.ts` | counterexamples the properties found, fixed |
