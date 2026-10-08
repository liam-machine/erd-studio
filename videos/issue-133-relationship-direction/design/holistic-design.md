# Relationships without ambiguity — combined design (draft for adversarial review)

Branch: `feat/133-relationship-direction` (ec56fe3, da3d1b4). Synthesised from five councils:
invariants, evidence/inference, UX, fail-safes, red team.

## Principles (each one a rule nothing can bypass)

**P1 — One identity.** A link is the unordered pair of its two ends `(model, column)`, compared
case-insensitively. One exported core function `linkKey()` (packages/core) replaces every local
copy: `mergeLibraryRelationships`, DiscrepancyService, `sameColumnPair`, the dialog's duplicate
check, `removeLibraryRelationships`, domain-file add/edit/remove, `derivePhysicalRelationships`,
dbt draft `testKey`, Add Existing Model. An architecture test fails if a second "same ends" helper
appears. Shaped `(model, sorted column list)` so composite FKs fit later without a format change.

**P2 — One stored form, home computed from the record alone (pure, no key lookup).**
- `many-to-one` → home = `fromModel`. `one-to-many` → swap ends, home = the other model.
- `one-to-one` → kept as stored: its direction *means* "fromModel holds the FK" (it decides
  where a dbt `relationships` test belongs). Chosen explicitly at creation (P6), never by drag order.
- `many-to-many` → kept as stored; the dialog steers to a bridge model (P6).
- Self-reference: same file; a one-to-many self-reference swaps columns in place.
- Home never depends on PK/NK/FK flags, so marking a key later never makes stored data "wrong".
  Key evidence only drives creation (P6) and an info-level check (P7).

**P3 — At most one record per link, project-wide.**
- Write side: every relationship write goes through ONE pure core function
  `commitRelationship(files, op)` (add / edit / swap / remove / rename-endpoint): it removes
  *every* copy of the link (either direction, every library yml, the domain file) and writes one
  canonical record in its home. Fixes: deleted links resurrecting, "already exists" on edit,
  duplicates from swaps.
- Read side: duplicates (merges, old versions, AI) are tolerated with a deterministic winner
  independent of model order: entry in its canonical home > library over domain file > lowest
  home-model name > first in file. Always reported (P7 REL001). Replaces today's
  first-in-`logical.models`-order winner (domain.ts ~436), which lets two diagrams draw one link
  differently.

**P4 — Normalise on read, everywhere.** One core `normaliseRelationships(records + provenance)
→ { drawn, diagnostics }` called by `parseStageData` (and the v4 path, and the empty-library early
return), so canvas, CLI, MCP and viewer interpret any file identically. It canonicalises in memory,
dedupes by P3, rewrites endpoint spelling to the model's/column's real name (fixes lines silently
not drawn when `toModel` differs only in case — graphTransformer matches exactly), and keeps
dangling/invalid records as diagnostics instead of dropping them. The physical stage dedupes
either-way tests the same way.

**P5 — Saving never destroys what it did not understand.**
- `relationships:` lists are synced per entry like `columns:` (match by link identity; unknown
  per-entry keys and comments kept), never re-emitted wholesale (logicalModelService ~769).
- A list containing an entry the reader skipped or defaulted (missing endpoint, `one_to_many`
  typo, non-string role) is left byte-for-byte; relationship edits to that file are refused with
  a message naming the file and line (EditAborted). Never silently rewrites a typo as many-to-one.
- Readers warn on unknown cardinality / a stray `fromModel:` key in a model yml.

**P6 — Direction at creation from evidence, never a silent guess.**
Pure core `resolveDirection(endA, endB, evidence) → { from, to, cardinality, confidence:
'certain'|'likely'|'ambiguous', conflict?, reasons[] }`. Evidence per end: "unique" if it is a
whole PK/NK, a dbt `unique` / `unique_combination_of_columns`, or a contract primary key;
"not unique" if it is a proper subset of a composite key, carries the dbt `relationships` test,
or a contract foreign_key. FK flags are WEAK and FK flags *derived from existing relationships*
(displayDomain marks every `fromColumn` as FK — self-reinforcing) are excluded: the webview gets
the stored flag separately (`isForeignKeyStored`) or the resolver runs on the host. Naming /
modelRole are hints only. Never breaks a tie by drag order; conflicting sources ⇒ ambiguous.
- certain → applied (drag turned round, dialog pre-filled).
- likely → pre-filled + reason shown; Save confirms.
- ambiguous → no default: dialog asks in plain words ("Which side has many rows per value?",
  or for two whole keys "Which model depends on the other?") with buttons named after the models;
  Create disabled until answered; optional tick "mark <col> as <model>'s key" (same edit, one undo).
