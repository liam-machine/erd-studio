/**
 * Import from dbt — seed a LOGICAL draft domain from what the dbt project
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
 * `applySubjectAreaEdit`, or a `wx` create for a new domain file). This module is
 * reachable from `dist/cli.js`, so it must never import `vscode`.
 */

import * as path from 'path';

import { createLedger, type LedgerEntry } from './importLedger';

import { canonicalRelationship, linkKey, toTableNamingDocument } from '@erd-studio/core';
import { WRITTEN_SCHEMA_VERSION } from '../types/semantic';
import type { ColumnDef, Relationship, SemanticTable } from '../types/semantic';
import type { RelationshipTestCondition, YmlData, YmlSourceTable } from '../types/ymlData';
import type { ManifestData } from '../types/manifest';
import type { CatalogColumn, CatalogData } from '../types/catalog';
import type { DbmlDraftTable } from './dbmlLibraryWrites';
import { validateTableNameSafety } from '../providers/payloadValidation';
import { derivePhysicalRelationships, mergeCompositeGroups, mergeUniqueMaps } from './domainService';
import { identifierKey, normaliseName } from './nameUtils';
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
  /** Every test of this link holds only for some rows (`relationships_where`, a `where:` config): the condition is not kept. */
  conditional?: true;
  /** A conditional link's conditions as written, one per test that has one (deduped). */
  conditions?: RelationshipTestCondition[];
  /** Where its first test is written (a schema yml), when known. */
  file?: string;
  line?: number;
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

export type DraftSkipReason =
  | 'invalid-name' | 'not-found' | 'disabled' | 'duplicate' | 'already-in-domain' | 'over-limit'
  /** A DBML diagram: the library has the table as YAML, which a `use` line cannot import (D20). */
  | 'yaml-table';

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
  /** Seeds a new library model; defaults to {@link seedTableFromDbt}. */
  seed?: (name: string) => SemanticTable | undefined;
  /** Models already in the target domain (batch add): skipped as picks, but joined to by relationships. */
  existingModelNames?: readonly string[];
  /** Relationships already in the target domain, never emitted twice. */
  existingRelationships?: readonly DraftRelationshipTest[];
  /** Defaults to {@link DRAFT_MODEL_LIMIT}. */
  limit?: number;
  /**
   * Leave out models dbt has disabled (default true). False for an explicit
   * pick from the Add Existing Model dialog, which lists them and adds one on
   * its own regardless.
   */
  skipDisabled?: boolean;
  /**
   * The draft is for a DBML diagram (native DBML storage, §5.7): a library
   * table stored as YAML is skipped (`yaml-table`, D20). Each new table
   * carries its dbt custom schema as `configuredSchema` ({@link configuredSchemaOf}),
   * which picks its schema folder (§2.4).
   */
  dbml?: { tableStorage(name: string): 'yaml' | 'dbml' | undefined };
}

export interface DbtDraft {
  /** Every accepted name, in order: what the domain's `logical.models` gains. */
  modelNames: string[];
  /** Library files to create (seeded from dbt); for a DBML diagram each with its `configuredSchema`, when it has one. */
  newModels: DbmlDraftTable[];
  /** Accepted names the library already has — only referenced. */
  reusedModels: string[];
  relationships: Relationship[];
  skipped: DraftSkipped[];
  /** True when more valid models were asked for than `limit` allows. */
  truncated: boolean;
  /**
   * What the draft changed or could not keep (`importLedger.ts`): rendered
   * into the draft's Notes and Not drawn (`draftFromDbt`). [] when every
   * model, column and relationship came across as dbt has it. It holds a
   * `skipped` entry per {@link undrawnLinks} link, a `lost` entry per drawn
   * relationship whose test's condition is not kept, and (a DBML diagram) the
   * D18 `savedOptional` count of required relationships.
   */
  ledger: LedgerEntry[];
  /**
   * Relationship tests from a drawn model to one this draft does not draw,
   * each once (`person.location_id → location`): listed in Not drawn, and
   * drawn when that model is added (Add Existing Model's batch add finds the
   * same test). `why`: `addable` (a model with columns, outside the scope or
   * over the limit), `noColumns` (dbt declares no columns for it) or
   * `notAModel` (no model by that name: a package's, or a typo) or `source`
   * (`to: source('raw', 'customers')`: `toModel` is `raw.customers`).
   */
  undrawnLinks?: DraftUndrawnLink[];
  /** Relationships whose foreign-key columns dbt tests `not_null` (all of them): required in the source. */
  requiredRelationships?: number;
  /**
   * Drawn relationships every test of which holds only for some rows
   * (`relationships_where`, a `where:` config), with the conditions as
   * written: the draft lists each under Relationships, since the diagram
   * draws the link for every row and keeps no condition.
   */
  relationshipConditions?: DraftRelationshipCondition[];
  /**
   * The project's dbt sources (`sources:` tables, from the yml, else the
   * manifest), never drawn: a source is a table dbt reads but does not
   * build, so it has no model for the Physical tab, a selector or Sync to
   * match. Not drawn names them (`DbtDraft.ledger` records each, with its file and line).
   */
  sources?: DraftSourceTable[];
}

