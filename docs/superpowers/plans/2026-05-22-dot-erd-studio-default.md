# `.erd-studio` Default Data Directory — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `.erd-studio` the default ERD Studio data directory for new projects while existing `erd-studio/` projects keep working untouched.

**Architecture:** A new `resolveSemanticDir()` helper decides the directory name at activation (explicit setting → `.erd-studio/` on disk → `erd-studio/` on disk → `.erd-studio` default). The resolved value is threaded through every service via constructor parameters that default to `'erd-studio'` so each task keeps the build green on its own. Static `package.json` contributions that cannot read settings (the custom-editor glob) list both directory patterns. The AI coding harness is templated with a `__DATA_DIR__` placeholder so generated files reference the project's actual directory.

**Tech Stack:** TypeScript, VS Code Extension API, esbuild, vitest.

**Conventions:**
- All commits end with the trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (repo convention).
- Work happens on branch `feat/dot-erd-studio-default` (already created).
- Spec: `docs/superpowers/specs/2026-05-22-dot-erd-studio-default-design.md`.

---

## Task 1: `resolveSemanticDir` helper

**Files:**
- Create: `src/services/semanticDirResolver.ts`
- Test: `test/unit/semanticDirResolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/semanticDirResolver.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { resolveSemanticDir } from '../../src/services/semanticDirResolver';

interface Inspected {
  globalValue?: string;
  workspaceValue?: string;
  workspaceFolderValue?: string;
}

// Minimal stand-in for vscode.WorkspaceConfiguration — only `inspect` is used.
function fakeConfig(inspected: Inspected = {}): any {
  return { inspect: () => ({ key: 'semanticDir', ...inspected }) };
}

describe('resolveSemanticDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semdir-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an explicit workspace-folder setting over disk state', () => {
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    const result = resolveSemanticDir(tmpDir, fakeConfig({ workspaceFolderValue: 'custom-dir' }));
    expect(result).toBe('custom-dir');
  });

  it('returns an explicit global setting when no narrower scope is set', () => {
    expect(resolveSemanticDir(tmpDir, fakeConfig({ globalValue: 'global-dir' }))).toBe('global-dir');
  });

  it('detects an existing .erd-studio directory', () => {
    fs.mkdirSync(path.join(tmpDir, '.erd-studio'));
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
  });

  it('detects a legacy erd-studio directory', () => {
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('erd-studio');
  });

  it('defaults to .erd-studio when neither directory exists', () => {
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
  });

  it('prefers .erd-studio when both directories exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.erd-studio'));
    fs.mkdirSync(path.join(tmpDir, 'erd-studio'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveSemanticDir(tmpDir, fakeConfig())).toBe('.erd-studio');
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/semanticDirResolver.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/services/semanticDirResolver"` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/services/semanticDirResolver.ts`:

```ts
/**
 * semanticDirResolver — determines the ERD Studio data directory name for a
 * workspace.
 *
 * Resolution order:
 *   1. An explicit `dbtSemantic.semanticDir` setting (any scope) — user wins.
 *   2. `.erd-studio/` if it exists on disk — the current default convention.
 *   3. `erd-studio/` if it exists on disk — legacy projects keep working.
 *   4. `.erd-studio/` — brand-new setups.
 *
 * `inspect()` is used rather than `get()` so the setting's `default` value is
 * not mistaken for an explicit user choice.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

/** Default data directory for new projects. */
export const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/** Legacy data directory — pre-dates the dot-prefixed default. */
export const LEGACY_SEMANTIC_DIR = 'erd-studio';

export function resolveSemanticDir(
  workspaceRoot: string,
  config: vscode.WorkspaceConfiguration,
): string {
  const inspected = config.inspect<string>('semanticDir');
  const explicit =
    inspected?.workspaceFolderValue ??
    inspected?.workspaceValue ??
    inspected?.globalValue;
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim();
  }

  const hasDot = fs.existsSync(path.join(workspaceRoot, DEFAULT_SEMANTIC_DIR));
  const hasLegacy = fs.existsSync(path.join(workspaceRoot, LEGACY_SEMANTIC_DIR));

  if (hasDot && hasLegacy) {
    console.warn(
      '[ERD Studio] Both .erd-studio/ and erd-studio/ exist — using .erd-studio/',
    );
  }
  if (hasDot) { return DEFAULT_SEMANTIC_DIR; }
  if (hasLegacy) { return LEGACY_SEMANTIC_DIR; }
  return DEFAULT_SEMANTIC_DIR;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/semanticDirResolver.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Type-check**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/services/semanticDirResolver.ts test/unit/semanticDirResolver.test.ts
