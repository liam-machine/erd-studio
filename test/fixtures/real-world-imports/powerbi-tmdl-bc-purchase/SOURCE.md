# Power BI TMDL: Business Central Purchase app

## What it is

A real Power BI semantic model saved as TMDL: the **Purchase app** that
Microsoft ships with Dynamics 365 Business Central's out-of-the-box Power BI
reports. It is a purchasing model (Purchase Lines, Purchase Value Entries,
Purchase Invoice and Credit Lines, Purchase Budget facts; Vendor, Item,
Location, Project, Purchaser, Date and other dimensions) read from the
Business Central API, with several DAX date tables, 778 measures and 19
translation cultures.

Its Power Query is the reason it is here: `Type` appends three other tables
(`Table.Combine({Item, Resources, G/L Accounts})`, each through a step),
`Documents` appends four, and `Purchase Value Entries` merges the shared query
`Capacity Ledger Entries` (`Table.NestedJoin`). One table's file name is
escaped (`G%2FL Accounts.tmdl` holds `table 'G/L Accounts'`).

## Where it came from

- Repository: https://github.com/microsoft/BCApps
- Pinned commit: `616174f697c0387751fe71ce068b3653ee27adc8` (2026-11-06); the folder was last changed in `3896a32e10c592141a52f9bf2a142a539d784ec7` (2026-07-17, "power bi: fixing dimension range calculation and adding url caps (#9533)").
- Folder: https://github.com/microsoft/BCApps/tree/616174f697c0387751fe71ce068b3653ee27adc8/src/Apps/W1/PowerBIReports/Power%20BI%20Files/Purchase%20app/Purchase%20app.SemanticModel
- Downloaded 2026-11-09, file by file from raw.githubusercontent.com at the pinned commit.

## Licence

MIT, Copyright (c) Microsoft Corporation. MIT asks for the notice to be kept,
so it is copied as `UPSTREAM-LICENSE.txt`.

## What was copied

`Purchase app.SemanticModel/`: `.platform`, `definition.pbism`,
`diagramLayout.json` and `definition/` (`model.tmdl`, `database.tmdl`,
`expressions.tmdl`, `relationships.tmdl`, all 34 `tables/*.tmdl`, and
`cultures/fr-FR.tmdl`).

Left out, to keep the sample under 1 MB: the other 18 culture files
(`cultures/en-US.tmdl` alone is 1 MB of Q&A linguistic metadata), the
`.pbi/editorSettings.json` editor file, `Purchase app.pbip` and the
`Purchase app.Report/` folder. Nothing inside the copied files was changed.

A deliberately broken copy of part of this model, for the isolation tests,
is in `test/fixtures/semantic-model-broken-copy/` (not here).

## Expected counts

Counted from the TMDL files with a line reader (a `table` block per file, a
`column` line at one tab, `isKey`, `dataType`, and the `relationship` blocks
of `relationships.tmdl`), not with ERD Studio.

| Total | Count |
|---|---|
| Tables | 34 (5 calculated tables, no calculation group) |
| Columns | 511 (7 calculated) |
| Primary keys (`isKey`) | 8 |
| Relationships | 55 (all many-to-one TMDL defaults, none inactive, no filter settings) |
| Measures | 778 |
| Hierarchies | 11 |

Date-only and time-only columns (`UnderlyingDateTimeDataType`): 20.