/** A drawn relationship that dbt tests only for some rows (see {@link DbtDraft.relationshipConditions}). */
export interface DraftRelationshipCondition {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  conditions: RelationshipTestCondition[];
}

/** One dbt source table (see {@link DbtDraft.sources}). */
export interface DraftSourceTable {
  /** `raw.customers`: the source and table names a `source()` call uses. */
  name: string;
  /** The warehouse table, when `identifier:` differs from the name. */
  identifier?: string;
  columns: number;
  file?: string;
  line?: number;
}

/** A relationship test that leaves the draft (see {@link DbtDraft.undrawnLinks}). */
export interface DraftUndrawnLink {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  /**
   * `package`: a model of an installed dbt package (no draft offers one);
   * `disabled`: a model dbt has disabled.
   */
  why: 'addable' | 'noColumns' | 'notAModel' | 'source' | 'package' | 'disabled' | 'noColumn';
  /** `noColumn`: the end whose table has no such column (a test of an older model version's column, a stale manifest). */
  missing?: { table: string; column: string };
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
 *  - a model with no declared columns (only a `.sql` file, or a yml entry
 *    with no `columns:`), judged from the declared list `seedTableFromDbt`
 *    starts from (yml, else manifest) — it would only draw an empty box, or
 *    one shaped by a catalog that may be weeks old. The catalog adds columns
 *    to a model that is drawn; it never makes a model drawable;
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
  const disabled = disabledModelsOf(ymlData, manifest);
  const manifestByKey = new Map([...(manifest?.models ?? new Map()).values()].map((m) => [normaliseName(m.name), m]));

  // The dbt project(s) this project's own files belong to (see above).
  const rootProjects = rootProjectsOf(ymlData, manifest);