git commit -m "$(cat <<'EOF'
feat: add resolveSemanticDir helper for data directory detection

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Template the AI coding harness

The `__DATA_DIR__` placeholder is substituted with the resolved directory at
generation time. `erd-studio` inside the `SCHEMA_CONTENT` and `SYNC_CONTENT`
constants is **always** a data-directory reference; `erd-studio` everywhere
else in the file (`name: erd-studio`, `HARNESS_TARGETS` paths, the
`erd-studio-harness` marker, the `.claude/skills/erd-studio/` hook command,
the `/erd-studio skill` deny message) is a **fixed identifier** and must not
change.

**Files:**
- Modify: `src/services/harnessService.ts`
- Test: `test/unit/harnessService.test.ts`

- [ ] **Step 1: Write the failing tests**

Append this `describe` block inside the top-level `describe('HarnessService', …)`
in `test/unit/harnessService.test.ts` (immediately before its final closing `});`):

```ts
  describe('directory templating', () => {
    it('renders the Claude skill against a custom data directory', () => {
      const content = service.generateContent('claude', '.erd-studio');
      expect(content).toContain('\n.erd-studio/\n');               // architecture tree root
      expect(content).toContain('.erd-studio/logical-models/');
      expect(content).toContain('.erd-studio/{layer}/{domain}.json');
    });

    it('keeps the skill name identifier untemplated', () => {
      const content = service.generateContent('claude', '.erd-studio');
      expect(content).toContain('name: erd-studio\n');
    });

    it('templates the Copilot applyTo glob', () => {
      const content = service.generateContent('copilot', '.erd-studio');
      expect(content).toContain("applyTo: '**/.erd-studio/**/*.json'");
    });

    it('defaults to erd-studio when no directory is given', () => {
      expect(service.generateContent('copilot')).toContain("applyTo: '**/erd-studio/**/*.json'");
    });

    it('leaves no unresolved __DATA_DIR__ tokens in any format', () => {
      for (const target of HARNESS_TARGETS) {
        expect(service.generateContent(target.id, '.erd-studio')).not.toContain('__DATA_DIR__');
      }
    });

    it('templates the enforce-skill hook case pattern', () => {
      const target = HARNESS_TARGETS.find(t => t.id === 'claude')!;
      service.install(tmpDir, target, false, '.erd-studio');
      const hook = fs.readFileSync(
        path.join(tmpDir, '.claude', 'skills', 'erd-studio', 'enforce-skill.sh'), 'utf-8');
      expect(hook).toContain('*/.erd-studio/*)');
    });

    it('exposes HARNESS_VERSION 15', () => {
      expect(HARNESS_VERSION).toBe('15');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/harnessService.test.ts`
Expected: FAIL — TypeScript reports `Expected 1 arguments, but got 2` for `generateContent('claude', '.erd-studio')` (the second parameter does not exist yet).

- [ ] **Step 3: Replace `erd-studio` with `__DATA_DIR__` inside the content constants**

In `src/services/harnessService.ts`, inside the `SCHEMA_CONTENT` template
literal (starts `const SCHEMA_CONTENT = \`# ERD Studio …`, ends at the closing
`` `; `` after the Sync Reconciliation section) and the `SYNC_CONTENT`
template literal (starts `const SYNC_CONTENT = \`# ERD Studio — Sync …`),
replace **every** occurrence of `erd-studio` with `__DATA_DIR__`. Every
`erd-studio` in these two constants is a data-directory path. The affected
strings are:

- `` `erd-studio/logical-models/` `` → `` `__DATA_DIR__/logical-models/` ``
- the architecture-tree line `erd-studio/` → `__DATA_DIR__/`
- `` `erd-studio/{layer}/{domain}.json` `` → `` `__DATA_DIR__/{layer}/{domain}.json` ``
- `` `erd-studio/logical-models/{model_name}.yml` `` → `` `__DATA_DIR__/logical-models/{model_name}.yml` ``
- `` `erd-studio/logical-models/dim_customer.yml` `` → `` `__DATA_DIR__/logical-models/dim_customer.yml` ``
- `` `erd-studio/logical-models/{name}.yml` `` → `` `__DATA_DIR__/logical-models/{name}.yml` ``
- `` `erd-studio/.sync-plan.json` `` → `` `__DATA_DIR__/.sync-plan.json` `` (appears 5×)
- `"erd-studio/logical-models/dim_customer.yml"` → `"__DATA_DIR__/logical-models/dim_customer.yml"` (JSON example in `SYNC_CONTENT`)

