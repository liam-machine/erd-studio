# Domain Structure Restructure Plan

## Summary

Restructure domain file layout from **stage-first** (`erd-studio/{stage}/{layer}/{domain}.json`) to **layer-first single-file** (`erd-studio/{layer}/{domain}.json`), where each file contains both conceptual and logical stages as sections.

## Problem

The current structure puts **stage** as the top-level directory, but users think in terms of **layers** (medallion architecture). This causes:

- **Domain split across two directories** — creating a domain writes two files; renaming/deleting requires keeping siblings in sync
- **Stage-locked tree view** — the sidebar shows one stage at a time, hiding the full domain picture
- **Sibling resolution overhead** — `resolveSiblingPath()` exists solely because of this structural friction
- **Heavy creation UX** — picks layer, name, description, model folder, then creates two files

## Before / After

```
BEFORE                                    AFTER
erd-studio/                               erd-studio/
├── layers.json                           ├── layers.json
├── templates/                            ├── templates/
├── conceptual/                           ├── silver/
│   ├── silver/                           │   ├── customer-360.json  <- both stages
│   │   └── customer-360.json             │   └── orders.json
│   └── gold/                             └── gold/
│       └── reporting.json                    └── reporting.json
├── logical/
│   ├── silver/
│   │   └── customer-360.json
│   └── gold/
│       └── reporting.json
```

### New v3 File Format

```json
{
  "schemaVersion": 3,
  "domain": "customer-360",
  "layer": "silver",
  "description": "Customer 360 data model",
  "modelFolder": "models/silver",
  "conceptual": {
    "models": [{ "name": "dim_customer", "description": "..." }],
    "relationships": [],
    "viewConfig": { "positions": {} }
  },
  "logical": {
    "models": [{ "name": "dim_customer", "columns": [...], "grain": "..." }],
    "relationships": [],
    "viewConfig": { "positions": {} }
  }
}
```

### Tree View Change

```
BEFORE                          AFTER
[Logical v]  <- stage header    Silver
├── Silver                      ├── customer-360
│   └── customer-360            ├── orders
└── Gold                        └── + New Domain...
    └── reporting               Gold
                                ├── reporting
                                └── + New Domain...
```

Stages move entirely into the editor (tabs), no longer in the tree.

---

## Phase Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Types & Schema | ✅ Complete |
| 2 | Migration Function | ✅ Complete |
| 3 | DomainService Rewrite | ✅ Complete |
| 4 | Extension Commands | ✅ Complete |
| 5 | SemanticEditorProvider | ✅ Complete |
| 6 | DomainTreeProvider | ✅ Complete |
| 7 | package.json | Not started |
| 8 | File Watchers (verify) | Not started |
| 9 | Tests & Fixtures | Not started |
| 10 | Documentation & Cleanup | Not started |

---

## Phases

### Phase 1 — Types & Schema

**Files:** `src/types/semantic.ts`, `src/types/display.ts`

**Changes:**

1. Create `StageData` interface:
   ```typescript
   interface StageData {
     models: SemanticModel[];
     relationships: Relationship[];
     viewConfig: ViewConfig;
   }
   ```

2. Create `UnifiedDomain` interface (the v3 on-disk format):
   ```typescript
   interface UnifiedDomain {
     schemaVersion: number;
     domain: string;
     layer: string;
     description: string;
     modelFolder?: string;
     conceptual: StageData;
     logical: StageData;
   }
   ```

3. Keep `SemanticDomain` as the internal per-stage representation (extracted from `UnifiedDomain`). Services return it; webview receives it via `DisplayDomain`.

4. Bump `CURRENT_SCHEMA_VERSION` from `2` to `3`.

5. Update `DomainSummary` — remove `stage` field. Each file produces one summary, not two.

**Notes:**
- `DisplayDomain` (the webview contract) does NOT change. The webview still receives one stage at a time.
- The entire `webview/` directory is untouched by this restructure.
- The message protocol (`src/types/messages.ts`) is untouched — `domainLoaded`, `stageData`, `switchStage` all work as-is.

---

### Phase 2 — Migration Function

**Files:** `src/services/migrationService.ts` (new), `src/services/domainService.ts`

**Changes:**

1. Create `migrationService.ts` with:
   - `migrateV2ToV3(projectPath, semanticDir)` — scans `conceptual/` and `logical/` dirs, merges sibling files into unified v3 files in `{layer}/{domain}.json`, deletes old stage dirs
   - `mergeV2Siblings(conceptualFile, logicalFile) -> UnifiedDomain` — merges two v2 files into one v3 object. If one sibling is missing, that stage section gets empty defaults.

2. Add v2 reading support in `getDomain()` — if `schemaVersion <= 2`, auto-convert in memory (read-only compat). Write path always uses v3.

3. Register `dbtSemantic.migrateDomains` command — user-triggered migration with confirmation dialog. Shows before/after preview.

**Migration strategy:** Soft migration. Old v2 files are readable in memory; new writes always produce v3. The explicit command batch-converts and cleans up old directories.

---

### Phase 3 — DomainService Rewrite

