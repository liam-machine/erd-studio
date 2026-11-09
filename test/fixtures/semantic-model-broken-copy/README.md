# A deliberately broken copy of a real TMDL model

A copy of `test/fixtures/real-world-imports/powerbi-tmdl-bc-purchase/` (Microsoft
Business Central's Purchase app semantic model, MIT, see `UPSTREAM-LICENSE.txt`):
its `model.tmdl`, `database.tmdl`, `expressions.tmdl`, `relationships.tmdl`,
`.platform` and the 28 table files under 30 KB (the big calendar and label tables
are left out, so relationships into them are skipped, and said so).

Broken on purpose, for `test/unit/semanticModelImport.robustness.test.ts` (one
bad file never fails the model; each loss is in the ledger with its file and line):

- `tables/Vendor.tmdl` line 82: `column 'Vendor Name` (no closing quote).
- `tables/Location.tmdl` line 13: a calculated column `'Location Label'` whose ```` ``` ```` block is never closed, so the two columns after it are not read either.
- `relationships.tmdl` line 5: `relationship '48bece02-…` (no closing quote).
- `tables/Item.tmdl`: 16 NUL bytes before line 81 (a damaged file): not text, so the whole file is left out.

Changed but valid: `tables/Purchaser.tmdl` (CRLF and a BOM) and
`tables/Reason Codes.tmdl` (four spaces instead of tabs).
