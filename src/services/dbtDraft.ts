/**
 * Draw from dbt — seed a LOGICAL draft domain from what the dbt project
 * already declares, so a first diagram needs no AI session and no blank canvas.
 *
 * What it builds is the same thing the canvas's "Add Existing Model" does one
 * model at a time: a logical model copied from the schema .yml (manifest as the
 * fallback) plus the relationship tests between the chosen models. It is a
 * starting point the user asked for and then edits; the physical stage stays
 * derived at runtime and nothing here is persisted as physical data.
 *
 * Pure: no `vscode`, no file access. Callers pass the parsed yml / manifest
 * data in and write the results through their own write path (the editor's
 * `applyDomainEdit`, or a `wx` create for a new domain file). This module is
 * reachable from `dist/cli.js`, so it must never import `vscode`.
 */

import * as path from 'path';

import { canonicalRelationship, linkKey } from '@erd-studio/core';
import { CURRENT_SCHEMA_VERSION } from '../types/semantic';
import type { ColumnDef, Relationship, SemanticModel } from '../types/semantic';
import type { YmlData } from '../types/ymlData';
import type { ManifestData } from '../types/manifest';
import type { CatalogColumn, CatalogData } from '../types/catalog';
import { validateModelNameSafety } from '../providers/payloadValidation';
import { derivePhysicalRelationships, mergeCompositeGroups, mergeUniqueMaps } from './domainService';
import { normaliseName } from './nameUtils';
import { catalogNodeFor, resolveColumnType } from './columnTypes';

/** Most models one draft (or one batch add) will create — a readable first diagram. */
export const DRAFT_MODEL_LIMIT = 15;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** What the dbt project holds. Either source may be missing (yml-only, manifest-only). */
export interface DraftSourceInput {
  ymlData?: YmlData;
  manifest?: ManifestData;
  /** Absolute dbt project root — `YmlModelInfo.filePath` is absolute. */
  projectRoot: string;
  /** `model-paths` from dbt_project.yml (project-relative). */
  modelPaths: readonly string[];
  /** Configured layer ids; a suggested layer outside this list is not offered. */
  layerIds?: readonly string[];
  /** Add relationship-connected clusters after the folder scopes (default true). */
  includeClusters?: boolean;
}

/** One model the user could draw. */
export interface DraftModelEntry {
  name: string;
  /** Folder under its model path, forward slashes (`''` at the top level, `null` when unknown). */
  folder: string | null;
  description: string;
  suggestedLayer?: string;
}

/** A group of models offered as one pick. */
export interface DraftScope {
  /** `folder:<path>`, `cluster:<hub>` or `custom`. */
  id: string;
  kind: 'folder' | 'cluster' | 'custom';
  label: string;
  /** Short, e.g. "6 models". */
  description: string;
  /** A few of the model names. */
  detail: string;
  /** Best first — most connected within the scope, then by name — so truncation keeps a joined-up picture. */
  modelNames: string[];
  count: number;
  /** The folder path for a folder scope. */
  folder?: string;
  suggestedLayer?: string;
}