**File:** `src/services/domainService.ts`

**Changes:**

| Method | Change |
|--------|--------|
| `listDomains()` | Remove `DISK_STAGES` loop. Scan `erd-studio/{layer}/*.json` directly. Each file produces one `DomainSummary`. Also check for legacy `conceptual/`/`logical/` dirs and prompt migration. |
| `getDomain(filePath)` | Parse v3 `UnifiedDomain`. Return it as-is (both stages included). |
| `getDomainStage(filePath, stage)` | **New.** Extracts one stage from `UnifiedDomain` -> returns `SemanticDomain`. This is what the editor calls. |
| `buildPhysicalDomain()` | Input changes from standalone `SemanticDomain` to extracting logical from `UnifiedDomain`. Core derivation logic unchanged. |
| `parseStage()` | **Delete.** No longer needed — stage isn't in the path. |
| `parseLayer()` | Unchanged — parent dir is still the layer. |
| `validateDomain()` | Rewrite for v3 structure: validate root fields + each stage section. |

**Constants to remove:**
- `DISK_STAGES = ['conceptual', 'logical']` (line 24)

---

### Phase 4 — Extension Commands

**File:** `src/extension.ts`

All commands that loop over `EDITABLE_STAGES` need the loop removed:

| Command | Current (v2) | New (v3) |
|---------|-------------|----------|
| `createDomain` (lines 311-348) | Creates 2 files in `conceptual/{layer}/` + `logical/{layer}/` | Creates 1 file in `{layer}/` with empty `conceptual` + `logical` sections |
| `deleteDomain` (lines 390-406) | Deletes 2 files | Deletes 1 file |
| `renameDomain` (lines 441-464) | Renames 2 files | Renames 1 file, updates `domain` field inside JSON |
| `setupSemanticDirectory` (lines 512-519) | Creates `{stage}/{layer}/` dirs | Creates `{layer}/` dirs only |
| `addLayer` (lines 593-598) | Creates dirs in all stages | Creates 1 directory |
| `removeLayer` (lines 730-735) | Deletes dirs from all stages | Deletes 1 directory |
| `openDomain` (line 238) | `.replace(/conceptual/, 'logical')` hack for physical | Just open the file; editor handles stage via tabs |

**Constant to remove:** `EDITABLE_STAGES = ['conceptual', 'logical']` (line 129)

---

### Phase 5 — SemanticEditorProvider

**File:** `src/providers/SemanticEditorProvider.ts`

This is the most complex phase. All mutation handlers currently write to a flat JSON. Now they must target a stage section within the unified file.

**Functions to delete:**
- `inferStageFromPath()` (lines 1434-1439) — no stage in path anymore
- `resolveSiblingPath()` (lines 1456-1461) — no sibling files exist

**Functions to rewrite:**

| Function | Change |
|----------|--------|
| `resolveCustomTextEditor()` | On file open, default to `logical` stage (or restore last-viewed from state). No more path-based stage inference. |
| `handleSwitchStage()` (lines 1467-1504) | Instead of loading a sibling file, read the same file and extract the target stage section. For physical: extract logical -> `buildPhysicalDomain()`. Send `stageData` to webview. |
| `buildStageDisplayDomain()` (lines 1553-1566) | Same file, extract stage section instead of resolving sibling path. |
| All mutation handlers (~15-20) | Change `parsed.models` -> `parsed[activeStage].models`. Write back `parsed[activeStage] = stageSection`. |

**Mutation handler pattern change:**
```typescript
// BEFORE (v2): flat structure
const models = parsed.models as Array<...>;
models.push(newModel);

// AFTER (v3): stage-scoped
const stage = panel.activeStage;
const stageSection = parsed[stage] as StageData;
stageSection.models.push(newModel);
parsed[stage] = stageSection;
```

**Helper to add:** `getStageSection(parsed, stage)` to reduce repetition across handlers.

**Unchanged:** `parseDomainPath()` (lines 1445-1450) — still extracts domain name and layer from path correctly.

---

### Phase 6 — DomainTreeProvider

**File:** `src/providers/domainTreeProvider.ts`

**Changes:**

1. Remove `StageHeaderNode` type — stages are no longer a tree concept
2. Root children = layers (not stage header + layers)
3. Layer children = domains (from unified file list)
4. Remove `switchTreeStage` command — tree is stage-agnostic; stages live in editor tabs only
5. Simplify `DomainNode` — remove `openAsStage` field. Opening always opens the unified file; editor defaults to logical.
6. Keep "New Domain..." leaf under each creatable layer

---

### Phase 7 — package.json

**File:** `package.json`

**Changes:**

1. Custom editor selector (lines 166, 169):
   ```json
   // FROM (two patterns):
   "**/erd-studio/conceptual/**/*.json"
   "**/erd-studio/logical/**/*.json"

   // TO (one pattern, exactly one dir deep):
   "**/erd-studio/*/*.json"
   ```
   This matches `erd-studio/{layer}/{domain}.json` but NOT `erd-studio/layers.json` or `erd-studio/templates/foo.json`.