- [ ] **Step 4: Replace `erd-studio` data-dir references in the generators**

Four targeted edits in the same file.

**4a — `generateClaudeSkill` frontmatter description.** Replace:

```
  Schema rules for ERD Studio data model files — the erd-studio/ directory
  uses a two-file system (YAML model definitions + JSON domain diagrams)
  with strict format rules you must read before editing. Use this skill
  whenever the task touches files in erd-studio/ (domain JSON, logical-models
  YAML, or .sync-plan.json), asks to add/edit/remove models, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an erd-studio context, or involves
```

with:

```
  Schema rules for ERD Studio data model files — the __DATA_DIR__/ directory
  uses a two-file system (YAML model definitions + JSON domain diagrams)
  with strict format rules you must read before editing. Use this skill
  whenever the task touches files in __DATA_DIR__/ (domain JSON, logical-models
  YAML, or .sync-plan.json), asks to add/edit/remove models, columns,
  relationships, or cardinality in a data model or ERD diagram, mentions
  dim_/fct_/ref_/brg_ prefixed tables in an __DATA_DIR__ context, or involves
```

(The line `name: erd-studio` directly above this block is a fixed identifier — leave it.)

**4b — `generateEnforceSkillHook` comment and `case` pattern.** Replace:

```
    '# Only act on files inside erd-studio/ directories',
    'case "$file_path" in',
    '  */erd-studio/*)',
```

with:

```
    '# Only act on files inside the ERD Studio data directory',
    'case "$file_path" in',
    '  */__DATA_DIR__/*)',
```

(The `deny=` line above mentioning "editing erd-studio files" and the `/tmp/.erd-studio-skill-` flag below are left unchanged — prose and a temp filename, not data-dir paths.)

**4c — `generateCopilotInstructions` applyTo glob.** Replace:

```
applyTo: '**/erd-studio/**/*.json'
```

with:

```
applyTo: '**/__DATA_DIR__/**/*.json'
```

**4d — `generateGeminiStyleguide` review-rules heading.** Replace:

```
### ERD Studio Domain Files (\`erd-studio/**/*.json\`)
```

with:

```
### ERD Studio Domain Files (\`__DATA_DIR__/**/*.json\`)
```

- [ ] **Step 5: Add the render helper and bump the version**

In `src/services/harnessService.ts`, change the version constant:

```ts
/** Version of the harness content. Bump when SCHEMA_CONTENT or generators change. */
export const HARNESS_VERSION = '15';
```

Add this helper immediately after the `buildVersionMarker` function:

```ts
/** Substitute the __DATA_DIR__ placeholder with the project's data directory. */
function renderDataDir(content: string, semanticDir: string): string {
  return content.split('__DATA_DIR__').join(semanticDir);
}
```

- [ ] **Step 6: Thread `semanticDir` through the generators**

Each generator takes a `semanticDir` parameter and wraps its return value in
`renderDataDir(...)`. Apply these signature + return changes:

```ts
function generateClaudeSkill(semanticDir: string): string {
  return renderDataDir(`---
name: erd-studio
description: >-
  ...unchanged body...
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`, semanticDir);
}

function generateEnforceSkillHook(semanticDir: string): string {
  return renderDataDir([
    '#!/usr/bin/env bash',
    // ...unchanged array entries...
    'exit 0',
  ].join('\n') + '\n', semanticDir);
}

function generateSyncGuide(semanticDir: string): string {
  return renderDataDir(`${SYNC_CONTENT}

${buildVersionMarker()}
`, semanticDir);
}

function generateCopilotInstructions(semanticDir: string): string {
  return renderDataDir(`---
name: 'ERD Studio'
description: '...unchanged...'
applyTo: '**/__DATA_DIR__/**/*.json'
---

${SCHEMA_CONTENT}

${buildVersionMarker()}
`, semanticDir);
}

function generateGeminiStyleguide(semanticDir: string): string {
  return renderDataDir(`${SCHEMA_CONTENT}

