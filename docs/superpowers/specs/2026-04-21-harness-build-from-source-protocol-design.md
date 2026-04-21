# Harness "Build From Source" Validation Protocol — Design

**Date:** 2026-04-21
**Scope:** `src/services/harnessService.ts` (`SCHEMA_CONTENT` + `HARNESS_VERSION`)
**Status:** Draft — awaiting review

## Problem

A teammate asked an AI agent (via the currently-shipped `erd-studio` harness skill) to build a logical model from an existing planning model. The agent produced a YAML with only about half of the source columns — silently. No warning, no reconciliation, no flag.

The shipped skill is a strong **format reference** (YAML shape, JSON shape, naming conventions, stage semantics), but it has no **workflow guidance** for the "build a model from a source" task. The single failure the teammate hit — silent column truncation — is entirely uncovered.

## Goal

Catch silent column truncation in AI-generated model YAMLs, without hard-gating the agent's workflow. Make the failure mode **detectable in the conversation transcript** so the user can see it before accepting the work.

## Non-goals

- Hook-based enforcement (Claude-only, deferred as Option C in brainstorming)
- Mandatory user-confirmation gates (rejected — user chose trust-but-verify)
- Handling the `.sync-plan.json` path (already covered by SYNC.md)
- Schema changes to domain JSON or logical YAML
- Preventing wide tables or recommending decomposition

## Design

### Location

Single change site: `src/services/harnessService.ts`.

- Insert a new `## Building Models from External Sources` section into the `SCHEMA_CONTENT` string, between the existing `## Models` block and `## Columns` block.
- Bump `HARNESS_VERSION` from `'13'` to `'14'`.

All four harnesses (Claude Code, Copilot, Gemini, Codex) pick up the new content automatically because `SCHEMA_CONTENT` feeds all four generators (`generateClaudeSkill`, `generateCopilotInstructions`, `generateGeminiStyleguide`, `generateCodexAgents`).

Existing users on version 13 will be detected as stale by `detectStale()` on extension activation and offered the existing "Update All / Choose… / Dismiss" prompt. No new plumbing required.

### Protocol text

````markdown
## Building Models from External Sources

When the user asks you to create a new model — or materially add columns to an existing one — from an external source (planning doc, DDL, staging SQL, CSV, notebook, or another YAML), follow this protocol. It exists to prevent silent column truncation.

**Does NOT apply to:** renaming a column, changing a single flag, or executing an `erd-studio/.sync-plan.json` (see SYNC.md for that workflow).

### Step 1 — Read the source fully, then enumerate
Before listing anything, confirm you have read the source **in full**. For files longer than 2000 lines, page through with `Read` using `offset`/`limit` until you reach the end of the file. A partial read is a silent-truncation trap before you even start — the columns you never saw cannot appear in your output.

Then list every source column in order, with a total count. Do not summarise or elide:

> Source `models/staging/stg_customer.sql` has **47 columns**:
> 1. customer_id
> 2. email
> …

For wide tables (50+ columns), group the list in numbered chunks of 50 so you and the user can verify nothing was dropped mid-list. Tables over 100 columns are common in EDW staging — the chunking exists for exactly this case.

If you cannot identify a source, stop and ask which source to build from before listing.

### Step 2 — State scope
State which of those columns you intend to build, in plain English.

> Proposed scope: **all 47 columns**.
> — or —
> Proposed scope: **23 of 47 columns** (PK, NKs, and measures; excluding audit columns and deprecated fields).

Proceed straight to step 3 — do not wait for confirmation. The user will correct you if the scope is wrong.

### Step 3 — Build
Write the `erd-studio/logical-models/{name}.yml` file.

### Step 4 — Reconcile via set-difference
Re-read the YAML file you just wrote. Compute the set-difference between source columns and YAML columns — do not rely on a total count alone, because counts can coincidentally match while columns still differ.

Report in this exact form:

> Reconcile: `dim_customer.yml` has **M** columns; source has **N**.
>
> **In source but not in YAML** (K): `created_at` (audit — not modelled), `updated_at` (audit), `_dbt_source_relation` (dbt internal).
>
> **In YAML but not in source** (J): `customer_sk` (synthesised surrogate key), `loaded_at` (added for SCD2 tracking).