2. Add `dbtSemantic.migrateDomains` command to contributions.

3. Remove `dbtSemantic.switchTreeStage` command (tree is stage-agnostic now).

---

### Phase 8 — File Watchers (Verify Only)

**File:** `src/watchers/FileWatcherService.ts`

**No code changes.** The glob pattern `erd-studio/**/*.json` (line 79) already matches files at any depth under `erd-studio/`. It works with both old and new structures.

**Verify:** Semantic file change events still fire correctly for `erd-studio/{layer}/{domain}.json` paths.

---

### Phase 9 — Tests & Fixtures

**Files:** `test/unit/*.test.ts`, `test/fixtures/`

**Fixture migration:**
- Merge `conceptual/silver/ncr.json` + `logical/silver/ncr.json` -> `silver/ncr.json` (v3 format)
- Same for all fixture domains
- Delete old `conceptual/` and `logical/` directories from fixtures
- Keep malformed/sparse fixtures updated for v3 edge cases

**Test rewrites:**

| Test File | Changes |
|-----------|---------|
| `domainService.test.ts` | Rewrite `listDomains` (no stage in discovery), `getDomain` (parse unified format), add v2->v3 migration tests |
| `domainTreeProvider.test.ts` | Remove stage header tests, update to layer-first tree assertions |
| `discrepancyService.test.ts` | Minimal — uses `DisplayDomain` directly, which is unchanged |
| `fileWatcherService.test.ts` | No changes needed (already uses layer-level paths in some tests) |
| `manifestService.test.ts` | No changes needed |
| `extension.test.ts` | No changes needed |

**New test file:** `migrationService.test.ts` — test v2->v3 conversion, sibling merging, missing siblings, malformed files.

---

### Phase 10 — Documentation & Cleanup

**Files:** `CLAUDE.md`

1. Update directory structure documentation
2. Update architecture section (data flow diagram)
3. Update "Directory Structure" and "Three-Stage Architecture" sections
4. Update dev-preview.html instructions (new domainLoaded payload format)
5. Verify `layerService.detectLayersFromFilesystem()` correctly discovers layer dirs at new depth — add guard to exclude `conceptual`/`logical` dirs during transition period

---

## Execution Order

```
Phase 1 (Types)
    |
Phase 2 (Migration function)
    |
Phase 3 (DomainService)     <-- core change, everything depends on this
    |
    +-- Phase 4 (Extension commands)  --+
    +-- Phase 5 (EditorProvider)        +-- can run in parallel
    +-- Phase 6 (TreeProvider)         --+
    |
Phase 7 (package.json)
    |
Phase 8 (File watchers -- verify only)
    |
Phase 9 (Tests & fixtures)
    |
Phase 10 (Docs & cleanup)
```

## Risk Areas

| Phase | Risk | Mitigation |
|-------|------|------------|
| **Phase 5** (mutation handlers) | Highest line count (~15-20 handlers), most mechanical, most error-prone | Extract `getStageSection()` helper; test each handler individually |
| **Phase 7** (editor activation glob) | Must not accidentally activate on `layers.json` or template files | Use `**/erd-studio/*/*.json` (exactly one dir deep) |
| **Phase 2** (migration) | Must handle edge cases: missing siblings, orphaned files, partially migrated projects | Test with all fixture variants; show preview before migrating |
| **Phase 6** (tree provider) | Removing `switchTreeStage` is a UX change users may notice | Stage tabs in editor are already the primary switching mechanism |

## Files Changed Summary

**~12 source files, ~10 test/fixture files:**

| File | Phase | Impact |
|------|-------|--------|
| `src/types/semantic.ts` | 1 | New types, version bump |
| `src/types/display.ts` | 1 | Minor (DomainSummary) |
| `src/services/migrationService.ts` | 2 | New file |
| `src/services/domainService.ts` | 3 | Major rewrite |
| `src/extension.ts` | 4 | Remove stage loops |
| `src/providers/SemanticEditorProvider.ts` | 5 | Major rewrite (mutation handlers) |
| `src/providers/domainTreeProvider.ts` | 6 | Simplify tree |
| `package.json` | 7 | Activation pattern, commands |
| `src/watchers/FileWatcherService.ts` | 8 | Verify only |
| `test/unit/domainService.test.ts` | 9 | Rewrite |
| `test/unit/domainTreeProvider.test.ts` | 9 | Rewrite |
| `test/unit/migrationService.test.ts` | 9 | New file |
| `test/fixtures/dbt-project/erd-studio/` | 9 | Restructure |
| `CLAUDE.md` | 10 | Update docs |

## What Does NOT Change

- **Webview** (`webview/` directory) — entirely untouched
- **Message protocol** (`src/types/messages.ts`) — same messages, same payloads
- **DisplayDomain** — webview still receives one stage at a time
- **File watcher glob** — `erd-studio/**/*.json` works for both structures
- **Discrepancy system** — compares two `DisplayDomain` objects, unaware of file structure
- **ELK layout / React Flow** — graph rendering is file-structure-agnostic
- **CSS / theme** — no visual changes beyond tree simplification