## Code Review Rules
...unchanged body...

${buildVersionMarker()}
`, semanticDir);
}

function generateCodexAgents(semanticDir: string): string {
  return renderDataDir(`
## ERD Studio Domain Files

${SCHEMA_CONTENT}

${buildVersionMarker()}
`, semanticDir);
}
```

> Only the function signature and the wrapping `renderDataDir(..., semanticDir)`
> call change. Do not otherwise rewrite the generator bodies.

- [ ] **Step 7: Thread `semanticDir` through `generateContent` and `install`**

Update the `HarnessService` methods. `generateContent`:

```ts
generateContent(targetId: HarnessTarget['id'], semanticDir: string = 'erd-studio'): string {
  switch (targetId) {
    case 'claude':
      return generateClaudeSkill(semanticDir);
    case 'copilot':
      return generateCopilotInstructions(semanticDir);
    case 'gemini':
      return generateGeminiStyleguide(semanticDir);
    case 'codex':
      return generateCodexAgents(semanticDir);
  }
}
```

`install` — add a fourth parameter and pass it to the three generation calls:

```ts
install(
  workspaceRoot: string,
  target: HarnessTarget,
  overwrite: boolean = false,
  semanticDir: string = 'erd-studio',
): HarnessInstallResult {
```

Inside `install`, change `const content = this.generateContent(target.id);` to
`const content = this.generateContent(target.id, semanticDir);`, change
`generateSyncGuide()` to `generateSyncGuide(semanticDir)`, and change
`generateEnforceSkillHook()` to `generateEnforceSkillHook(semanticDir)`.

The `'erd-studio'` default keeps every existing test green — they render the
legacy directory exactly as before.

- [ ] **Step 8: Verify no stray references remain**

Run: `grep -n 'erd-studio' src/services/harnessService.ts`
Expected: remaining hits are ONLY fixed identifiers — the file-header JSDoc,
`VERSION_MARKER_PREFIX` / `extractHarnessVersion`, `HARNESS_TARGETS` paths,
`name: erd-studio`, the hook `deny=` message, `/tmp/.erd-studio-skill-`,
`.claude/skills/erd-studio/` in comments and `mergeHookConfig`. No hits inside
`SCHEMA_CONTENT`, `SYNC_CONTENT`, the `applyTo` line, the Gemini heading, or
the hook `case` pattern.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run test/unit/harnessService.test.ts`
Expected: PASS — the new `directory templating` block passes and all
pre-existing harness tests still pass.

- [ ] **Step 10: Type-check**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 11: Commit**

```bash
git add src/services/harnessService.ts test/unit/harnessService.test.ts
git commit -m "$(cat <<'EOF'
feat: template harness data-dir paths, bump HARNESS_VERSION to 15

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `FileWatcherService` — `semanticDir` parameter

This is a parameterization refactor. The `RelativePattern` is not observable
through the vscode test mock, so it is verified by `npm run compile` and the
existing `FileWatcherService` suite (which keeps passing because the new
parameter defaults to `'erd-studio'`).

**Files:**
- Modify: `src/watchers/FileWatcherService.ts`

- [ ] **Step 1: Add the constructor parameter**

In `src/watchers/FileWatcherService.ts`, change the constructor:

```ts
  constructor(
    private readonly workspaceRoot: string,
    private readonly semanticDir: string = 'erd-studio',
  ) {
    this.lastProjectPaths = this.readProjectPaths();
    this.setupManifestWatcher();
    this.setupSemanticWatcher();
    this.setupProjectConfigWatcher();
    this.setupLogicalModelWatcher();
    this.setupDbtYmlWatcher();
  }
```

- [ ] **Step 2: Build the glob patterns from `semanticDir`**

In `setupSemanticWatcher`, change the pattern:

```ts
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/**/*.json`,
    );
```

In `setupLogicalModelWatcher`, change the pattern:

```ts
    const pattern = new vscode.RelativePattern(
      this.workspaceRoot,
      `${this.semanticDir}/logical-models/*.yml`,
    );
