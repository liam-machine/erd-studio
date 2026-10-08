# SPEC — relationships without ambiguity (issue #133, branch feat/133-relationship-direction)

Repo: <repo>. Branch already has ec56fe3 + da3d1b4 (many-side storage,
role, drag orientation, rehome notification). This spec finishes the job. CLAUDE.md rules apply
(applyDomainEdit single WorkspaceEdit = one undo step; no `vscode` in core / CLI-bundled services;
read-only CLI; no unprompted writes; message protocol: types + validation + sender + handler;
BEM + theme vars in webview; settings via getErdStudioSetting; no API newer than VS Code 1.85).
Do NOT commit. Do NOT edit files outside your ownership list (tests you add for your files are fine).

Out of scope: composite foreign keys, DBML export (new features, later). Keep identities shaped so
composite keys can be added later without a format change.

## Confirmed defects this must fix
D1 dbtDraft.ts ~541 narrows a parent-declared dbt test (one-to-many) to many-to-one WITHOUT swapping
   ends → stored on the dimension; markDraftKeys (~485) flags the dimension PK as FK.
D2 displayDomain.ts:61-78 marks every relationship fromColumn as isForeignKey → a wrong relationship
   disables drag orientation (self-reinforcing).
D3 graphTransformer.ts:~283 filters edges by exact model name → a case-only mismatch is read but never drawn.
D4 logicalModelService.ts:~769 re-emits the whole `relationships:` list on ANY model save when it
   differs from the parsed list → unreadable entries deleted, unknown keys dropped, `one_to_many`
   typo rewritten as many-to-one. (predates #133)
D5 mergeLibraryRelationships (domain.ts ~436) keeps the first duplicate in logical.models order →
   two diagrams can draw one link differently, no warning.
D6 removal/update/edit match exact ends only (SemanticEditorProvider ~3101, ~3469-3482, ~3108;
   libraryRelationships.ts removeLibraryRelationships) → reversed copies resurrect, "already exists".
D7 ~20 exact-end comparisons across: SemanticEditorProvider (≈2683, 2780, 3214, 3269, 3478, 3517,
   3564, 3584, 3927), duplicateModelResolver.ts ~113, syncPlanBuilder.ts ~164, domainService.ts ~677,
   libraryRelationships.ts ~182, NewFkDialog.tsx ~81, dbtDraft testKey, Add Existing Model dedupe.
D8 per-domain/v4 projects: no canonical identity; empty-library early return `[...own]` no dedupe.
D9 physical stage: tests declared on both ends draw two lines (derivePhysicalRelationships no
   either-way dedupe); DiscrepancyService source loop doesn't skip visited links → duplicate rows.
D10 CLI diff `set-cardinality` to one-to-many not canonicalised (diff.ts ~286-292).
D11 notification (case-insensitive lookup) vs command (getModel, case-sensitive on Linux) disagree.
D12 move command silently drops a one-side copy whose cardinality/role differs (additions loop `continue`).

## R1 — One identity (core)
packages/core/src/relationships.ts exports:
- `type RelationshipEnds = Pick<Relationship,'fromModel'|'fromColumn'|'toModel'|'toColumn'>`
- `linkKey(ends): string` — UNORDERED pair of lowercased `model.column` ends, sorted, joined `\u0000`.
- `sameLink(a, b): boolean`.
- keep `canonicalRelationship`, `normaliseRelationshipRole`, `RELATIONSHIP_ROLE_MAX_LENGTH`.
Every comparison listed in D7 uses `linkKey`/`sameLink` (or the stored-ends lookup below).
`relationshipKey` (directional) stays exported for back-compat but nothing in src/webview/renderer
uses it for "is this the same link" any more. Add an architecture test
(test/unit/relationshipIdentity.arch.test.ts) that scans src/, webview/, packages/*/src for
`.fromModel ===` / `.toModel ===` / `fromModel === ` patterns outside an allowlist and fails.

## R2 — One stored form (home computed from the record alone)
- many-to-one → home = fromModel. one-to-many → swap ends, many-to-one, home = other model.
- one-to-one → kept as stored: direction means "fromModel holds the FK". many-to-many → kept as stored.
- Self-reference: same file; one-to-many swaps columns.
- Home NEVER depends on PK/NK/FK flags. Key evidence only drives creation (R7) and check REL006.

## R3 — Mode-aware; mode never changes as a side effect
Mode = `usesLibraryRelationships(models, domainFileRelationshipCount)` evaluated BEFORE an edit.
library mode: home = the home model's yml. per-domain mode (and v4 domains): home = the current
domain file's logical.relationships (canonical direction there too). A commit never moves a
relationship between modes (only the explicit move/repair command does).

## R4 — One write path
Pure (vscode-free) `planRelationshipCommit` in src/services/libraryRelationships.ts:
input `{ mode, op, endpointModels: SemanticModel[] (copies of the ≤2 endpoint models, already read),
domainRelationships: Relationship[] (current domain file), }`; op is one of
`{kind:'add', rel, markKey?}` `{kind:'update', stored: RelationshipEnds, cardinality}` (⇄ / context
menu; keeps role) `{kind:'edit', stored, next}` (dialog; role from next, '' clears)
`{kind:'remove', stored: RelationshipEnds[]}`. It removes EVERY copy of the link (linkKey) from the
two endpoint models' `relationships` and from the current domain section, then (add/update/edit)
writes ONE canonical record at its home per mode. Duplicate refusal: adding/rekeying onto a link that
exists elsewhere (other than the one being edited) → error "This relationship already exists."
Returns `{ changedModels, domainRelationships, otherDomainCopies?: string[] }`.
Host (`SemanticEditorProvider`) uses ONLY this for addRelationship / updateRelationship /
editRelationship / removeRelationship / removeRelationships, through applyDomainEdit's single
WorkspaceEdit (one undo step). It reads at most the two endpoint models (+ the domain doc).
Refuse with EditAborted (clear message naming the file) when an endpoint yml is open with unsaved
edits, or an endpoint model file is unreadable. After a remove, if other domain files still hold
their own copy, post a non-blocking info naming them ("still drawn in sales.json from its own copy —
Repair Relationships… removes it").
`markKey` (optional `{ model, column }` on addRelationship/editRelationship payloads, validated) sets
isPrimaryKey on that column in the same commit (same undo step).

## R5 — One read path
Pure core `normaliseRelationships({ models, own, filePath? })` → `{ relationships, diagnostics }`,
used by `mergeLibraryRelationships` (keep it as a thin wrapper for API compat), the v4 path and the
empty-library early return, so canvas, CLI, MCP and viewer interpret any files identically:
- canonicalise every record in memory (R2);
- fix endpoint spelling to the real model name (case-insensitive among the domain's models) and the
  real column name when the model has that column (D3);
- group by linkKey; deterministic winner independent of model order: library over domain;
  within library: record whose file is its canonical home > lowest lowercased home-model name >
  lowest index; within domain: lowest index. One-to-one A→B vs B→A count as DIFFERENT for the
  "identical" test (conflict);
- every drawn relationship carries provenance: `source: { kind:'library', model, index } |
  { kind:'domain', index }` and `stored: RelationshipEnds` (the record's ends exactly as on disk).
  Add both as OPTIONAL fields on `Relationship`/`DisplayRelationship` (runtime-only, never written);
- diagnostics (`{ code, severity, message, link, sources[] }`) for duplicates (REL001), stored
  one-to-many (REL002), case-only matches (REL005); never drops a record silently.
Writers locate records via `stored` + `source` (+ linkKey fallback). The webview sends `stored` ends
as the "original key" for update/edit/remove.
Core `readRelationships` (logicalModel.ts) additionally returns per-entry issues for entries it
skipped or defaulted (missing endpoint, unknown cardinality like `one_to_many`, non-string role, a
stray `fromModel:` key): add optional runtime-only `relationshipIssues?: { index, reason }[]` on
SemanticModel. Unknown cardinality still draws as many-to-one (as domain files do) but is REL008.
Physical stage: `derivePhysicalRelationships` dedupes either-way tests by linkKey (D9).
DiscrepancyService: skip already-visited links in the source loop too (D9).
Display: DisplayColumn gains optional `isForeignKeyDeclared?: boolean` (true only when the yml says
isForeignKey); `isForeignKey` (badge) unchanged. Orientation/resolver use the declared flag (D2).
DisplayDomain (editable logical payload only) gains optional `relationshipHome?: 'library'|'domain'`
and `relationshipIssues?: { code, severity, message, link? }[]`; DisplayRelationship gains optional
`issues?: string[]` (codes) for edge badges. Goldens change → regenerate intentionally
(UPDATE_GOLDEN=1), core + renderer → 0.2.0 (renderer pins core exactly; root package.json pins both).

## R6 — Saving never destroys what it did not understand (D4)
LogicalModelService syncs `relationships:` ENTRY BY ENTRY (like syncColumns): match existing
sequence items to desired entries by linkKey (from = the file's model) and occurrence index;
update changed fields in place (keeps comments/unknown keys/style); delete only READABLE entries
that are absent from the desired list; NEVER delete an entry the reader could not read; append new
entries; keep a bad cardinality exactly as written unless that entry itself is the edit target.
An edit that targets an unreadable entry is refused with a message naming file + entry.

## R7 — Direction from evidence, never a silent guess
Pure core `resolveDirection(a: EndEvidence, b: EndEvidence) → { from, to, cardinality,
confidence: 'certain'|'likely'|'ambiguous', conflict?: boolean, reasons: string[] }`.
EndEvidence = `{ model, column, isPrimaryKey, isNaturalKey, isForeignKeyDeclared,
pkColumnCount, nkColumnCount, dbt?: { unique?: boolean; inCompositeUnique?: boolean;
relationshipsTest?: boolean } }`.
- "unique" end: its column is the model's WHOLE PK or WHOLE NK (count 1) and not declared FK; or
  dbt unique (dbt → at most "likely").
- "not unique" end: part of a composite key; declared FK; dbt relationships test on it; dbt not unique.
- certain: keys alone settle it (one end unique, the other not unique) → from = not-unique end,
  many-to-one. Both whole keys + exactly one declared FK → certain one-to-one, from = the FK end.
- likely: only dbt evidence, or one end known and the other unknown.
- ambiguous: no evidence, both unique without FK evidence, both non-unique (M:N or unkeyed), or any
  conflict between keys and dbt (conflict=true). Never break ties by drag order; deterministic.
Move `isReferencedKey`/`orientDraggedRelationship` logic onto `resolveDirection` (webview keeps a
thin wrapper). Host attaches dbt evidence per column to the editable logical payload
(DisplayColumn optional `dbtEvidence?: { unique?: boolean; inCompositeUnique?: boolean;
relationshipsTest?: boolean }`) from ymlData/manifest when available.
Dialog (NewFkDialog) behaviour:
- sentence form: "Each <from> points to one <to>" + "How many <from> rows can share one <to>?
  ◉ Many (usual) ○ Only one ○ Many on both sides (use a bridge model)"; read-back
  "A <to> has many <from>. Saved in <home>.yml" (or "in this diagram" per mode) + "Why here?"
  tooltip "Relationships live with the model holding the foreign key, so adding a fact never edits
  its dimensions.";
- certain: prefilled, Create enabled (no extra click). A turned-round drag shows a quiet
  "Turned round: <reason> [Swap back]".
- likely: prefilled + reason line.
- ambiguous: no default direction; two buttons named after the models ("<A> has many rows per
  <B>" / reverse); Create disabled until chosen; optional tick "Mark <col> as <model>'s key"
  (→ markKey).
- contradiction (user choice vs certain evidence): amber warning
  "<model>.<col> is <model>'s primary key, so <model> is normally the 'one' side." + [Swap sides];
  primary button reads "Create anyway". Soft only.
- Many-to-many offered with the bridge hint.
ContextMenu: remove "One → Many" from the cardinality options (⇄ covers it); swap on one-to-one /
many-to-many sends editRelationship with swapped ends (role kept). Edit/update/remove send `stored`
ends. FkEdge: amber "?" badge on edges whose `issues` include REL001/REL002/REL006 (not readOnly,
not viewer), tooltip lists them; ⇄ tooltip says what it does ("Make <model> the many side").
DetailPanel row tooltip "Stored in <file>". Canvas banner (logical, editable) when
`relationshipIssues` has REL003/REL004/REL008: "N relationships need attention — Repair
Relationships…" (posts a new `repairRelationships` message → host runs the command; add to
messages.ts both directions + validation; NOT on the physical allowlist).

## R8 — Checks with stable codes (pure core `checkRelationships`)
Input: all library models (incl. relationshipIssues), all domains `{ label, filePath, models,
relationships, mode }`, unreadable model files. Output findings
`{ code, severity:'error'|'warning'|'info', message, files: string[], line?, link?, fix? }`:
REL001 same link stored more than once (error if canonical cardinality/role/1:1 direction differ,
else warning; per-domain copies of the same link in DIFFERENT domain files are NOT REL001 in a
per-domain project — only within one domain or across library files); REL002 one-to-many in a
model yml (warning); REL003 endpoint model missing from the library (error; not when the model's
file is unreadable or the model is a domain stub); REL004 endpoint column missing (error; not for
unreadable/stub models); REL005 case-only name match (warning); REL006 stored direction
contradicts CERTAIN key evidence (info, never fails CI); REL008 entry skipped/defaulted on read
(error, with line); REL009 domain-file copy of a link the library also holds, in a library project
(info). The viewer (core can't list dirs) only reports what it loaded.

## R9 — Surfaces
CLI (read-only): new `erd-studio check [--strict] [--json]` → exit 0 no errors, 1 errors (or
warnings with --strict), 2 usage, 3 environment, 4 internal; JSON `{ cliVersion, findings, counts }`,
project-relative paths. `doctor`: adds a relationships section (counts + `fix-relationships` next
step), stays exit 0. `diff`: adds advisory `integrity` findings for the domain(s); exit codes
unchanged. CLI `set-cardinality` canonicalised (D10). Help text + tests (test/unit/cli.*).
MCP server read_domain unaffected beyond types (keep compiling).

## R10 — One repair path, consent-based
New command `erdStudio.repairRelationships` "Repair Relationships…" (category ERD Studio; add to
`NO_LEGACY_ALIAS` and the test mirror; contribute in package.json incl. Model Library `…` menu);
"Move Relationships to Model Library" keeps its id/title and runs the same engine with the
domain→library move enabled. Engine (vscode-free planner + vscode runner, disk-only like the move,
refuses dirty files, all-or-nothing with rollback):
- automatic set (shown in the preview, applied on confirm): REL002 re-home, REL005 spelling fix,
  REL001 identical duplicates (keep the canonical-home entry);
- one QuickPick per conflict (REL001 differing cardinality/role/1:1 direction; REL003/REL004:
  repoint/remove/leave; REL006: swap/leave), each with "Leave as is"; Esc cancels everything;
- preview = modal detail listing every file and change (plus "Show full diff" opening a read-only
  diff of one file when practical);
- after writing, re-parse every written file and ROLL BACK unless everything outside
  `relationships:` is byte-identical and the planned findings are gone; idempotent (second run =
  nothing to do); never touches REL008 entries (opens the file at the line instead);
- D11: notification and command use the same model lookup; D12: a differing copy is a conflict,
  never silently dropped. Notification (`maybeOfferRehome` → offer Repair) when REL001/REL002/
  REL003/REL004/REL008 exist; keep the separate don't-ask key; reuse `relMove*` telemetry features
  (no telemetry contract change).

## R11 — Every writer uses the same core
Draw from dbt / Add models from dbt (`relationshipsForAddedModels`: canonicalise BEFORE narrowing;
only narrow many-to-many; `markDraftKeys` must not flag a PK as FK; dedupe by linkKey (D1));
Add Existing Model dedupe by linkKey; duplicateModelResolver repoint uses linkKey/stored;
syncPlanBuilder & DiscrepancyService & domainService physical use linkKey; CLI fixes canonical;
harness v26 text (do NOT bump; branch already moved 25→26): direction rule, never one-to-many,
"after editing relationships run `erd-studio check` (if the CLI says unknown command, run
`erd-studio doctor`)"; setup skill references updated likewise.

## R12 — Proof
- Property tests (seeded generator, no new dependency): random models with case variants,
  self-refs, same-named columns, random directions, duplicates across files/domains, typos →
  normalise idempotent & meaning-preserving; shuffling model/file order never changes what is drawn;
  drawn links unique by linkKey; after any planRelationshipCommit, R2/R3 hold for the link and
  every other record/byte is unchanged; repair twice == once and never changes what any diagram
  draws (except where the user picked); read→write→read round-trips; YAML per-entry sync keeps
  comments/unknown keys/unreadable entries.
- Table-driven resolveDirection tests: Kimball, fact keyed by dims, DV hub/link/satellite (composite
  sat key), 3NF, shared-PK 1:1, M:N, self-ref, unkeyed, keys-vs-dbt conflict, declared-FK 1:1.
- Undo test: a yml-only commit is undone by the canvas undo (not the previous domain edit).
- Docs: CHANGELOG `## Unreleased` (user-facing), CLAUDE.md, docs/semantic-domain-json-reference.md.

## File ownership (parallel phase)
- CORE agent: packages/core/** (+ packages/core/test/**), packages/core/package.json version.
- HOST agent: src/providers/SemanticEditorProvider.ts, src/providers/payloadValidation.ts,
  src/types/messages.ts, src/services/logicalModelService.ts, src/services/libraryRelationships.ts,
  src/services/stageDisplay.ts, test/unit/semanticEditorProvider*.test.ts,
  test/unit/libraryRelationships.test.ts, test/unit/logicalModelService*.test.ts,
  test/unit/payloadValidation*.test.ts.
- WRITERS agent: src/services/dbtDraft.ts, src/commands/drawFromDbt.ts, src/services/domainService.ts,
  src/services/discrepancyService.ts, src/services/syncPlanBuilder.ts,
  src/services/duplicateModelResolver.ts, mcp-server/**, their tests.
- CLI+DOCS agent: src/cli/**, src/services/harnessService.ts, src/harness/**, docs/**, CLAUDE.md,
  CHANGELOG.md, README.md, schemas/**, test/unit/cli*.test.ts, test/unit/harness*.test.ts,
  test/fixtures/dbt-project/.claude/** (regenerate if harness text changes).
- REPAIR agent: src/commands/moveRelationshipsToLibrary.ts, src/commands/repairRelationships.ts (new),
  src/services/relationshipRepair.ts (new, vscode-free), src/extension.ts, package.json
  (contributes + root deps pins), packages/renderer/package.json version + core pin,
  test/unit/moveRelationshipsToLibrary.test.ts, test/unit/repairRelationships*.test.ts,
  test/unit/extension.activate.test.ts.
- UI agent: webview/**, packages/renderer/src/** (+ packages/renderer/test/**), test/unit for
  webview/renderer files.
