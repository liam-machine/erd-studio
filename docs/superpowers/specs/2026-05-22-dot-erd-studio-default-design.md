# Design: `.erd-studio` as the default data directory

**Date:** 2026-05-22
**Status:** Approved — ready for implementation planning

## Problem

ERD Studio stores its data (domain JSON, logical-model YAML, layer config,
templates) in a project subdirectory named `erd-studio/`. The directory name is
configurable via the `dbtSemantic.semanticDir` setting (default `erd-studio`).

The new default should be `.erd-studio` — a dot-prefixed name so the folder
sorts to the top of the file explorer, alongside other dot-directories
(`.vscode`, `.github`, `.claude`).

**Hard constraint:** existing projects that already use `erd-studio/` must keep
working with zero disruption. Simply changing the setting's `default` value
would break them — a VS Code setting `default` applies to every user who never
set the value explicitly, so existing `erd-studio/` projects would instantly
point the extension at a directory that does not exist.

## Goals

- New projects (and `setupSemanticDirectory`) create and use `.erd-studio/`.
- Existing `erd-studio/` projects continue working untouched, no migration.
- An explicit `dbtSemantic.semanticDir` setting always wins over auto-detection.
- AI coding harness files reference the project's actual data directory.

## Non-goals

- No forced rename of existing `erd-studio/` directories.
- No migration prompt offering to rename `erd-studio/` → `.erd-studio/`
  (a possible future opt-in, out of scope here).
- If a project somehow contains both directories, `.erd-studio/` wins and a
  console warning is logged. No UI surfaced for this edge case.

## Approaches considered

- **A — Auto-detection (chosen).** Resolve the directory name at activation
  from explicit setting → existing directory on disk → new default.
- **B — Flip the `package.json` default only.** Rejected: breaks every
  existing `erd-studio/` user who never set the setting explicitly.
- **C — Auto-detect plus an active migration prompt** to rename the legacy
  directory. Rejected: more scope, and the constraint is to not disrupt
  existing users. Could be a later opt-in feature.

## Design

### 1. Central resolver — `src/services/semanticDirResolver.ts` (new)

A single pure-ish function, unit-tested, that determines the data directory
name for a workspace:

```ts
export function resolveSemanticDir(
  workspaceRoot: string,
  config: vscode.WorkspaceConfiguration,
): string {
  const inspected = config.inspect<string>('semanticDir');
  const explicit =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }

  const hasDot = fs.existsSync(path.join(workspaceRoot, '.erd-studio'));
  const hasLegacy = fs.existsSync(path.join(workspaceRoot, 'erd-studio'));

  if (hasDot && hasLegacy) {
    console.warn(
      '[ERD Studio] Both .erd-studio/ and erd-studio/ exist — using .erd-studio/',
    );
  }
  if (hasDot) return '.erd-studio';
  if (hasLegacy) return 'erd-studio';
  return '.erd-studio';
}
```

Resolution order:

1. **Explicit setting** (`workspaceFolder` > `workspace` > `global` scope) —
   user choice always wins. `inspect()` is used rather than `get()` so the
   `default` value is *not* mistaken for an explicit choice.
2. **`.erd-studio/` exists** — new convention.
3. **`erd-studio/` exists** — legacy projects keep working.
4. **Neither exists** — new setup, default to `.erd-studio/`.

The resolved value is computed **once** at activation in `extension.ts` and
threaded through every service (most already accept a `semanticDir`
parameter). Ad-hoc `config.get('semanticDir', 'erd-studio')` reads that bypass
the resolver are removed.

### 2. Static manifest contributions

VS Code reads `package.json` contributions at install time — they cannot be
made dynamic from a setting. These are handled with fixed adjustments:

- **`customEditors` selector** — list **both** globs so the visual editor
  activates for either directory layout:

  ```json
  "selector": [
    { "filenamePattern": "**/erd-studio/*/*.json" },
    { "filenamePattern": "**/.erd-studio/*/*.json" }
  ]
  ```

  A project only ever has one of the two directories, so there is no conflict.

- **`dbtSemantic.semanticDir` setting** — `default` changed to `.erd-studio`
  and description updated. This value is cosmetic only (shown in the Settings
  UI); the resolver ignores it via `inspect()`.

- **Welcome-view text** (`viewsWelcome` `contents`) — references to creating
  / storing files in `erd-studio` updated to `.erd-studio`.

### 3. Code with hardcoded `erd-studio` (built from the resolved dir)

- **`FileWatcherService`** — the glob patterns `erd-studio/**/*.json` and
  `erd-studio/logical-models/*.yml` are constructed in code. Add a
  `semanticDir` constructor parameter and build the patterns from it.

- **`SemanticFileDecorationProvider`** — the static class field
  `SEMANTIC_PATH_PATTERN = /[/\\]erd-studio[/\\]/` becomes an instance value
  built from `this.semanticDir`, regex-escaped (the leading `.` in
  `.erd-studio` is a regex metacharacter). The provider already receives
  `semanticDir` in its constructor.