Every entry in "in source but not in YAML" must have a specific reason. A class-level reason already declared in Step 2 (e.g. "excluding audit columns") is sufficient — you don't need to restate it per column. But an unexplained entry, or a vague reason like "not needed", means **stop and tell the user** that a column may have been dropped unintentionally. Do not claim the task is complete.

**Rule of thumb:** if your reconcile message doesn't name specific columns on both sides, you skipped a step.
````

### Version bump

`src/services/harnessService.ts:22`:

```ts
export const HARNESS_VERSION = '14';
```

## Scale considerations (100+ column sources)

Two design choices in the protocol are driven explicitly by the reality that EDW staging tables frequently carry 100–300 columns:

1. **Chunked enumeration (Step 1).** Flat lists of 150 items are hard for both agent and reader to spot-check. Numbered chunks of 50 give the reader a natural scan rhythm and the agent a natural pagination rhythm, without losing the full enumeration.
2. **Set-difference reconciliation (Step 4) instead of count + omissions.** With wide tables, a count-based claim ("added 147 of 152") is fakeable: the agent can pattern-match to a plausible number without having actually cross-checked. A set-difference forces the agent to *name the delta* — which is compact even at 300 columns (usually a handful of entries each side) and can't be hallucinated without doing the comparison.

Partial-`Read` truncation at the source step is also called out explicitly, because with a 3000-line DDL the agent's default 2000-line `Read` silently cuts off before the end of the source — a truncation that happens before Step 1's list is even written.

## Propagation and rollout

- `SCHEMA_CONTENT` is shared → all four harness targets get the protocol on next install or update.
- `HARNESS_VERSION` bump + existing `detectStale()` flow on activation → existing workspaces get prompted to update.
- No migration needed; the protocol is additive text, not a schema change.

## Testing

No unit tests — this change is content. Manual verification:

1. `npm run build`
2. Launch the Extension Development Host against the fixtures project:
   ```
   code --extensionDevelopmentPath=/Users/liamwynne/GIT/LIAM/erd-studio /Users/liamwynne/GIT/LIAM/erd-studio/test/fixtures/dbt-project
   ```
3. Run the `Install AI Coding Harness` command → choose Claude Code.
4. Confirm generated `.claude/skills/erd-studio/SKILL.md`:
   - Contains the `## Building Models from External Sources` section
   - Has trailing marker `<!-- erd-studio-harness: 14 -->`
5. In a workspace with an existing version-13 install, reload the extension and confirm the stale-update notification fires.
6. Repeat (3)–(4) for Copilot, Gemini, and Codex targets to confirm propagation.

## Alternatives considered

| Option | Why not (for this change) |
|--------|--------------------------|
| **B. TodoWrite-per-column** (from brainstorming) | Claude-only; theatre at 100+ columns; trains agents to batch-complete todos, defeating the point. |
| **C. PostToolUse hook nagging after YAML write** | Claude-only; reasonable future add-on if protocol alone proves insufficient, but doesn't help Copilot/Cursor/Gemini users who hit this failure today. |
| **Gate-style Step 2** (wait for user confirmation) | Rejected in brainstorming in favour of trust-but-verify; adds a round-trip on the common case where the user obviously wants all columns. |
| **Count-based reconciliation** ("added N of M") | Fakeable on wide tables; doesn't surface spurious additions; doesn't scale as cleanly as set-difference. |

## Implementation checklist

- [ ] Edit `SCHEMA_CONTENT` in `src/services/harnessService.ts` to insert the `## Building Models from External Sources` section between `## Models` and `## Columns`.
- [ ] Bump `HARNESS_VERSION` from `'13'` to `'14'`.
- [ ] `npm run build` and run manual verification steps above.
- [ ] Confirm stale-update prompt triggers on an existing v13 workspace.
- [ ] No `package.json` version bump needed — harness version is independent of extension version per `CLAUDE.md` policy.