/** Relationship-test shape shared by yml and manifest tests. */
export interface DraftRelationshipTest {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

/** Uniqueness tests, the input to cardinality. */
export interface DraftUniqueInfo {
  uniqueColumns: Map<string, Set<string>>;
  compositeUniqueGroups: Map<string, string[][]>;
}

/** Relationship and uniqueness tests from yml and manifest together. */
export interface DbtTestIndex {
  relationshipTests: DraftRelationshipTest[];
  unique: DraftUniqueInfo;
}

export type DraftSkipReason = 'invalid-name' | 'not-found' | 'disabled' | 'duplicate' | 'already-in-domain' | 'over-limit';

export interface DraftSkipped {
  name: string;
  reason: DraftSkipReason;
  /** Human-readable detail (the name validator's message, for `invalid-name`). */
  message?: string;
}

export interface BuildDbtDraftInput {
  /** Names in the order the user should get them (truncation keeps the first ones). */
  modelNames: readonly string[];
  ymlData?: YmlData;
  manifest?: ManifestData;
  /** `target/catalog.json`, when `dbt docs generate` has run: the warehouse's column types. */
  catalog?: CatalogData;
  /** True when `logical-models/` already has this model — it is referenced, not re-created. */
  libraryHas: (name: string) => boolean;
  /** Seeds a new library model; defaults to {@link seedModelFromDbt}. */
  seed?: (name: string) => SemanticModel | undefined;
  /** Models already in the target domain (batch add): skipped as picks, but joined to by relationships. */
  existingModelNames?: readonly string[];
  /** Relationships already in the target domain, never emitted twice. */
  existingRelationships?: readonly DraftRelationshipTest[];
  /** Defaults to {@link DRAFT_MODEL_LIMIT}. */
  limit?: number;
}

export interface DbtDraft {
  /** Every accepted name, in order: what the domain's `logical.models` gains. */
  modelNames: string[];
  /** Library files to create (seeded from dbt). */
  newModels: SemanticModel[];
  /** Accepted names the library already has — only referenced. */
  reusedModels: string[];
  relationships: Relationship[];
  skipped: DraftSkipped[];
  /** True when more valid models were asked for than `limit` allows. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Model discovery and scopes
// ---------------------------------------------------------------------------

/** Folder names read as presentation, intermediate or staging (ordering and layer hints). */
const PRESENTATION_FOLDERS = new Set(['marts', 'mart', 'gold', 'reporting', 'reports', 'report', 'presentation', 'analytics', 'serving', 'consumption']);
const INTERMEDIATE_FOLDERS = new Set(['intermediate', 'int', 'silver', 'transform', 'transformed', 'curated', 'core']);
const STAGING_FOLDERS = new Set(['staging', 'stg', 'bronze', 'raw', 'base', 'source', 'sources', 'landing']);
const MEDALLION = ['bronze', 'silver', 'gold'];

/** 0 presentation, 1 intermediate, 2 unrecognised, 3 staging — first recognised segment wins. */
export function folderRank(folder: string): number {
  for (const seg of folder.toLowerCase().split('/').filter(Boolean)) {
    if (PRESENTATION_FOLDERS.has(seg)) { return 0; }
    if (INTERMEDIATE_FOLDERS.has(seg)) { return 1; }
    if (STAGING_FOLDERS.has(seg)) { return 3; }
  }
  return 2;
}

/**
 * The layer a folder suggests. Mirrors `suggestLayer()` in `src/cli/inventory.ts`
 * (kept local so this module does not depend on the CLI's context): a
 * bronze/silver/gold segment at any depth wins, then a first segment that is a
 * configured layer id, then dbt's convention (staging/intermediate → silver,
 * marts → gold). With `layerIds` given, only a configured layer is returned.
 */
export function suggestDraftLayer(folder: string, layerIds?: readonly string[]): string | undefined {
  const segments = folder.toLowerCase().split('/').filter(Boolean);
  let guess: string | undefined = segments.find((s) => MEDALLION.includes(s));
  if (!guess && segments[0]) {
    const first = segments[0];
    if (layerIds?.includes(first)) { guess = first; }
    else if (first === 'staging' || first === 'intermediate') { guess = 'silver'; }
    else if (first === 'marts') { guess = 'gold'; }
  }
  if (!guess) { return undefined; }
  return !layerIds || layerIds.includes(guess) ? guess : undefined;
}

/** Folder of a project-relative file under one of `modelPaths`, or null when it is under none. */
function folderUnder(rel: string, modelPaths: readonly string[]): string | null {
  const file = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const base of modelPaths) {
    const prefix = base.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') + '/';
    if (file.startsWith(prefix)) {
      const segments = file.slice(prefix.length).split('/');
      segments.pop();
      return segments.filter(Boolean).join('/');
    }
  }
  return null;
}

/**
 * Every model the draft can seed — the union of schema yml models and manifest
 * models (yml spelling first), minus the ones dbt has disabled. Two more are
 * left out:
 *  - a model with no columns to copy (only a `.sql` file, or a yml entry with
 *    no `columns:`), judged from the same source `seedModelFromDbt` copies —
 *    it would only draw an empty box;
 *  - a manifest model from an installed dbt package. Package files sit under
 *    `dbt_packages/`, which the yml walker skips, and their `original_file_path`
 *    is relative to the package root, so it would pass for the user's own
 *    `models/…` folder. The root project is the one whose models have a source
 *    file or schema yml in this project; with no yml data at all nothing can
 *    be told apart and every manifest model is kept.
 * Sorted by folder rank, folder, then name.
 */
export function listDraftModels(input: DraftSourceInput): DraftModelEntry[] {
  const { ymlData, manifest } = input;
  const disabled = manifest?.disabledModels ?? new Set<string>();
  const manifestByKey = new Map([...(manifest?.models ?? new Map()).values()].map((m) => [normaliseName(m.name), m]));

  // The dbt project(s) this project's own files belong to (see above).
  const ymlKeys = new Set([...(ymlData?.models.keys() ?? [])].map(normaliseName));
  const rootProjects = new Set<string>();
  for (const m of manifest?.models.values() ?? []) {
    const key = normaliseName(m.name);
    if (ymlData?.sourceFiles?.has(key) || ymlKeys.has(key)) { rootProjects.add(m.projectName); }
  }

  const byKey = new Map<string, DraftModelEntry>();
  const add = (name: string): void => {
    const key = normaliseName(name);
    if (byKey.has(key) || disabled.has(key)) { return; }
    const yml = ymlData?.models.get(name);
    const man = manifestByKey.get(key);
    if (!yml && man && rootProjects.size > 0 && !rootProjects.has(man.projectName)) { return; }
    // Same source seedModelFromDbt copies: the yml when there is one, else the manifest.
    const columnCount = yml ? yml.columns.length : man?.columns.length ?? 0;
    if (columnCount === 0) { return; }

    // Where the model lives: its source file, then the manifest's path, then the yml.
    let folder: string | null = null;
    const sourceFile = ymlData?.sourceFiles?.get(key);
    if (sourceFile) { folder = folderUnder(sourceFile, input.modelPaths); }
    if (folder === null && man?.originalFilePath) { folder = folderUnder(man.originalFilePath, input.modelPaths); }
    if (folder === null && yml?.filePath) {
      folder = folderUnder(path.relative(input.projectRoot, yml.filePath), input.modelPaths);
    }

    const entry: DraftModelEntry = {
      name,
      folder,
      description: yml?.description || man?.description || '',
    };
    const layer = folder === null ? undefined : suggestDraftLayer(folder, input.layerIds);
    if (layer) { entry.suggestedLayer = layer; }
    byKey.set(key, entry);
  };
  for (const name of ymlData?.models.keys() ?? []) { add(name); }
  for (const model of manifest?.models.values() ?? []) { add(model.name); }

  return [...byKey.values()].sort((a, b) =>
    folderRank(a.folder ?? '') - folderRank(b.folder ?? '')
    || (a.folder ?? '￿').localeCompare(b.folder ?? '￿')
    || a.name.localeCompare(b.name));
}

/** Relationship tests from yml and manifest (union, deduped case-insensitively) plus merged uniqueness tests. */
export function dbtTestsOf(ymlData?: YmlData, manifest?: ManifestData): DbtTestIndex {
  const seen = new Set<string>();
  const relationshipTests: DraftRelationshipTest[] = [];
  for (const t of [...(ymlData?.relationshipTests ?? []), ...(manifest?.relationshipTests ?? [])]) {
    const key = testKey(t);
    if (seen.has(key)) { continue; }
    seen.add(key);
    relationshipTests.push({ fromModel: t.fromModel, fromColumn: t.fromColumn, toModel: t.toModel, toColumn: t.toColumn });
  }
  return {
    relationshipTests,
    unique: {
      uniqueColumns: mergeUniqueMaps(ymlData?.uniqueColumns ?? new Map(), manifest?.uniqueColumns),
      compositeUniqueGroups: mergeCompositeGroups(ymlData?.compositeUniqueGroups ?? new Map(), manifest?.compositeUniqueGroups),
    },
  };
}

function testKey(t: DraftRelationshipTest): string {
  return [t.fromModel, t.fromColumn, t.toModel, t.toColumn].map(normaliseName).join('\0');
}

/** Order names most-connected first (edges within `names`), then by name. */
function byConnectedness(names: readonly string[], tests: readonly DraftRelationshipTest[]): string[] {
  const inScope = new Set(names.map(normaliseName));
  const degree = new Map<string, number>();
  for (const t of tests) {
    const from = normaliseName(t.fromModel);
    const to = normaliseName(t.toModel);
    if (from === to || !inScope.has(from) || !inScope.has(to)) { continue; }
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
  }
  return [...names].sort((a, b) =>
    (degree.get(normaliseName(b)) ?? 0) - (degree.get(normaliseName(a)) ?? 0) || a.localeCompare(b));
}

function plural(n: number): string {
  return `${n} model${n === 1 ? '' : 's'}`;
}

function detailOf(names: readonly string[]): string {
  const shown = names.slice(0, 4).join(', ');
  return names.length > 4 ? `${shown} and ${names.length - 4} more` : shown;
}

/** The layer most of `entries` suggest (ties broken by name), if any. */
function majorityLayer(entries: readonly DraftModelEntry[]): string | undefined {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (e.suggestedLayer) { counts.set(e.suggestedLayer, (counts.get(e.suggestedLayer) ?? 0) + 1); }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * The groups a user can draw in one pick: one per dbt model folder (models
 * directly in it, not in its sub-folders), presentation folders first
 * (marts/gold/reporting, then intermediate/silver, then anything else, then
 * staging/bronze), followed by the relationship-connected clusters that are
 * not already exactly a folder. Disabled models are excluded.
 */
export function listDraftScopes(input: DraftSourceInput): DraftScope[] {
  const models = listDraftModels(input);
  const tests = dbtTestsOf(input.ymlData, input.manifest).relationshipTests;

  const byFolder = new Map<string, DraftModelEntry[]>();
  for (const m of models) {
    if (m.folder === null) { continue; }
    byFolder.set(m.folder, [...(byFolder.get(m.folder) ?? []), m]);
  }

  const scopes: DraftScope[] = [...byFolder.entries()]
    .sort((a, b) => folderRank(a[0]) - folderRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([folder, entries]) => {
      const names = byConnectedness(entries.map((e) => e.name), tests);
      const scope: DraftScope = {
        id: `folder:${folder}`,
        kind: 'folder',
        label: folder === '' ? '(top-level models)' : folder,
        description: plural(names.length),
        detail: detailOf(names),
        modelNames: names,
        count: names.length,
        folder,
      };
      const layer = majorityLayer(entries);
      if (layer) { scope.suggestedLayer = layer; }
      return scope;
    });

  if (input.includeClusters !== false) {
    const folderSets = new Set(scopes.map((s) => s.modelNames.map(normaliseName).sort().join('\0')));
    for (const cluster of draftClusters(models, tests)) {
      const signature = cluster.map((e) => normaliseName(e.name)).sort().join('\0');
      if (folderSets.has(signature)) { continue; }
      const names = byConnectedness(cluster.map((e) => e.name), tests);
      const scope: DraftScope = {
        id: `cluster:${names[0]}`,
        kind: 'cluster',
        label: `Models connected to ${names[0]}`,
        description: plural(names.length),
        detail: detailOf(names),
        modelNames: names,
        count: names.length,
      };
      const layer = majorityLayer(cluster);
      if (layer) { scope.suggestedLayer = layer; }
      scopes.push(scope);
    }
  }
  return scopes;
}

/** Connected components of the relationship tests over `models`; components of one are omitted. Largest first. */
function draftClusters(models: readonly DraftModelEntry[], tests: readonly DraftRelationshipTest[]): DraftModelEntry[][] {
  const byKey = new Map(models.map((m) => [normaliseName(m.name), m]));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) { root = parent.get(root)!; }
    parent.set(x, root);
    return root;
  };
  for (const t of tests) {
    const a = normaliseName(t.fromModel);
    const b = normaliseName(t.toModel);
    if (!byKey.has(a) || !byKey.has(b)) { continue; }
    if (!parent.has(a)) { parent.set(a, a); }
    if (!parent.has(b)) { parent.set(b, b); }
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) { parent.set(ra, rb); }
  }
  const groups = new Map<string, DraftModelEntry[]>();
  for (const key of parent.keys()) {
    const root = find(key);
    groups.set(root, [...(groups.get(root) ?? []), byKey.get(key)!]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => a.name.localeCompare(b.name)))
    .sort((a, b) => b.length - a.length || a[0].name.localeCompare(b[0].name));
}