  const byKey = new Map<string, DraftModelEntry>();
  const add = (name: string): void => {
    const key = normaliseName(name);
    if (byKey.has(key) || disabled.has(key)) { return; }
    const yml = ymlData?.models.get(name);
    const man = manifestByKey.get(key);
    if (!yml && man && rootProjects.size > 0 && !rootProjects.has(man.projectName)) { return; }
    // The declared list seedTableFromDbt starts from: the yml when there is one, else the manifest.
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

/**
 * The dbt projects the open project's own models belong to: those of the
 * manifest models that have a source file or a schema yml entry here. A
 * manifest model of any other project is an installed package's. Empty when
 * nothing can tell them apart (no yml data, or no manifest).
 */
export function rootProjectsOf(ymlData?: YmlData, manifest?: ManifestData): Set<string> {
  const ymlKeys = new Set([...(ymlData?.models.keys() ?? [])].map(normaliseName));
  const rootProjects = new Set<string>();
  for (const m of manifest?.models.values() ?? []) {
    const key = normaliseName(m.name);
    if (ymlData?.sourceFiles?.has(key) || ymlKeys.has(key)) { rootProjects.add(m.projectName); }
  }
  return rootProjects;
}

/**
 * Normalised names of the models dbt does not build: the manifest's
 * `disabled` (a `config(enabled=false)`, a `+enabled: false` subtree), and a
 * schema yml entry with `config: enabled: false` (seen without a manifest).
 * A model the manifest builds (one of its enabled nodes) is never disabled
 * by its yml: the SQL file's `config(enabled=true)` overrides the yml, and
 * only the manifest has seen both.
 */
export function disabledModelsOf(ymlData?: YmlData, manifest?: ManifestData): Set<string> {
  const out = new Set(manifest?.disabledModels ?? []);
  const built = new Set([...(manifest?.models.values() ?? [])].map((m) => normaliseName(m.name)));
  for (const m of ymlData?.models.values() ?? []) {
    const key = normaliseName(m.name);
    if (m.disabled && !built.has(key)) out.add(key);
  }
  return out;
}

/** Relationship tests from yml and manifest (union, deduped case-insensitively) plus merged uniqueness tests. */
export function dbtTestsOf(ymlData?: YmlData, manifest?: ManifestData): DbtTestIndex {
  const conditionKey = (c: RelationshipTestCondition): string => [c.from ?? '', c.to ?? '', c.where ?? ''].join('\0');
  const addCondition = (test: DraftRelationshipTest, c: RelationshipTestCondition | undefined): void => {
    if (c && !(test.conditions ?? []).some((x) => conditionKey(x) === conditionKey(c))) test.conditions = [...(test.conditions ?? []), c];
  };
  // Within one source, one unconditional test of the link is enough: it holds for every row.
  const index = (tests: ReadonlyArray<DraftRelationshipTest & { condition?: RelationshipTestCondition }>): Map<string, DraftRelationshipTest> => {
    const seen = new Map<string, DraftRelationshipTest>();
    for (const t of tests) {
      const key = testKey(t);
      const conditional = t.conditional === true;
      const earlier = seen.get(key);
      if (earlier) {
        if (!conditional) { delete earlier.conditional; delete earlier.conditions; }
        else if (earlier.conditional) addCondition(earlier, t.condition);
        if (earlier.file === undefined && t.file) { earlier.file = t.file; if (t.line !== undefined) earlier.line = t.line; }
        continue;
      }
      seen.set(key, {
        fromModel: t.fromModel, fromColumn: t.fromColumn, toModel: t.toModel, toColumn: t.toColumn,
        ...(conditional ? { conditional: true as const } : {}),
        ...(conditional && t.condition ? { conditions: [t.condition] } : {}),
        ...(t.file ? { file: t.file } : {}),
        ...(t.file && t.line !== undefined ? { line: t.line } : {}),
      });
    }
    return seen;
  };
  // The yml and the manifest are two copies of the same tests, not more tests: a link is
  // conditional when either copy says every test of it is. The manifest applies config the
  // yml does not show (dbt_project.yml's `tests: +where:`); the yml may be newer than a
  // stale manifest. Saying a condition that only one copy has is never a loss.
  const relationshipTests: DraftRelationshipTest[] = [];
  const byKey = new Map<string, DraftRelationshipTest>();
  for (const copy of [index(ymlData?.relationshipTests ?? []), index(manifest?.relationshipTests ?? [])]) {
    for (const [key, t] of copy) {
      const earlier = byKey.get(key);
      if (!earlier) { byKey.set(key, t); relationshipTests.push(t); continue; }
      if (t.conditional) {
        if (!earlier.conditional) { earlier.conditional = true; delete earlier.conditions; }
        for (const c of t.conditions ?? []) addCondition(earlier, c);
      }
      if (earlier.file === undefined && t.file) { earlier.file = t.file; if (t.line !== undefined) earlier.line = t.line; }
    }
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
  return [t.fromModel, t.fromColumn, t.toModel, t.toColumn].map(identifierKey).join('\0');
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

/**
 * The picker's "Choose models…" description: how many the user may pick, and
 * of how many — never "pick up to 15 of 9" when there are fewer than the
 * limit (then every one of them can be picked).
 */
export function chooseModelsDescription(limit: number, total: number): string {
  if (total <= limit) return `choose from ${total} ${total === 1 ? 'model' : 'models'}`;
  return `pick up to ${limit} of ${total}`;
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
 * `TableLibraryService.ymlToSemanticTable` does), with the manifest filling a
 * missing description and the schema; the manifest alone when no yml declares
 * the model. Undefined when neither has it.
 *
 * COLUMNS are the ones the Physical tab shows for the model, so a freshly
 * drawn table opens with nothing to compare: the declared columns first, in
 * declared order and spelling (yml, else manifest), then every column only the
 * catalog reports, in catalog (warehouse) order. A catalog-only name reported
 * ALL CAPS is the warehouse folding an unquoted identifier (Snowflake's
 * `LOADED_AT`) and is lowercased; a mixed- or lower-case name is kept as
 * reported. Comparison keys on `normaliseName`, so the spelling and the order
 * (the Physical tab lists catalog order first) never make a difference. Each
 * TYPE resolves exactly as the physical stage resolves it
 * (`resolveColumnType`: catalog, then the declared `data_type:`, then the
 * manifest), and is empty when no source has one; a catalog-only column's
 * description is its warehouse comment, as on the Physical tab. A model with
 * no declared columns gets none from the catalog either (an empty table, as
 * Add Existing Model gives it; Import from dbt does not list it at all).
 * `seededColumnCount` counts the same columns without building the table.
 */
export function seedTableFromDbt(
  name: string,
  ymlData?: YmlData,
  manifest?: ManifestData,
  catalog?: CatalogData,
): SemanticTable | undefined {
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
  // dbt's `not_null` tests: kept on the column as `meta.dbml.not_null` (as Import DBML keeps DBML's, D19).
  const required = notNullColumnsOf(ymlData, yml?.name ?? man!.name, manifest);
  const withNotNull = (column: ColumnDef): ColumnDef =>
    (required.has(identifierKey(column.name)) ? { ...column, meta: { dbml: { not_null: true } } } : column);
  const columns: ColumnDef[] = (yml
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
    }))).map(withNotNull);
  // Then what only the warehouse has, in its order (the Physical tab shows
  // these too). Only for a model that declares columns: a catalog that may be
  // weeks old never shapes a table dbt declares nothing for.
  const declared = new Set(columns.map((c) => normaliseName(c.name)));
  for (const [ck, cc] of columns.length === 0 ? [] : observedColumns) {
    if (declared.has(ck) || !cc.name.trim()) { continue; }
    columns.push({
      name: catalogColumnName(cc.name),
      dataType: typeOf(cc.name, undefined),
      description: cc.comment ?? '',
    });
  }

  const model: SemanticTable = { name: yml?.name ?? man!.name };
  if (man?.schema) { model.schema = man.schema; }
  model.description = yml?.description || man?.description || '';
  model.columns = columns;
  return model;
}

/**
 * The columns dbt declares required on `model`: `YmlData.notNullColumns`
 * and the manifest's (`ManifestData.notNullColumns`: its test nodes and
 * contract constraints), keyed by {@link identifierKey} (a test passes a
 * `quote: true` column quoted).
 */
export function notNullColumnsOf(ymlData: YmlData | undefined, model: string, manifest?: ManifestData): Set<string> {
  const out = new Set<string>();
  const key = normaliseName(model);
  for (const byModel of [ymlData?.notNullColumns, manifest?.notNullColumns]) {
    for (const [m, cols] of byModel ?? []) {
      if (normaliseName(m) === key) { for (const c of cols) { out.add(identifierKey(c)); } }
    }
  }
  return out;
}

/**
 * The project's dbt sources, from the schema yml (with file and line), then
 * any only the manifest lists (but not an installed package's); one per
 * `source.table`, ignoring case.
 */
export function dbtSourcesOf(ymlData?: YmlData, manifest?: ManifestData): DraftSourceTable[] {
  const out = new Map<string, DraftSourceTable>();
  const add = (t: YmlSourceTable): void => {
    const name = `${t.source}.${t.name}`;
    const key = normaliseName(name);
    if (out.has(key)) return;
    out.set(key, {
      name,
      ...(t.identifier ? { identifier: t.identifier } : {}),
      columns: t.columns.length,
      ...(t.file ? { file: t.file } : {}),
      ...(t.line !== undefined ? { line: t.line } : {}),
    });
  };
  // An installed package's sources (`dbt_packages/`) are not this project's: its file is not here either.
  const rootProjects = rootProjectsOf(ymlData, manifest);
  const ours = (t: YmlSourceTable): boolean => !t.projectName || rootProjects.size === 0 || rootProjects.has(t.projectName);
  for (const t of ymlData?.sources ?? []) add(t);
  for (const t of manifest?.sources ?? []) if (ours(t)) add(t);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The project's models a draft can never draw because dbt declares no
 * columns for them (no `columns:` in a schema yml, and none in the
 * manifest): `listDraftModels` leaves them out, so no folder offers them.
 * The draft names them (`3 models have no columns in your schema yml, so
 * they can't be drawn`). Disabled models and other packages' models are not counted.
 */
export function modelsWithoutColumns(input: Pick<DraftSourceInput, 'ymlData' | 'manifest' | 'modelPaths'>): string[] {
  const { ymlData, manifest } = input;
  const disabled = disabledModelsOf(ymlData, manifest);
  const ymlKeys = new Set([...(ymlData?.models.keys() ?? [])].map(normaliseName));
  const rootProjects = rootProjectsOf(ymlData, manifest);
  const manifestByKey = new Map([...(manifest?.models.values() ?? [])].map((m) => [normaliseName(m.name), m]));
  const out = new Map<string, string>();
  const consider = (name: string): void => {
    const key = normaliseName(name);
    if (out.has(key) || disabled.has(key)) { return; }
    const yml = ymlData?.models.get(name) ?? [...(ymlData?.models.values() ?? [])].find((m) => normaliseName(m.name) === key);
    const man = manifestByKey.get(key);
    if (!yml && man && rootProjects.size > 0 && !rootProjects.has(man.projectName)) { return; }
    const columns = yml ? yml.columns.length : man?.columns.length ?? 0;
    if (columns === 0) { out.set(key, name); }
  };
  for (const name of ymlData?.models.keys() ?? []) { consider(name); }
  for (const m of manifest?.models.values() ?? []) { consider(m.name); }
  // A model with only a .sql file under model-paths (no yml entry, no manifest): the source files know it.
  if (!manifest) {
    for (const [stem, file] of ymlData?.sourceFiles ?? []) {
      if (!/\.(sql|py)$/i.test(file) || out.has(stem) || ymlKeys.has(stem) || folderUnder(file, input.modelPaths) === null) { continue; }
      out.set(stem, path.basename(file).replace(/\.(sql|py)$/i, ''));
    }
  }
  return [...out.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * How many columns `seedTableFromDbt` gives a model whose declared columns
 * (yml, else manifest) are `declared`: those, plus each column only the
 * catalog reports, and none from the catalog when nothing is declared. For
 * the Add Existing Model dialog's column count, which is built on every
 * refresh, so it does not build the table.
 */
export function seededColumnCount(
  name: string,
  declared: ReadonlyArray<{ name: string }>,
  manifestModel: { uniqueId: string } | undefined,
  catalog: CatalogData | undefined,
): number {
  if (declared.length === 0) { return 0; }
  const seen = new Set(declared.map((c) => normaliseName(c.name)));
  let count = declared.length;
  for (const cc of catalogNodeFor(catalog, manifestModel, normaliseName(name))?.columns ?? []) {
    const ck = normaliseName(cc.name);
    if (seen.has(ck) || !cc.name.trim()) { continue; }
    seen.add(ck);
    count++;
  }
  return count;
}

/**
 * A catalog-only column's name for the logical model: an ALL-CAPS name (the
 * warehouse folding an unquoted identifier, as Snowflake does) lowercased, any
 * other spelling kept as the warehouse reports it. `LOADED_AT` → `loaded_at`;
 * `LoadedAt` and `loaded_at` unchanged.
 */
export function catalogColumnName(name: string): string {
  return name === name.toUpperCase() && name !== name.toLowerCase() ? name.toLowerCase() : name;
}

/**
 * The schema a dbt model's developer configured (§2.4, `configuredSchema`):
 * the manifest node's `config.schema` (from `+schema:` or
 * `config(schema=…)`) when the manifest lists the model, else the schema yml
 * model's `config: schema:`, which is what dbt compiles it from. Never the schema the model is built in
 * (`dbt_liam_finance` in dev, `finance` in prod), which differs per machine:
 * a model with no custom schema has none, and goes in its layer's schema.
 */
export function configuredSchemaOf(name: string, ymlData?: YmlData, manifest?: ManifestData): string | undefined {
  const key = normaliseName(name);
  const man = manifest?.models.get(name)
    ?? [...(manifest?.models.values() ?? [])].find((m) => normaliseName(m.name) === key);
  const yml = ymlData?.models.get(name)
    ?? [...(ymlData?.models.values() ?? [])].find((m) => normaliseName(m.name) === key);
  // The manifest is dbt's own resolution (yml, dbt_project.yml and config() merged): the yml only without it.
  return man ? man.configSchema : yml?.configSchema;
}

/**
 * Key flags for a seeded model, from what dbt tests today: a column is the
 * primary key when it is the model's ONLY column with a standalone `unique`
 * test (and no composite key is declared); a column is a foreign key when a
 * draft relationship leaves from it. Returns a new model; existing flags win.
 */
export function markDraftKeys(
  model: SemanticTable,
  unique: DraftUniqueInfo,
  relationships: readonly Relationship[],
): SemanticTable {
  const key = normaliseName(model.name);
  const uniqueCols = new Set<string>();
  let hasComposite = false;
  for (const [m, cols] of unique.uniqueColumns) {
    if (normaliseName(m) === key) { for (const c of cols) { uniqueCols.add(identifierKey(c)); } }
  }
  for (const [m, groups] of unique.compositeUniqueGroups) {
    if (normaliseName(m) === key && groups.length > 0) { hasComposite = true; }
  }
  const pk = !hasComposite && uniqueCols.size === 1 ? [...uniqueCols][0] : undefined;
  const fks = new Set(relationships
    .map((r) => canonicalRelationship(r))
    .filter((r) => normaliseName(r.fromModel) === key)
    .map((r) => identifierKey(r.fromColumn)));

  return {
    ...model,
    columns: (model.columns ?? []).map((c) => {
      const col = { ...c };
      const name = identifierKey(c.name);
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
export function relationshipsForAddedTables(
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
  const seed = input.seed ?? ((name: string) => seedTableFromDbt(name, input.ymlData, input.manifest, input.catalog));
  const disabled = input.skipDisabled === false ? new Set<string>() : disabledModelsOf(input.ymlData, input.manifest);
  const inDomain = new Set((input.existingModelNames ?? []).map(normaliseName));

  const skipped: DraftSkipped[] = [];
  const seen = new Set<string>();
  const accepted: Array<{ name: string; model?: SemanticTable }> = [];
  let truncated = false;

  for (const raw of input.modelNames) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    const safety = validateTableNameSafety(name);
    if (safety) { skipped.push({ name: String(raw), reason: 'invalid-name', message: safety }); continue; }
    const key = normaliseName(name);
    if (seen.has(key)) { skipped.push({ name, reason: 'duplicate' }); continue; }
    seen.add(key);
    if (inDomain.has(key)) { skipped.push({ name, reason: 'already-in-domain' }); continue; }
    if (disabled.has(key)) { skipped.push({ name, reason: 'disabled' }); continue; }

    let model: SemanticTable | undefined;
    const inLibrary = input.libraryHas(name);
    if (input.dbml && inLibrary && input.dbml.tableStorage(name) === 'yaml') { skipped.push({ name, reason: 'yaml-table' }); continue; }
    if (!inLibrary) {
      model = seed(name);
      if (!model) { skipped.push({ name, reason: 'not-found' }); continue; }
      const configuredSchema = input.dbml ? configuredSchemaOf(name, input.ymlData, input.manifest) : undefined;
      if (configuredSchema !== undefined) model = { ...model, configuredSchema } as DbmlDraftTable;
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
  // A test names a column as dbt passes it (`"Order Id"` for a `quote: true` column): each end
  // takes the spelling of the column the new table has, so the line joins a column that exists.
  const columnSpelling = new Map<string, string>();
  for (const a of accepted) {
    for (const c of a.model?.columns ?? []) columnSpelling.set(`${normaliseName(a.name)}\0${identifierKey(c.name)}`, c.name);
  }
  const spelled = (model: string, column: string): string => columnSpelling.get(`${normaliseName(model)}\0${identifierKey(column)}`) ?? column;
  // A new table whose columns are known has no column the test names (a test of an
  // older model version's column, a stale manifest): the line would join nothing.
  const seededModels = new Set(accepted.filter((a) => a.model).map((a) => normaliseName(a.name)));
  const lacks = (model: string, column: string): boolean =>
    seededModels.has(normaliseName(model)) && !columnSpelling.has(`${normaliseName(model)}\0${identifierKey(column)}`);
  const missingColumn: Relationship[] = [];
  const relationships = relationshipsForAddedTables(
    input.existingModelNames ?? [],
    modelNames,
    tests.relationshipTests,
    tests.unique,
    input.existingRelationships ?? [],
  ).filter((r) => {
    if (!lacks(r.fromModel, r.fromColumn) && !lacks(r.toModel, r.toColumn)) return true;
    missingColumn.push(r);
    return false;
  }).map((r) => ({ ...r, fromColumn: spelled(r.fromModel, r.fromColumn), toColumn: spelled(r.toModel, r.toColumn) }));

  const ledger = createLedger();
  const drawn = new Set([...(input.existingModelNames ?? []), ...modelNames].map(normaliseName));
  const added = new Set(modelNames.map(normaliseName));

  // Tests from a drawn model to one the draft does not draw: named, never dropped without a word (B2).
  const knownModels = new Map<string, number>();
  const packageModels = new Set<string>();
  const rootProjects = rootProjectsOf(input.ymlData, input.manifest);
  const projectDisabled = disabledModelsOf(input.ymlData, input.manifest);
  for (const m of input.ymlData?.models.values() ?? []) { knownModels.set(normaliseName(m.name), Math.max(knownModels.get(normaliseName(m.name)) ?? 0, m.columns.length)); }
  for (const m of input.manifest?.models.values() ?? []) {
    const key = normaliseName(m.name);
    // Another dbt project's model (an installed package's): no draft offers it.
    if (!input.ymlData?.models.has(m.name) && rootProjects.size > 0 && !rootProjects.has(m.projectName) && !knownModels.has(key)) { packageModels.add(key); continue; }
    knownModels.set(key, Math.max(knownModels.get(key) ?? 0, m.columns.length));
  }
  const overLimit = new Set(skipped.filter((s) => s.reason === 'over-limit').map((s) => normaliseName(s.name)));
  const undrawnLinks: DraftUndrawnLink[] = [];
  const undrawnSeen = new Set<string>();
  for (const t of tests.relationshipTests) {
    const from = normaliseName(t.fromModel);
    const to = normaliseName(t.toModel);
    if (!added.has(from) || drawn.has(to)) { continue; }
    const key = testKey(t);
    if (undrawnSeen.has(key)) { continue; }
    undrawnSeen.add(key);
    const columns = knownModels.get(to);
    const why: DraftUndrawnLink['why'] = packageModels.has(to) ? 'package'
      : projectDisabled.has(to) ? 'disabled'
        : columns === undefined ? 'notAModel' : columns === 0 ? 'noColumns' : 'addable';
    undrawnLinks.push({ fromModel: t.fromModel, fromColumn: t.fromColumn, toModel: t.toModel, toColumn: t.toColumn, why });
    ledger.skipped('relationship', overLimit.has(to) ? 'capped' : why === 'addable' ? 'other' : 'notInFiles', 'link to a model not drawn',
      { ...(t.file ? { file: t.file } : {}), ...(t.line !== undefined ? { line: t.line } : {}), table: t.fromModel, column: t.fromColumn }, `to ${t.toModel}`);
  }
  // Tests whose column a drawn table does not have: named, with the test's file and line.
  const testsByLink = new Map(tests.relationshipTests.map((t) => [linkKey({ ...t, fromColumn: identifierKey(t.fromColumn), toColumn: identifierKey(t.toColumn) }), t]));
  for (const r of missingColumn) {
    const [table, column] = lacks(r.fromModel, r.fromColumn) ? [r.fromModel, r.fromColumn] : [r.toModel, r.toColumn];
    const t = testsByLink.get(linkKey({ ...r, fromColumn: identifierKey(r.fromColumn), toColumn: identifierKey(r.toColumn) }));
    undrawnLinks.push({ fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, why: 'noColumn', missing: { table, column } });
    ledger.skipped('relationship', 'notInFiles', 'link from a column the table does not have',
      { ...(t?.file ? { file: t.file } : {}), ...(t?.line !== undefined ? { line: t.line } : {}), table, column }, `to ${r.toModel}`);
  }
  // Tests to a dbt source: a source is never a model, so no draft draws it (yml first, then the manifest's).
  for (const t of [...(input.ymlData?.sourceRelationshipTests ?? []), ...(input.manifest?.sourceRelationshipTests ?? [])]) {
    if (!added.has(normaliseName(t.fromModel))) { continue; }
    const key = `${normaliseName(t.fromModel)}\u0000${identifierKey(t.fromColumn)}\u0000source:${normaliseName(t.source)}\u0000${identifierKey(t.toColumn)}`;
    if (undrawnSeen.has(key)) { continue; }
    undrawnSeen.add(key);
    undrawnLinks.push({ fromModel: t.fromModel, fromColumn: t.fromColumn, toModel: t.source, toColumn: t.toColumn, why: 'source' });
    ledger.skipped('relationship', 'notInFiles', 'link to a source',
      { ...(t.file ? { file: t.file } : {}), ...(t.line !== undefined ? { line: t.line } : {}), table: t.fromModel, column: t.fromColumn }, `to ${t.source}`);
  }

  // A relationship drawn from a conditional test: its condition is not kept in the files (G2); the draft lists it.
  // Keyed with quotes aside: a relationship's ends are spelled as its columns (above), a test's as dbt passes them.
  const unquotedLinkKey = (r: DraftRelationshipTest): string => linkKey({ ...r, fromColumn: identifierKey(r.fromColumn), toColumn: identifierKey(r.toColumn) });
  const conditionalTests = new Map(tests.relationshipTests.filter((t) => t.conditional).map((t) => [unquotedLinkKey(t), t]));
  const relationshipConditions: DraftRelationshipCondition[] = [];
  for (const rel of relationships) {
    const test = conditionalTests.get(unquotedLinkKey(rel));
    if (!test) { continue; }
    ledger.lost('constraint', 'noField', 'relationships_where condition',
      { ...(test.file ? { file: test.file } : {}), ...(test.line !== undefined ? { line: test.line } : {}), table: rel.fromModel, column: rel.fromColumn },
      'not saved, so the line is drawn for every row; Relationships lists each condition');
    relationshipConditions.push({ fromModel: rel.fromModel, fromColumn: rel.fromColumn, toModel: rel.toModel, toColumn: rel.toColumn, conditions: test.conditions ?? [] });
  }

  // The project's sources: never drawn (see DbtDraft.sources), each recorded.
  const sources = dbtSourcesOf(input.ymlData, input.manifest);
  for (const src of sources) {
    ledger.skipped('table', 'other', 'dbt source', { ...(src.file ? { file: src.file } : {}), ...(src.line !== undefined ? { line: src.line } : {}), table: src.name },
      'a source: dbt reads it but does not build it, so it is not drawn');
  }

  // Required in the source: every FK column tested not_null. A DBML diagram saves each Ref `>?` (D18): counted.
  const requiredRelationships = relationships.filter((rel) => {
    const notNull = notNullColumnsOf(input.ymlData, rel.fromModel, input.manifest);
    return notNull.has(identifierKey(rel.fromColumn));
  }).length;
  if (input.dbml && requiredRelationships > 0) {
    ledger.changed('relationship', 'savedOptional', 'NOT NULL foreign key', undefined, 'saved as optional (>?)', requiredRelationships);
  }

  return {
    modelNames,
    newModels: accepted
      .filter((a) => a.model)
      .map((a) => markDraftKeys({ ...a.model!, name: a.name }, tests.unique, relationships)),
    reusedModels: accepted.filter((a) => !a.model).map((a) => a.name),
    relationships,
    skipped,
    truncated,
    ledger: ledger.entries,
    ...(undrawnLinks.length > 0 ? { undrawnLinks } : {}),
    ...(requiredRelationships > 0 ? { requiredRelationships } : {}),
    ...(relationshipConditions.length > 0 ? { relationshipConditions } : {}),
    ...(sources.length > 0 ? { sources } : {}),
  };
}

// ---------------------------------------------------------------------------
// The domain file
// ---------------------------------------------------------------------------

export interface DraftSubjectAreaDocument {
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
export function buildDraftSubjectAreaDocument(input: {
  domain: string;
  layer: string;
  description?: string;
  modelNames: readonly string[];
  relationships: readonly Relationship[];
  modelFolder?: string;
}): DraftSubjectAreaDocument {
  return {
    schemaVersion: WRITTEN_SCHEMA_VERSION,
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

/**
 * The file text, formatted as `createDomain` writes it: under the v5 keys,
 * or in the v6 naming (#182) for a project that writes it.
 */
export function serializeDraftSubjectAreaDocument(doc: DraftSubjectAreaDocument | object, tableNaming = false): string {
  return JSON.stringify(tableNaming ? toTableNamingDocument({ ...doc }) : doc, null, 2) + '\n';
}

/** Domain slug rule — the one `validateSubjectAreaSlug` in extension.ts enforces. */
export const SUBJECT_AREA_SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SUBJECT_AREA_SLUG_MAX = 64;

/** Latin letters NFKD does not take apart, as their usual ASCII spelling. */
const LATIN_FOLDS: Record<string, string> = {
  ß: 'ss', ẞ: 'SS', æ: 'ae', Æ: 'AE', œ: 'oe', Œ: 'OE', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L',
  đ: 'd', Đ: 'D', ð: 'd', Ð: 'D', þ: 'th', Þ: 'TH', ı: 'i', ħ: 'h', Ħ: 'H', ŧ: 't', Ŧ: 'T',
};
const LATIN_FOLD_PATTERN = new RegExp(`[${Object.keys(LATIN_FOLDS).join('')}]`, 'g');

/**
 * Text as ASCII letters where a Latin letter has one: accents dropped
 * (`Café` → `Cafe`, via NFKD) and the letters NFKD keeps whole spelled out
 * (`Straße` → `Strasse`, `Œuvre` → `Oeuvre`, `Łódź` → `Lodz`). Anything
 * else is left as it is.
 */
export function foldToAscii(text: string): string {
  return text
    // A capital that spells two letters stays one capital before a lower-case letter
    // (`Œuvre` → `Oeuvre`), so camel-case splitting reads it as one word.
    .replace(LATIN_FOLD_PATTERN, (ch, at: number, all: string) => {
      const folded = LATIN_FOLDS[ch] ?? ch;
      return folded.length > 1 && folded === folded.toUpperCase() && /^\p{Ll}/u.test(all.slice(at + 1))
        ? folded[0] + folded.slice(1).toLowerCase()
        : folded;
    })
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Turn free text into a domain slug, or '' when nothing usable is left. Accented letters keep their base letter (`Café` → `cafe`). */
export function toSubjectAreaSlug(text: string): string {
  const slug = foldToAscii(text)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, SUBJECT_AREA_SLUG_MAX)
    .replace(/[-_]+$/, '');
  return SUBJECT_AREA_SLUG_PATTERN.test(slug) ? slug : '';
}

/** Common model-name prefixes stripped when a cluster is named after its hub. */
const MODEL_PREFIX = /^(dim|fct|fact|stg|int|obt|hub|lnk|sat|mart|rpt)_/;

/**
 * A domain name for a scope: the folder's last segment (`marts/finance` →
 * `finance`), a cluster's hub without its prefix (`dim_customer` →
 * `customer`), else `dbt-draft`. With `taken` (domain names already in the
 * target layer) a `-2`, `-3`… suffix keeps it free.
 */
export function suggestSubjectAreaName(scope: DraftScope | undefined, taken: Iterable<string> = []): string {
  let base = '';
  if (scope?.kind === 'folder' && scope.folder) {
    const segments = scope.folder.split('/').filter(Boolean);
    base = toSubjectAreaSlug(segments[segments.length - 1] ?? '');
  } else if (scope?.kind === 'cluster' && scope.modelNames[0]) {
    base = toSubjectAreaSlug(scope.modelNames[0].toLowerCase().replace(MODEL_PREFIX, ''));
  }
  if (!base) { base = 'dbt-draft'; }

  return freeSubjectAreaSlug(base, taken);
}

/** `base`, or `base-2`, `base-3`… (kept within the slug length): the first not in `taken`, ignoring case. */
export function freeSubjectAreaSlug(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()));
  if (!used.has(base)) { return base; }
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    // Cut for the suffix without leaving a separator before it (`a--2`).
    const candidate = base.slice(0, SUBJECT_AREA_SLUG_MAX - suffix.length).replace(/[-_]+$/, '') + suffix;
    if (!used.has(candidate)) { return candidate; }
  }
}