- **`SemanticEditorProvider`** — the two inline
  `config.get('semanticDir', 'erd-studio')` reads (sync-plan path handling)
  are replaced by a `semanticDir` constructor parameter, so they honour
  auto-detection.

- **`MigrationService`** — the hardcoded `path.join(workspaceRoot,
  'erd-studio')` becomes a `semanticDir` constructor parameter. Migration runs
  only when a legacy v4 directory already exists, which the resolver will have
  detected, so the resolved value is correct.

`activationEvents` (`workspaceContains:**/dbt_project.yml`) does not reference
the data directory and needs no change.

### 4. Harness templating — `src/services/harnessService.ts`

`erd-studio` appears in the harness service in **two distinct roles** that
must be treated differently:

**Data-directory references — replace with a `__DATA_DIR__` token:**

- `SCHEMA_CONTENT`: the architecture tree diagram, `erd-studio/{layer}/{domain}.json`,
  `erd-studio/logical-models/...` paths, `erd-studio/.sync-plan.json` references.
- `SYNC_CONTENT`: `erd-studio/.sync-plan.json` references, the
  `logicalModelPath` JSON example value.
- `generateClaudeSkill` frontmatter `description`: the phrases
  "the erd-studio/ directory", "files in erd-studio/", "in an erd-studio context".
- `generateCopilotInstructions`: `applyTo: '**/erd-studio/**/*.json'`.
- `generateGeminiStyleguide`: the review-rules heading
  ``### ERD Studio Domain Files (`erd-studio/**/*.json`)``.
- `generateEnforceSkillHook`: the `case` pattern `*/erd-studio/*)` and its
  comment.

**Fixed identifiers — must NOT change:**

- The skill folder path `.claude/skills/erd-studio/` (and `SKILL.md`,
  `SYNC.md`, `enforce-skill.sh` within it) — `HARNESS_TARGETS` paths and the
  hook command in `mergeHookConfig`.
- The skill `name: erd-studio` frontmatter and the `/erd-studio` invocation
  text.
- `.github/instructions/erd-studio.instructions.md`, `codex-erd-studio.md`.
- The `<!-- erd-studio-harness: N -->` version marker and
  `extractHarnessVersion` regex.
- The `/tmp/.erd-studio-skill-${session_id}` flag filename in the hook.

**Rendering:** `generateContent()`, `install()`, and the per-format
generators take the resolved `semanticDir`. After a generator assembles its
string it does a final `String.prototype.replaceAll('__DATA_DIR__', dir)`.
The harness content is rendered per-project at install time, so an
`erd-studio/` project and a `.erd-studio/` project each receive correct paths
from the same template.

Callers — the `installCodingHarness` command and the activation-time
`detectStale` "Update All" path in `extension.ts` — already have the resolved
`semanticDir` in scope and pass it through.

**`HARNESS_VERSION` bump 14 → 15.** Required by the CLAUDE.md convention
(generators changed). Side effect: existing `erd-studio/` harness installs are
flagged stale once and prompted to update; the rewritten content is identical
to the old content except for the bumped marker line. This is harmless and the
prompt offers "Dismiss".

## Testing

- **`semanticDirResolver` unit tests:** explicit-setting-wins (each scope);
  `.erd-studio/` detected; `erd-studio/` detected (legacy); neither exists →
  `.erd-studio`; both exist → `.erd-studio`.
- **Harness rendering tests:** `__DATA_DIR__` is replaced by the resolved dir
  in generated content; the fixed identifiers (`name: erd-studio`,
  `.claude/skills/erd-studio/`, the version marker) are left intact; rendering
  with `erd-studio` reproduces the pre-change content (apart from the marker).
- The existing `test/fixtures/dbt-project/erd-studio/` fixture continues to
  exercise the legacy-directory detection branch — it is **not** renamed.

## Files

**New**

- `src/services/semanticDirResolver.ts`
- `test/unit/semanticDirResolver.test.ts`

**Modified**

- `src/extension.ts` — resolve once, thread through; pass `semanticDir` to
  `FileWatcherService`, `SemanticEditorProvider`, `MigrationService`.
- `package.json` — dual `customEditors` selectors; `semanticDir` default and
  description; welcome-view text.
- `src/watchers/FileWatcherService.ts` — `semanticDir` constructor param,
  globs built from it.
- `src/providers/SemanticFileDecorationProvider.ts` — instance regex from
  `this.semanticDir`.
- `src/providers/SemanticEditorProvider.ts` — `semanticDir` constructor param
  replaces inline `config.get` reads.
- `src/services/migrationService.ts` — `semanticDir` constructor param.
- `src/services/harnessService.ts` — `__DATA_DIR__` tokenisation, generators
  take `semanticDir`, `HARNESS_VERSION` 14 → 15.
- `test/unit/harnessService.test.ts` — coverage for templated rendering;
  update any expectations affected by generator signature changes.
- `test/unit/fileWatcherService.test.ts` — update `FileWatcherService`
  construction for the new `semanticDir` parameter.