- contradiction (user choice vs certain evidence) → amber warning + **Swap sides**; button reads
  "Create anyway". Soft, never a hard block.
- Dialog: sentence form ("Each fct_order has one dim_customer · a dim_customer has many
  fct_order"), read-back "Saved in logical-models/fct_order.yml" + "Why here?", Many-to-Many
  option with "use a bridge model" hint. Context-menu "One → Many" removed (⇄ covers it); ⇄ on
  1:1 / M:N swaps the ends (rekey, role kept) so their home can be changed.

**P7 — Checks with stable codes, one module, every surface.** Pure core `relationshipChecks`:
| Code | Finding | Severity |
|---|---|---|
| REL001 | same link stored more than once | error if cardinality/role differ, else warning |
| REL002 | `one-to-many` stored in a model yml | warning |
| REL003 / REL004 | endpoint model / column missing (not for unreadable or stub models) | error |
| REL005 | endpoint matches only case-insensitively | warning |
| REL006 | stored direction contradicts certain evidence (whole key → non-key) | info, never fails CI |
| REL007 | composite FK incomplete / inconsistent | warning |
| REL008 | entry skipped or defaulted on read (typo, missing field) | error |
| REL009 | domain-file copy of a library link | info |
Surfaces: new read-only `erd-studio check [--strict] [--json]` (exit 0 clean, 1 findings,
3 env, 4 internal) usable as a CI gate; `doctor` reports counts + a next step (stays exit 0);
`diff` gains an advisory section (exit codes unchanged); canvas: "?" badge on REL001/REL006 edges,
banner counting REL003/004 links that draw nothing. (Problems-panel diagnostics: later.)

**P8 — One repair path, consent-based.** "Move Relationships to Model Library" becomes
**Repair Relationships…** (old id kept as alias): REL002 / REL005 / identical REL001 fixed in the
preview set; every conflict a QuickPick with "Leave as is"; read-only preview diff; refuses dirty
files; all-or-nothing with rollback; after writing, re-parses every file and rolls back unless
everything outside `relationships:` is unchanged; idempotent. A REL006 fix is offered only as
"swap ends / fix cardinality", never automatic. The once-a-session notification offers it when
REL001/002/003/008 exist (separate don't-ask keys; separate telemetry keys, Worker deployed first).

**P9 — Every writer uses the same core.** Canvas, Draw from dbt / Add models from dbt (fixes:
parent-declared dbt tests were narrowed to many-to-one without swapping ends and stored on the
dimension; markDraftKeys flagged the dimension PK as FK), Add Existing Model, repair, CLI fixes
(`set-cardinality` to one-to-many canonicalised), MCP. Harness v27: "after editing relationships
run `erd-studio check`"; schema text matches P2/P5. Notification ↔ command use the same model
lookup (no Linux case mismatch).

**P10 — Mixed versions & rollback.** Format stays readable by 1.6.7 (rollback = republish).
Old versions can still write REL002 / drop roles / create REL001; check + notification + repair
catch and fix them. Optional `check --base <ref>` to detect dropped roles in CI.

**P11 — Proof.** Property-based tests (seeded generator: random models, case variants,
self-refs, same-named columns, random directions, duplicates across files): canonicalisation
idempotent and meaning-preserving; shuffling model/file order never changes what is drawn;
every drawn link unique; after any commit, P2/P3 hold and every other byte is identical;
repair twice == once and never changes what diagrams draw; read→write→read round-trips.
Table-driven resolver tests (Kimball, DV hub/link/sat, fact keyed by dims, 3NF, shared-PK 1:1,
M:N, self-ref, unkeyed, keys-vs-dbt conflict). The real-extension functional suite extended.

## Proposed split
- Ship in this PR (correctness; no silent errors): P1, P2, P3, P4, P5, P9 bug fixes, P6
  (resolver + dialog), P7 core + `erd-studio check` + doctor/diff hooks, P8 repair, P11.
- Follow-up: Problems-panel diagnostics, canvas badges/banner, composite FKs, DBML export,
  `check --base`.