```

- [ ] **Step 3: Type-check and run the existing suite**

Run: `npm run compile && npx vitest run test/unit/fileWatcherService.test.ts`
Expected: No type errors; all FileWatcherService tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/watchers/FileWatcherService.ts
git commit -m "$(cat <<'EOF'
feat: build FileWatcherService globs from semanticDir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `SemanticFileDecorationProvider` — instance regex

The static path regex `/[/\\]erd-studio[/\\]/` fails to match `.erd-studio`
(the leading `.` is not a `/`). Replace it with an instance regex built from
`this.semanticDir`, regex-escaped.

**Files:**
- Modify: `src/providers/SemanticFileDecorationProvider.ts`
- Test: `test/unit/semanticFileDecorationProvider.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/unit/semanticFileDecorationProvider.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { SemanticFileDecorationProvider } from '../../src/providers/SemanticFileDecorationProvider';
import type { LayerService } from '../../src/services/layerService';

// Minimal stand-in — the provider only calls getLayer().
const fakeLayerService = {
  getLayer: (id: string) =>
    id === 'silver'
      ? { id: 'silver', label: 'Silver', abbreviation: 'SIL', color: '#ccc', creatable: true }
      : undefined,
} as unknown as LayerService;

describe('SemanticFileDecorationProvider', () => {
  it('decorates domain files inside a dot-prefixed data directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService, '.erd-studio');
    const uri = vscode.Uri.file('/ws/.erd-studio/silver/orders.json');
    expect(provider.provideFileDecoration(uri)?.tooltip).toBe(
      'Silver domain (opens in visual editor)',
    );
  });

  it('still decorates domain files inside the legacy erd-studio directory', () => {
    const provider = new SemanticFileDecorationProvider(fakeLayerService, 'erd-studio');
    const uri = vscode.Uri.file('/ws/erd-studio/silver/orders.json');
    expect(provider.provideFileDecoration(uri)?.tooltip).toBe(
      'Silver domain (opens in visual editor)',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/semanticFileDecorationProvider.test.ts`
Expected: FAIL — the `.erd-studio` case returns `undefined` (the static regex
`/[/\\]erd-studio[/\\]/` does not match `/.erd-studio/`), so `.tooltip` is
`undefined` instead of the expected string.

- [ ] **Step 3: Replace the static regex with an instance regex**

In `src/providers/SemanticFileDecorationProvider.ts`, delete the static field:

```ts
  private static readonly SEMANTIC_PATH_PATTERN = /[/\\]erd-studio[/\\]/;
```

Add an instance field and build it in the constructor:

```ts
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  /** Matches paths containing the semantic directory as a path segment. */
  private readonly semanticPathPattern: RegExp;

  constructor(
    private readonly layerService: LayerService,
    private readonly semanticDir: string = 'erd-studio',
  ) {
    const escaped = this.semanticDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.semanticPathPattern = new RegExp(`[/\\\\]${escaped}[/\\\\]`);
  }
```

In `provideFileDecoration`, change the guard from the static field to the
instance field:

```ts
    if (!this.semanticPathPattern.test(fsPath)) {
      return undefined;
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/semanticFileDecorationProvider.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Type-check**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/providers/SemanticFileDecorationProvider.ts test/unit/semanticFileDecorationProvider.test.ts
git commit -m "$(cat <<'EOF'
feat: build decoration path regex from semanticDir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `MigrationService` — `semanticDir` parameter

`findV4Domains()` hardcodes `path.join(this.workspaceRoot, 'erd-studio')`.
Migration only runs when a legacy v4 directory already exists, which the
resolver will have detected — so passing the resolved value is correct.
No existing test covers `MigrationService`; verified by `npm run compile`.

**Files:**
- Modify: `src/services/migrationService.ts`

- [ ] **Step 1: Add the constructor parameter**

In `src/services/migrationService.ts`, change the constructor:

```ts
  constructor(
    private readonly workspaceRoot: string,
    private readonly layerService: LayerService,
    private readonly logicalModelService: LogicalModelService,
    private readonly semanticDir: string = 'erd-studio',
  ) {}
```

- [ ] **Step 2: Use the parameter in `findV4Domains`**

Change the first line of `findV4Domains()`:

```ts
    const semanticDir = path.join(this.workspaceRoot, this.semanticDir);
```

- [ ] **Step 3: Type-check**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/services/migrationService.ts
git commit -m "$(cat <<'EOF'
feat: build MigrationService domain path from semanticDir

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `SemanticEditorProvider` — `semanticDir` parameter

Two methods re-read the setting with `config.get('semanticDir', 'erd-studio')`,
bypassing auto-detection. Replace both with a constructor parameter.

**Files:**
- Modify: `src/providers/SemanticEditorProvider.ts`

- [ ] **Step 1: Add the constructor parameter**

In `src/providers/SemanticEditorProvider.ts`, change the constructor (add the
final parameter after `logicalModelService`):

```ts
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly domainService: DomainService,
    private readonly manifestService: ManifestService,
    private readonly ymlParserService: YmlParserService,
    private readonly templateService: TemplateService,
    private readonly layerService: LayerService,
    private readonly workspaceRoot: string,
    private readonly selectorsService: SelectorsService,
    readonly logicalModelService: import('../services/logicalModelService').LogicalModelService,
    private readonly semanticDir: string = 'erd-studio',
  ) {}
```

- [ ] **Step 2: Replace the first inline config read**

Find this block (in the discrepancy-resolution handler):

```ts
      const semanticDir = vscode.workspace
        .getConfiguration('dbtSemantic')
        .get<string>('semanticDir', 'erd-studio');
```

Replace it with:

```ts
      const semanticDir = this.semanticDir;
```

- [ ] **Step 3: Replace the second inline config read**

Find this block (in `handleLaunchClaudeSync`):

```ts
    const semanticDir = vscode.workspace
      .getConfiguration('dbtSemantic')
      .get<string>('semanticDir', 'erd-studio');
    const planPath = `${semanticDir}/.sync-plan.json`;
```

Replace it with:

```ts
    const planPath = `${this.semanticDir}/.sync-plan.json`;
```

- [ ] **Step 4: Type-check**

Run: `npm run compile`
Expected: No errors. (If `tsc` reports an unused `semanticDir` local anywhere,
it means a downstream reference to the old local was missed — search the file
for `semanticDir` and confirm every remaining use reads `this.semanticDir`.)

- [ ] **Step 5: Commit**

```bash
git add src/providers/SemanticEditorProvider.ts
git commit -m "$(cat <<'EOF'
feat: pass semanticDir to SemanticEditorProvider instead of re-reading config

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `package.json` static contributions

`package.json` is read by VS Code at install time and cannot reference a
setting. The custom-editor selector lists both directory globs; the setting
default and welcome text are updated to the new convention.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the second custom-editor selector**

In `package.json`, change the `customEditors[0].selector` array:

```json
        "selector": [
          {
            "filenamePattern": "**/erd-studio/*/*.json"
          },
          {
            "filenamePattern": "**/.erd-studio/*/*.json"
          }
        ],
```

- [ ] **Step 2: Update the `semanticDir` setting default**

Change the `dbtSemantic.semanticDir` property:

```json
        "dbtSemantic.semanticDir": {
          "type": "string",
          "default": ".erd-studio",
          "description": "Relative path to ERD domain files within the project. New projects default to .erd-studio; existing erd-studio directories are detected automatically."
        }
```

- [ ] **Step 3: Update the welcome-view text**

In the `viewsWelcome` entry for the empty domain tree, change
`Creates the erd-studio directory structure and your first domain.` to
`Creates the .erd-studio directory structure and your first domain.`

In the `viewsWelcome` entry for the empty model library, change
`Models are stored as YAML files in erd-studio/logical-models/.` to
`Models are stored as YAML files in .erd-studio/logical-models/.`

- [ ] **Step 4: Verify the JSON is valid and types still check**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('package.json valid')"`
Expected: prints `package.json valid`.

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "$(cat <<'EOF'
feat: default to .erd-studio in package.json contributions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wire the resolver into `extension.ts`

This task turns auto-detection on: `extension.ts` resolves the directory once
and passes it to every constructor and harness call updated in Tasks 2–7.

**Files:**
- Modify: `src/extension.ts`
- Modify: `test/__mocks__/vscode.ts`

- [ ] **Step 1: Add `inspect` to the vscode test mock**

`resolveSemanticDir` calls `config.inspect()`, which the mock does not yet
provide. In `test/__mocks__/vscode.ts`, change `workspace.getConfiguration`:

```ts
  getConfiguration: () => ({
    get: (key: string, defaultValue?: unknown) => defaultValue,
    inspect: (key: string) => ({ key }),
  }),
```

(`inspect` returns no scope values, so the resolver falls through to disk
detection — the correct behaviour for tests with no explicit setting.)

- [ ] **Step 2: Import the resolver and use it at activation**

In `src/extension.ts`, add the import alongside the other service imports:

```ts
import { resolveSemanticDir } from './services/semanticDirResolver';
```

Change the activation lines that read the setting:

```ts
  const config = vscode.workspace.getConfiguration('dbtSemantic');
  const semanticDir = resolveSemanticDir(workspaceRoot, config);
```

- [ ] **Step 3: Pass `semanticDir` to `MigrationService`**

Change the `MigrationService` construction:

```ts
  const migrationService = new MigrationService(workspaceRoot, layerService, logicalModelService, semanticDir);
```

- [ ] **Step 4: Pass `semanticDir` to `SemanticEditorProvider`**

Change the `SemanticEditorProvider` construction — add `semanticDir` as the
final argument:

```ts
  const editorProvider = new SemanticEditorProvider(
    context,
    domainService,
    manifestService,
    ymlParserService,
    templateService,
    layerService,
    workspaceRoot,
    selectorsService,
    logicalModelService,
    semanticDir,
  );
```

- [ ] **Step 5: Pass `semanticDir` to `FileWatcherService`**

Change the `FileWatcherService` construction:

```ts
  const fileWatcherService = new FileWatcherService(workspaceRoot, semanticDir);
```

- [ ] **Step 6: Pass `semanticDir` to both harness `install` calls**

In the `dbtSemantic.installCodingHarness` command handler, change:

```ts
          harnessService.install(workspaceRoot, s.target, true, semanticDir),
```

In the activation-time stale-harness auto-update loop, change:

```ts
        harnessService.install(workspaceRoot, target, true, semanticDir);
```

- [ ] **Step 7: Type-check**

Run: `npm run compile`
Expected: No errors.

- [ ] **Step 8: Run the full unit suite**

Run: `npm run test`
Expected: PASS — all tests pass, including `extension.test.ts`,
`semanticDirResolver.test.ts`, `harnessService.test.ts`,
`semanticFileDecorationProvider.test.ts`, and `fileWatcherService.test.ts`.

- [ ] **Step 9: Production build**

Run: `npm run build`
Expected: Both extension and webview bundles build with no errors.

- [ ] **Step 10: Commit**

```bash
git add src/extension.ts test/__mocks__/vscode.ts
git commit -m "$(cat <<'EOF'
feat: resolve data directory at activation, default to .erd-studio

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Manual verification (after Task 8)

Build and launch the Extension Development Host against the fixtures project
(which uses the legacy `erd-studio/` directory):

```bash
npm run build
code --extensionDevelopmentPath=/Users/liamwynne/GIT/LIAM/erd-studio /Users/liamwynne/GIT/LIAM/erd-studio/test/fixtures/dbt-project
```

Confirm:
1. The sidebar tree still lists domains under Silver/Gold — auto-detection
   found the legacy `erd-studio/` directory.
2. Opening a domain file (e.g. `erd-studio/silver/showcase.json`) opens the
   visual editor — the legacy custom-editor glob still matches.
3. In a scratch directory containing only `dbt_project.yml`, running
   **ERD Studio: Set Up** creates a `.erd-studio/` directory (not
   `erd-studio/`), and a `.erd-studio/silver/<domain>.json` file opens in the
   visual editor — the new glob matches.

---

## Self-review notes

- **Spec coverage:** resolver (Task 1); harness templating + version bump
  (Task 2); `customEditors` dual selector, setting default, welcome text
  (Task 7); `FileWatcherService` (Task 3); `SemanticFileDecorationProvider`
  (Task 4); `MigrationService` (Task 5); `SemanticEditorProvider` (Task 6);
  activation wiring (Task 8). All spec sections map to a task.
- **Default parameters:** every new `semanticDir` parameter defaults to
  `'erd-studio'`, so Tasks 2–7 keep the build and existing tests green before
  Task 8 wires the resolved value through. The spec anticipated test edits to
  `fileWatcherService.test.ts` and `harnessService.test.ts`; the default
  parameter makes the former unnecessary and limits the latter to additive
  new test cases.
- **Type consistency:** `resolveSemanticDir(workspaceRoot, config)`,
  `generateContent(targetId, semanticDir)`, and
  `install(workspaceRoot, target, overwrite, semanticDir)` signatures are used
  identically in their definitions (Tasks 1, 2) and call sites (Task 8).
