/**
 * `erd-studio inventory` — what the dbt project has, shaped for building a
 * logical model from it.
 *
 * The heavy lifting is `DomainService.buildPhysicalDomain`, run over a
 * synthetic domain holding the chosen names: the columns, types, provenance
 * and relationships reported here are therefore exactly what the physical
 * stage — and so `erd-studio diff` — will see for a domain holding the same
 * models. Nothing is derived here that the physical stage does not derive.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { DisplayDomain, PhysicalColumnSource } from '../types/display';
import { MODEL_NAME_PATTERN } from '../types/naming';
import type { Cardinality, UnifiedDomain } from '../types/semantic';
import { getRawDomainModelNames } from '../types/semantic';
import { mergeCompositeGroups, mergeUniqueMaps } from '../services/domainService';
import { normaliseName } from '../services/nameUtils';
import { inputsOf, relPath, type ArtifactStatus, type CliContext, type Envelope } from './context';
import {
  detectConventions,
  findSnapshotNames,
  medallionLayerOf,
  readPackageIdentifiers,
  type ProjectConventions,
} from './conventions';

export type InventoryModelKind = 'model' | 'seed' | 'snapshot';

export interface InventoryRelationship {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: Cardinality;
}

export interface InventoryModel {
  name: string;
  kind: InventoryModelKind;
  schema: string;
  description: string;
  /** Source file (.sql/.py/.csv), project-relative. */
  file: string | null;
  /** Schema .yml declaring the model, project-relative. */
  ymlFile: string | null;
  /** Folder segments under its model/seed/snapshot path. */
  folder: string[];
  suggestedLayer: string | null;
  existsInProject: boolean;
  /** Omitted with --summary. */
  columns?: Array<{ name: string; dataType: string; description: string }>;
  columnCount: number;
  provenance: { columns: PhysicalColumnSource[]; types: PhysicalColumnSource } | null;
  keyCandidates: { unique: string[]; compositeUnique: string[][] };
  /** `fromColumn`s of this model's relationships in `relationships`. */
  foreignKeys: string[];
}

export interface InventoryResult extends Envelope {
  inputs: { manifest: ArtifactStatus; catalog: ArtifactStatus };
  models: InventoryModel[];
  relationships: InventoryRelationship[];
  /** Connected components over `relationships`; singletons omitted. */
  clusters: string[][];
  /** Inventory names that already have a logical-models/*.yml. */
  alreadyModelled: string[];
  domains: Array<{ file: string; layer: string; domain: string; models: string[] }>;
  skipped: Array<{ name: string; reason: 'invalid-name' | 'disabled' }>;
  /**
   * The modelling conventions the whole project follows (layering, table
   * shape, snapshots), detected from its files — always project-wide, also
   * under `--models`. See `src/cli/conventions.ts`.
   */
  conventions: ProjectConventions;
}

export interface InventoryOptions {
  summary?: boolean;
  models?: string[];
}

/** The synthetic domain's name — never written anywhere. */
export const INVENTORY_DOMAIN = '__inventory__';

/**
 * Every model name the project knows, deduplicated case-insensitively: the
 * union of schema yml models, manifest models, catalog nodes and source files
 * dbt has not disabled. The first spelling seen wins, in that order.
 */
function projectModelNames(ctx: CliContext): { names: string[]; disabled: string[] } {
  const byKey = new Map<string, string>();
  const add = (name: string): void => {
    const key = normaliseName(name);
    if (!byKey.has(key)) { byKey.set(key, name); }
  };
  for (const name of ctx.ymlData.models.keys()) { add(name); }
  for (const name of ctx.manifest.models.keys()) { add(name); }
  for (const node of ctx.catalog?.byName.values() ?? []) { add(node.name); }

  const disabled: string[] = [];
  for (const [key, file] of ctx.ymlData.sourceFiles ?? []) {
    if (byKey.has(key)) { continue; }
    if (ctx.manifest.disabledModels.has(key)) {
      disabled.push(path.basename(file, path.extname(file)));
      continue;
    }
    add(path.basename(file, path.extname(file)));
  }
  return { names: [...byKey.values()], disabled };
}

/** Which configured path list `rel` (project-relative, forward slashes) sits under, and the folders below it. */
function locate(ctx: CliContext, rel: string): { kind: InventoryModelKind; folder: string[] } | null {
  const lists: Array<[InventoryModelKind, string[]]> = [
    ['model', ctx.dbtConfig.modelPaths],
    ['seed', ctx.dbtConfig.seedPaths],
    ['snapshot', ctx.dbtConfig.snapshotPaths],
  ];
  for (const [kind, bases] of lists) {
    for (const base of bases) {
      const prefix = base.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') + '/';
      if (rel.startsWith(prefix)) {
        const segments = rel.slice(prefix.length).split('/');
        segments.pop();
        return { kind, folder: segments.filter(Boolean) };
      }
    }
  }
  return null;
}