/** `scope` holding only `names` (count, description and detail recomputed). */
export function narrowDraftScope(scope: DraftScope, names: readonly string[]): DraftScope {
  if (names.length === scope.modelNames.length && names.every((n, i) => n === scope.modelNames[i])) { return scope; }
  return { ...scope, modelNames: [...names], count: names.length, description: plural(names.length), detail: detailOf(names) };
}

/** A scope for a hand-picked list (the picker's "Choose models…"). */
export function customDraftScope(modelNames: readonly string[], models: readonly DraftModelEntry[] = []): DraftScope {
  const wanted = new Set(modelNames.map(normaliseName));
  const scope: DraftScope = {
    id: 'custom',
    kind: 'custom',
    label: 'Chosen models',
    description: plural(modelNames.length),
    detail: detailOf(modelNames),
    modelNames: [...modelNames],
    count: modelNames.length,
  };
  const layer = majorityLayer(models.filter((m) => wanted.has(normaliseName(m.name))));
  if (layer) { scope.suggestedLayer = layer; }
  return scope;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * A logical model copied from dbt: the schema yml first (as
 * `LogicalModelService.ymlToSemanticModel` does), with the manifest filling a
 * missing description and the schema; the manifest alone when no yml declares
 * the model. Undefined when neither has it.
 *
 * Column names and order are the declared ones (yml, else manifest); the
 * catalog never adds or respells a column. Each TYPE resolves exactly as the
 * physical stage resolves it (`resolveColumnType`: catalog, then the declared
 * `data_type:`, then the manifest), and is empty when no source has one.
 */
export function seedModelFromDbt(
  name: string,
  ymlData?: YmlData,
  manifest?: ManifestData,
  catalog?: CatalogData,
): SemanticModel | undefined {
  const key = normaliseName(name);
  const yml = ymlData?.models.get(name)
    ?? [...(ymlData?.models.values() ?? [])].find((m) => normaliseName(m.name) === key);
  const man = manifest?.models.get(name)
    ?? [...(manifest?.models.values() ?? [])].find((m) => normaliseName(m.name) === key);
  if (!yml && !man) { return undefined; }

  const manifestColumns = new Map((man?.columns ?? []).map((c) => [normaliseName(c.name), c]));
  const observedColumns = new Map<string, CatalogColumn>();
  for (const cc of catalogNodeFor(catalog, man, key)?.columns ?? []) {
    // First wins, as on the physical stage.
    if (!observedColumns.has(normaliseName(cc.name))) { observedColumns.set(normaliseName(cc.name), cc); }
  }
  const typeOf = (columnName: string, declared: string | null | undefined): string =>
    resolveColumnType(
      observedColumns.get(normaliseName(columnName))?.dataType,
      declared,
      manifestColumns.get(normaliseName(columnName))?.data_type,
    ).dataType;
  const columns: ColumnDef[] = yml
    ? yml.columns.map((col) => {
      const mc = manifestColumns.get(normaliseName(col.name));
      return {
        name: col.name,
        dataType: typeOf(col.name, col.dataType),
        description: col.description || mc?.description || '',
      };
    })
    : man!.columns.map((col) => ({
      name: col.name,
      dataType: typeOf(col.name, col.data_type),
      description: col.description ?? '',
    }));

  const model: SemanticModel = { name: yml?.name ?? man!.name };
  if (man?.schema) { model.schema = man.schema; }
  model.description = yml?.description || man?.description || '';
  model.columns = columns;
  return model;
}

/**
 * Key flags for a seeded model, from what dbt tests today: a column is the
 * primary key when it is the model's ONLY column with a standalone `unique`
 * test (and no composite key is declared); a column is a foreign key when a
 * draft relationship leaves from it. Returns a new model; existing flags win.
 */
export function markDraftKeys(
  model: SemanticModel,
  unique: DraftUniqueInfo,
  relationships: readonly Relationship[],
): SemanticModel {
  const key = normaliseName(model.name);
  const uniqueCols = new Set<string>();
  let hasComposite = false;
  for (const [m, cols] of unique.uniqueColumns) {
    if (normaliseName(m) === key) { for (const c of cols) { uniqueCols.add(normaliseName(c)); } }
  }
  for (const [m, groups] of unique.compositeUniqueGroups) {
    if (normaliseName(m) === key && groups.length > 0) { hasComposite = true; }
  }
  const pk = !hasComposite && uniqueCols.size === 1 ? [...uniqueCols][0] : undefined;
  const fks = new Set(relationships
    .map((r) => canonicalRelationship(r))
    .filter((r) => normaliseName(r.fromModel) === key)
    .map((r) => normaliseName(r.fromColumn)));

  return {
    ...model,
    columns: (model.columns ?? []).map((c) => {
      const col = { ...c };
      const name = normaliseName(c.name);
      if (pk === name && col.isPrimaryKey === undefined) { col.isPrimaryKey = true; }
      // A key is never flagged a foreign key here: it would turn later drags round.
      if (fks.has(name) && col.isForeignKey === undefined && !col.isPrimaryKey) { col.isForeignKey = true; }
      return col;
    }),
  };
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

/**
 * Logical relationships for models being added to a domain: every
 * relationship test between an added model and any model that will be in the
 * domain (existing or added), deduped against the domain's relationships.
 *
 * Cardinality comes from `derivePhysicalRelationships()` (the physical stage's
 * inference from `unique` / `unique_combination_of_columns` tests), so a test
 * declared on the dimension reads as `one-to-many` and is stored on the fact
 * (`canonicalRelationship`, #133). It is then narrowed: both ends unique is
 * `one-to-one`, anything else `many-to-one` (the test names the "one" side).
 * Endpoints use the spelling of the names passed in.
 */
export function relationshipsForAddedModels(
  existingNamesInDomain: readonly string[],
  addedNames: readonly string[],
  tests: readonly DraftRelationshipTest[],
  uniqueInfo: DraftUniqueInfo,
  existingRelationships: readonly DraftRelationshipTest[] = [],
): Relationship[] {
  const added = new Set(addedNames.map(normaliseName));
  const domainNames = new Set<string>([...existingNamesInDomain, ...addedNames]);
  const seen = new Set(existingRelationships.map(linkKey));

  const derived = derivePhysicalRelationships(
    [...tests],
    domainNames,
    uniqueInfo.uniqueColumns,
    uniqueInfo.compositeUniqueGroups,
  );

  const out: Relationship[] = [];
  for (const rel of derived) {
    if (!added.has(normaliseName(rel.fromModel)) && !added.has(normaliseName(rel.toModel))) { continue; }
    const key = linkKey(rel);
    if (seen.has(key)) { continue; }
    seen.add(key);
    const { fromModel, fromColumn, toModel, toColumn, cardinality } = canonicalRelationship(rel);
    out.push({
      fromModel, fromColumn, toModel, toColumn,
      cardinality: cardinality === 'one-to-one' ? 'one-to-one' : 'many-to-one',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

/**
 * Turn a pick into what to write: the library files to create, the names to
 * reference, the relationships, and what was left out and why. Names are
 * checked with the path-safety rule only (dbt names may be uppercase), are
 * deduped case-insensitively, and are cut to `limit` in the order given.
 */
export function buildDbtDraft(input: BuildDbtDraftInput): DbtDraft {
  const limit = input.limit ?? DRAFT_MODEL_LIMIT;
  const seed = input.seed ?? ((name: string) => seedModelFromDbt(name, input.ymlData, input.manifest, input.catalog));
  const disabled = input.manifest?.disabledModels ?? new Set<string>();
  const inDomain = new Set((input.existingModelNames ?? []).map(normaliseName));

  const skipped: DraftSkipped[] = [];
  const seen = new Set<string>();
  const accepted: Array<{ name: string; model?: SemanticModel }> = [];
  let truncated = false;

  for (const raw of input.modelNames) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    const safety = validateModelNameSafety(name);
    if (safety) { skipped.push({ name: String(raw), reason: 'invalid-name', message: safety }); continue; }
    const key = normaliseName(name);
    if (seen.has(key)) { skipped.push({ name, reason: 'duplicate' }); continue; }
    seen.add(key);
    if (inDomain.has(key)) { skipped.push({ name, reason: 'already-in-domain' }); continue; }
    if (disabled.has(key)) { skipped.push({ name, reason: 'disabled' }); continue; }

    let model: SemanticModel | undefined;
    if (!input.libraryHas(name)) {
      model = seed(name);
      if (!model) { skipped.push({ name, reason: 'not-found' }); continue; }
    }
    if (accepted.length >= limit) {
      truncated = true;
      skipped.push({ name, reason: 'over-limit' });
      continue;
    }
    accepted.push({ name, model });
  }

  const modelNames = accepted.map((a) => a.name);
  const tests = dbtTestsOf(input.ymlData, input.manifest);
  const relationships = relationshipsForAddedModels(
    input.existingModelNames ?? [],
    modelNames,
    tests.relationshipTests,
    tests.unique,
    input.existingRelationships ?? [],
  );

  return {
    modelNames,
    newModels: accepted
      .filter((a) => a.model)
      .map((a) => markDraftKeys({ ...a.model!, name: a.name }, tests.unique, relationships)),
    reusedModels: accepted.filter((a) => !a.model).map((a) => a.name),
    relationships,
    skipped,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// The domain file
// ---------------------------------------------------------------------------

export interface DraftDomainDocument {
  schemaVersion: number;
  domain: string;
  layer: string;
  description: string;
  modelFolder?: string;
  logical: { models: string[]; relationships: Relationship[] };
  viewConfig: Record<string, never>;
}

/**
 * A v5 domain document, in the key order `erdStudio.createDomain` writes.
 * `viewConfig` is empty on purpose: a domain with models and no positions is
 * a fresh layout (`isFreshLayout`), which the canvas auto-lays out on first open.
 */
export function buildDraftDomainDocument(input: {
  domain: string;
  layer: string;
  description?: string;
  modelNames: readonly string[];
  relationships: readonly Relationship[];
  modelFolder?: string;
}): DraftDomainDocument {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    domain: input.domain,
    layer: input.layer,
    description: (input.description ?? '').trim(),
    ...(input.modelFolder ? { modelFolder: input.modelFolder } : {}),
    logical: {
      models: [...input.modelNames],
      relationships: input.relationships.map((r) => ({ ...r })),
    },
    viewConfig: {},
  };
}

/** The file text, formatted as `createDomain` writes it. */
export function serializeDraftDomainDocument(doc: DraftDomainDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/** Domain slug rule — the one `validateDomainSlug` in extension.ts enforces. */
export const DOMAIN_SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const DOMAIN_SLUG_MAX = 64;

/** Turn free text into a domain slug, or '' when nothing usable is left. */
export function toDomainSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, DOMAIN_SLUG_MAX)
    .replace(/[-_]+$/, '');
  return DOMAIN_SLUG_PATTERN.test(slug) ? slug : '';
}

/** Common model-name prefixes stripped when a cluster is named after its hub. */
const MODEL_PREFIX = /^(dim|fct|fact|stg|int|obt|hub|lnk|sat|mart|rpt)_/;

/**
 * A domain name for a scope: the folder's last segment (`marts/finance` →
 * `finance`), a cluster's hub without its prefix (`dim_customer` →
 * `customer`), else `dbt-draft`. With `taken` (domain names already in the
 * target layer) a `-2`, `-3`… suffix keeps it free.
 */
export function suggestDomainName(scope: DraftScope | undefined, taken: Iterable<string> = []): string {
  let base = '';
  if (scope?.kind === 'folder' && scope.folder) {
    const segments = scope.folder.split('/').filter(Boolean);
    base = toDomainSlug(segments[segments.length - 1] ?? '');
  } else if (scope?.kind === 'cluster' && scope.modelNames[0]) {
    base = toDomainSlug(scope.modelNames[0].toLowerCase().replace(MODEL_PREFIX, ''));
  }
  if (!base) { base = 'dbt-draft'; }

  const used = new Set(taken);
  if (!used.has(base)) { return base; }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = base.slice(0, DOMAIN_SLUG_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) { return candidate; }
  }
}