/**
 * First folder that is an existing layer id, else the dbt convention, else null.
 * In a medallion project (`medallion.schema` given), a bronze/silver/gold folder
 * segment at any depth — or schema token — wins and maps to the layer of that name.
 */
export function suggestLayer(
  folder: readonly string[],
  layerIds: readonly string[],
  medallion?: { schema: string },
): string | null {
  if (medallion) {
    const layer = medallionLayerOf(folder, medallion.schema);
    if (layer) { return layer; }
  }
  const first = folder[0]?.toLowerCase();
  if (!first) { return null; }
  if (layerIds.includes(first)) { return first; }
  if (first === 'staging' || first === 'intermediate') { return 'silver'; }
  if (first === 'marts') { return 'gold'; }
  return null;
}

/** Connected components of an undirected graph over `relationships`; components of one omitted. */
export function clustersOf(relationships: readonly InventoryRelationship[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) { root = parent.get(root)!; }
    parent.set(x, root);
    return root;
  };
  const touch = (x: string): void => { if (!parent.has(x)) { parent.set(x, x); } };
  for (const r of relationships) {
    touch(r.fromModel);
    touch(r.toModel);
    const a = find(r.fromModel);
    const b = find(r.toModel);
    if (a !== b) { parent.set(a, b); }
  }
  const groups = new Map<string, string[]>();
  for (const name of parent.keys()) {
    const root = find(name);
    groups.set(root, [...(groups.get(root) ?? []), name]);
  }
  return [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

/** Domain files under the semantic dir with the model names each references (raw read, any format). */
export function listDomainFiles(ctx: CliContext): InventoryResult['domains'] {
  return ctx.domainService.listDomains(ctx.root, ctx.semanticDir).map((d) => {
    let models: string[] = [];
    try {
      models = getRawDomainModelNames(JSON.parse(fs.readFileSync(d.filePath, 'utf-8')));
    } catch {
      // Unreadable or invalid JSON: listed with no models; `diff` reports the error.
    }
    return { file: relPath(ctx.root, d.filePath), layer: d.layer, domain: d.domain, models };
  });
}

/** The physical stage for `names`, built exactly as the canvas builds it for a domain holding them. */
export function buildInventoryDomain(ctx: CliContext, names: readonly string[]): DisplayDomain {
  const layerIds = ctx.layerService.getValidLayerIds();
  const unified: UnifiedDomain = {
    schemaVersion: 5,
    domain: INVENTORY_DOMAIN,
    layer: layerIds[0] ?? 'silver',
    description: '',
    logical: { models: names.map((name) => ({ name, columns: [] })), relationships: [] },
    viewConfig: {},
  };
  return ctx.domainService.buildPhysicalDomain(unified, ctx.ymlData, ctx.manifest, ctx.catalog);
}

/** Names from `--models` (validated) or the whole project, plus what was skipped. */
function chooseNames(ctx: CliContext, requested?: string[]): { names: string[]; skipped: InventoryResult['skipped'] } {
  const skipped: InventoryResult['skipped'] = [];
  const names: string[] = [];
  if (requested && requested.length > 0) {
    for (const name of requested) {
      if (MODEL_NAME_PATTERN.test(name)) { names.push(name); } else { skipped.push({ name, reason: 'invalid-name' }); }
    }
    return { names, skipped };
  }
  const found = projectModelNames(ctx);
  for (const name of found.names) {
    if (MODEL_NAME_PATTERN.test(name)) { names.push(name); } else { skipped.push({ name, reason: 'invalid-name' }); }
  }
  for (const name of found.disabled) { skipped.push({ name, reason: 'disabled' }); }
  return { names, skipped };
}

/** Inventory models + relationships for `names`, with `suggestedLayer` from the plain folder rule. */
function describeModels(ctx: CliContext, names: readonly string[], summary: boolean): { models: InventoryModel[]; relationships: InventoryRelationship[] } {
  const physical = buildInventoryDomain(ctx, names);
  const relationships: InventoryRelationship[] = physical.relationships.map((r) => ({
    fromModel: r.fromModel,
    fromColumn: r.fromColumn,
    toModel: r.toModel,
    toColumn: r.toColumn,
    cardinality: r.cardinality,
  }));

  const uniqueByModel = new Map<string, Set<string>>();
  for (const [model, cols] of mergeUniqueMaps(ctx.ymlData.uniqueColumns, ctx.manifest.uniqueColumns)) {
    const key = normaliseName(model);
    const set = uniqueByModel.get(key) ?? new Set<string>();
    for (const c of cols) { set.add(c); }
    uniqueByModel.set(key, set);
  }
  const compositeByModel = new Map<string, string[][]>();
  for (const [model, groups] of mergeCompositeGroups(ctx.ymlData.compositeUniqueGroups, ctx.manifest.compositeUniqueGroups)) {
    const key = normaliseName(model);
    compositeByModel.set(key, [...(compositeByModel.get(key) ?? []), ...groups]);
  }

  const ymlIndex = new Map([...ctx.ymlData.models].map(([n, m]) => [normaliseName(n), m]));
  const manifestIndex = new Map([...ctx.manifest.models].map(([n, m]) => [normaliseName(n), m]));
  const layerIds = ctx.layerService.getValidLayerIds();

  const models: InventoryModel[] = physical.models.map((m) => {
    const key = normaliseName(m.name);
    const yml = ymlIndex.get(key);
    const man = manifestIndex.get(key);
    const catalogNode = (man ? ctx.catalog?.byUniqueId.get(man.uniqueId) : undefined) ?? ctx.catalog?.byName.get(key);

    const file = ctx.ymlData.sourceFiles?.get(key) ?? man?.originalFilePath?.replace(/\\/g, '/') ?? null;
    // A seed / snapshot is documented in a `seeds:` / `snapshots:` block, not `models:`.
    const ymlPath = yml?.filePath ?? ctx.ymlData.resourceDocs?.get(key)?.filePath;
    const ymlFile = ymlPath ? relPath(ctx.root, ymlPath) : null;
    const located = (file ? locate(ctx, file) : null) ?? (ymlFile ? locate(ctx, ymlFile) : null);

    const manifestKind = man?.uniqueId.split('.')[0];
    const kind: InventoryModelKind =
      manifestKind === 'seed' || manifestKind === 'snapshot' || manifestKind === 'model'
        ? manifestKind
        : catalogNode?.resourceType ?? ctx.ymlData.resourceDocs?.get(key)?.resourceType ?? located?.kind ?? 'model';
    const folder = located?.folder ?? [];

    const unique = [...(uniqueByModel.get(key) ?? [])].sort();
    const model: InventoryModel = {
      name: m.name,
      kind,
      schema: m.schema,
      description: m.description,
      file,
      ymlFile,
      folder,
      suggestedLayer: suggestLayer(folder, layerIds),
      existsInProject: m.existsInProject !== false,
      columnCount: m.columns.length,
      provenance: m.provenance ?? null,
      keyCandidates: { unique, compositeUnique: compositeByModel.get(key) ?? [] },
      foreignKeys: [...new Set(relationships.filter((r) => r.fromModel === m.name).map((r) => r.fromColumn))],
    };
    if (!summary) {
      model.columns = m.columns.map((c) => ({ name: c.name, dataType: c.dataType, description: c.description }));
    }
    return model;
  });

  models.sort((a, b) => a.folder.join('/').localeCompare(b.folder.join('/')) || a.name.localeCompare(b.name));
  return { models, relationships };
}

/**
 * The project's conventions, from every model the project has (not just the
 * `--models` selection) — names, folders, descriptions, columns, keys and
 * relationships — plus its packages files and its snapshot folders.
 * `projectModels` must carry `columns` (a non-summary describe).
 */
export function projectConventions(
  ctx: CliContext,
  projectModels: readonly InventoryModel[],
  relationships: readonly InventoryRelationship[],
): ProjectConventions {
  return detectConventions({
    models: projectModels.filter((m) => m.existsInProject).map((m) => ({
      name: m.name,
      kind: m.kind,
      folder: m.folder,
      schema: m.schema,
      columnCount: m.columnCount,
      description: m.description,
      columns: m.columns ?? [],
      uniqueKeys: m.keyCandidates.unique,
    })),
    packages: readPackageIdentifiers(ctx.root),
    snapshots: findSnapshotNames(ctx.root, ctx.dbtConfig.snapshotPaths),
    relationships,
  });
}

export function runInventory(ctx: CliContext, opts: InventoryOptions = {}): InventoryResult {
  const scoped = !!opts.models && opts.models.length > 0;
  const { names, skipped } = chooseNames(ctx, opts.models);
  // Columns are always described: conventions read their types and descriptions. `--summary` drops them below.
  const { models, relationships } = describeModels(ctx, names, false);

  const project = scoped ? describeModels(ctx, chooseNames(ctx).names, false) : { models, relationships };
  const conventions = projectConventions(ctx, project.models, project.relationships);
  if (opts.summary) {
    for (const m of models) { delete m.columns; }
  }
  if (conventions.layering.style === 'medallion') {
    const layerIds = ctx.layerService.getValidLayerIds();
    for (const m of models) { m.suggestedLayer = suggestLayer(m.folder, layerIds, { schema: m.schema }); }
  }

  return {
    ...ctx.envelope,
    inputs: inputsOf(ctx),
    models,
    relationships,
    clusters: clustersOf(relationships),
    alreadyModelled: names.filter((n) => ctx.logicalModelService.modelExists(n)).sort(),
    domains: listDomainFiles(ctx),
    skipped,
    conventions,
  };
}
