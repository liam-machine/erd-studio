/**
 * Sync plan construction — turns a `DiscrepancyReport` plus the user's
 * per-item ground-truth choices into a `SyncPlan`.
 *
 * Extracted from `SemanticEditorProvider.handleGenerateSyncPlan`, which now
 * only reads the setting, writes `.sync-plan.json` and opens it. The
 * `erd-studio diff` CLI builds its plan here too (with `allSelections(report,
 * 'physical')`), so the fixes it reports are the ones the canvas would write.
 *
 * `buildSyncPlan` is pure: no I/O and no `vscode` — bundled into `dist/cli.js`.
 * `syncPlanLibraryLookups` only reads through the table library it is given.
 */

import * as path from 'path';

import type { DiscrepancyReport } from '../types/discrepancy';
import type { ManifestData } from '../types/manifest';
import type {
  ColumnAction,
  ColumnResolution,
  GroundTruth,
  TableAction,
  TableContext,
  TableResolution,
  RelationshipAction,
  RelationshipResolution,
  SyncPlan,
} from '../types/syncPlan';
import {
  columnKey,
  deriveColumnAction,
  deriveTableAction,
  deriveRelationshipAction,
  tableKey,
  relationshipKey,
  relationshipSelectionKey,
  resolveGroundTruthDataType,
} from '../types/syncPlan';
import type { YmlData } from '../types/ymlData';
import { subjectAreaStorageOf } from '@erd-studio/core';
import { catalogColumnName, configuredSchemaOf } from './dbtDraft';
import { normaliseName } from './nameUtils';
import type { TableLibraryService } from './logicalModelService';
import type { TableId } from '../types/tableId';

export interface SyncPlanContext {
  manifest: ManifestData;
  ymlData: YmlData;
  /** dbt project root; dbt file paths in `modelContext` are relative to it. */
  projectRoot: string;
  /** ERD data dir relative to the project root (the `semanticDir` setting). */
  semanticDir: string;
  /** Domain name and layer, as written in the domain file. */
  domain: string;
  layer: string;
  /** Timestamp for `generatedAt`; the current time when omitted. */
  now?: Date;
  /**
   * The logical-models/ sub-folder a model's file is in (`''` top level,
   * null when there is no file), so `logicalModelPath` names the real file
   * in a library grouped by layer. Omitted: every path is top level.
   */
  modelFolder?: (modelName: string) => string | null;
  /**
   * Where a model's library file is, relative to the semantic dir
   * (`logical-models/…` or v6's `tables/…`, #162), or null when it has none.
   * Wins over `modelFolder`, which assumes `logical-models/`.
   */
  tableLibraryFile?: (modelName: string) => string | null;
  /**
   * Where a table with no file yet would get one: `logical-models` in a v5
   * project, v6's `tables` in one that writes the new naming (#182).
   * Default `logical-models`.
   */
  newTableLibraryDir?: string;
  /**
   * Where a table with no file yet would get one, relative to the semantic
   * dir (`tables/gold/x.dbml` in a project that writes DBML, §5.7). Wins
   * over `newTableLibraryDir` and `modelFolder` for a table with no file.
   * The host passes `TableLibraryService.pathForNewTable` at the diagram's
   * home ({@link syncPlanLibraryLookups}).
   */
  newTableFilePath?: (modelName: string) => string | undefined;
  /**
   * Where a new Ref of a DBML foreign-key table goes, relative to the
   * semantic dir (`relationshipsFileForNewRef`), or undefined for a YAML
   * table. Feeds `modelContext[…].relationshipsPath`.
   */
  relationshipsFile?: (modelName: string) => string | undefined;
  /**
   * The relationships file holding a relationship now, relative to the
   * semantic dir (`relationshipsFileHolding`), or undefined when none does.
   * Feeds each relationship's `storedIn`.
   */
  relationshipStoredIn?: (rel: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }) => string | undefined;
  /**
   * True when a table's file is there but does not read (a YAML or DBML
   * error, merge conflict markers). Such a table loads with no columns and
   * none of its Refs, so every column and relationship entry touching it is
   * an artefact of the failed read ("add it" on one side, "remove it" on the
   * other): they are left out of the plan and the table is listed in
   * `unreadableTables` instead. The host passes
   * `TableLibraryService.getTableFileError` ({@link syncPlanLibraryLookups}).
   */
  tableUnreadable?: (modelName: string) => boolean;
  /**
   * The dbt model a table of the report was found as, where that is not its
   * name (a name two schema folders share, found by schema:
   * `SubjectAreaService.dbtModelNamesOf`): null when it was found as none.
   * Undefined, or omitted: the table's name is its dbt model's.
   */
  dbtModelOf?: (modelName: string) => string | null | undefined;
}

/** The table library calls {@link syncPlanLibraryLookups} makes. */
export type SyncPlanLibrary = Pick<TableLibraryService,
  'tableFolder' | 'tableLibraryFile' | 'newTableLibraryDirName' | 'newTableHomeFor' | 'pathForNewTable'
  | 'libraryRelativePath' | 'relationshipsFileForNewRef' | 'relationshipsFileForNewTable' | 'relationshipsFileHolding'
  | 'getTableFileError'>;

/**
 * The library lookups of a {@link SyncPlanContext} for the diagram at
 * `where.diagramFile`, the one place the canvas (`generateSyncPlan`) and the
 * CLI (`diff`) take them from, so both name the same files. A table with no
 * file goes where a table created from that diagram goes
 * (`newTableHomeFor`: its layer), and on a DBML diagram in its dbt custom
 * schema's folder when the developer configured one, as Import from dbt and Add
 * Tables from dbt place it (§2.4). `layerIds`: the layers in `layers.json`.
 */
export function syncPlanLibraryLookups(
  library: SyncPlanLibrary,
  where: {
    diagramFile: string; layerIds: ReadonlySet<string>; manifest?: ManifestData; ymlData?: YmlData;
    /** A table of the diagram by its identity, where the diagram's name for it is not enough (`SubjectAreaService.tableIdsOf`). */
    tableIdOf?: (modelName: string) => TableId | undefined;
  },
): Pick<SyncPlanContext, 'modelFolder' | 'tableLibraryFile' | 'newTableLibraryDir' | 'newTableFilePath' | 'relationshipsFile' | 'relationshipStoredIn' | 'tableUnreadable'> {
  const dbmlDiagram = subjectAreaStorageOf(where.diagramFile) === 'dbml';
  // A table two schema folders share is asked for by its own file, never by a name or a reference.
  const table = (name: string): TableId | string => where.tableIdOf?.(name) ?? name;
  let home: ReturnType<SyncPlanLibrary['newTableHomeFor']> | null = null;
  const relative = (file: string | undefined): string | undefined => (file === undefined ? undefined : library.libraryRelativePath(file));
  const newTableFile = (name: string): string | undefined => {
    try {
      if (home === null) home = library.newTableHomeFor(where.diagramFile, where.layerIds);
      const configuredSchema = dbmlDiagram ? configuredSchemaOf(name, where.ymlData, where.manifest) : undefined;
      return library.pathForNewTable(name, home, configuredSchema !== undefined ? { configuredSchema } : {});
    } catch {
      return undefined;
    }
  };
  return {
    modelFolder: (name) => library.tableFolder(table(name)),
    tableLibraryFile: (name) => library.tableLibraryFile(table(name)),
    newTableLibraryDir: library.newTableLibraryDirName(),
    newTableFilePath: (name) => relative(newTableFile(name)),
    // A table with no file yet (a diagram member the library lacks) has its
    // new Refs placed from the DBML file it will get, so the plan and diff
    // name a relationships file for it too, never the table file.
    relationshipsFile: (name) => {
      const placed = library.relationshipsFileForNewRef(table(name));
      if (placed !== undefined) return relative(placed);
      const future = library.tableLibraryFile(table(name)) === null ? newTableFile(name) : undefined;
      return future === undefined ? undefined : relative(library.relationshipsFileForNewTable(name, future));
    },
    relationshipStoredIn: (rel) => relative(library.relationshipsFileHolding({ ...rel, fromModel: table(rel.fromModel), toModel: table(rel.toModel) })),
    tableUnreadable: (name) => library.getTableFileError(table(name)) !== null,
  };
}

/** Actions that edit dbt files, after which `dbt compile` is needed. */
const PHYSICAL_ACTIONS: ReadonlySet<TableAction | ColumnAction | RelationshipAction> = new Set([
  'add-to-physical', 'remove-from-physical',
  'add-column-to-physical', 'remove-column-from-physical',
  'update-type-in-physical',
  'add-relationship-test-to-physical', 'remove-relationship-test-from-physical',
  'update-cardinality-in-physical',
]);

/**
 * Every resolvable item in `report` mapped to `truth` — the same key set the
 * sync modal's "resolve all" builds: `model:{m}` for each non-matched model,
 * `col:{m}:{c}` for each non-matched column (in any model), and
 * `rel:{from}:{fromCol}:{to}:{toCol}` for each non-matched relationship
 * (`rel:{from}:{a+b}:{to}:{c+d}` for a composite foreign key).
 */
export function allSelections(report: DiscrepancyReport, truth: GroundTruth): Record<string, GroundTruth> {
  const selections: Record<string, GroundTruth> = {};
  for (const m of report.models) {
    if (m.status !== 'matched') selections[tableKey(m.name)] = truth;
    for (const c of m.columns) {
      if (c.status !== 'matched') selections[columnKey(m.name, c.name)] = truth;
    }
  }
  for (const r of report.relationships) {
    if (r.status !== 'matched') {
      selections[relationshipSelectionKey(r)] = truth;
    }
  }
  return selections;
}

/**
 * The item each selection key of `report` names: keys are matched by
 * building each item's key (`tableKey`, `columnKey`), never by splitting
 * one on ':', so a table name or a column name holding ':' (a schema
 * folder may) is never cut in the wrong place. A key two items would share
 * names neither: it is left out, never guessed.
 */
function selectionTargets(report: DiscrepancyReport): {
  models: Map<string, DiscrepancyReport['models'][number]>;
  columns: Map<string, { model: string; column: DiscrepancyReport['models'][number]['columns'][number] }>;
} {
  const models = new Map<string, DiscrepancyReport['models'][number]>();
  const columns = new Map<string, { model: string; column: DiscrepancyReport['models'][number]['columns'][number] }>();
  const shared = new Set<string>();
  for (const m of report.models) {
    // One name listed twice is one table: the first entry, as ever.
    if (!models.has(tableKey(m.name))) models.set(tableKey(m.name), m);
    for (const c of m.columns) {
      const key = columnKey(m.name, c.name);
      const known = columns.get(key);
      if (shared.has(key) || (known && known.model === m.name)) continue;
      // `col:a:b:c` is a's column b:c and a:b's column c: neither.
      if (known) { columns.delete(key); shared.add(key); continue; }
      columns.set(key, { model: m.name, column: c });
    }
  }
  return { models, columns };
}

/** Number of resolutions in a plan — zero means nothing actionable was selected. */
export function countSyncPlanActions(plan: Pick<SyncPlan, 'models' | 'columns' | 'relationships'>): number {
  return plan.models.length + plan.columns.length + plan.relationships.length;
}

/**
 * Build a sync plan from ground-truth `selections` keyed as `allSelections`
 * describes. Keys naming a matched or unknown item, or a choice that needs no
 * action (e.g. "logical is right" for an item only logical has, viewed from
 * logical), are skipped. The plan may therefore be empty — check
 * `countSyncPlanActions`.
 */
export function buildSyncPlan(
  report: DiscrepancyReport,
  selections: Record<string, GroundTruth>,
  ctx: SyncPlanContext,
): SyncPlan {
  const models: TableResolution[] = [];
  const columns: ColumnResolution[] = [];
  const relationships: RelationshipResolution[] = [];
  const referencedModels = new Set<string>();
  // Every path is project-relative with forward slashes on every platform —
  // the CLI's JSON promises that, and the Claude sync consumer reads either.
  const toSlash = (p: string): string => p.replace(/\\/g, '/');
  // Tables whose file does not read, and whose entries were therefore left out.
  const unreadable = new Map<string, boolean>();
  const skipped = new Set<string>();
  const isUnreadable = (name: string): boolean => {
    if (!ctx.tableUnreadable) return false;
    let known = unreadable.get(name);
    if (known === undefined) { known = ctx.tableUnreadable(name); unreadable.set(name, known); }
    if (known) skipped.add(name);
    return known;
  };

  // The dbt model a table is: its name, unless it was found as another (or as none).
  const dbtModelOf = (modelName: string): string | null => {
    const found = ctx.dbtModelOf?.(modelName);
    return found === undefined ? modelName : found;
  };
  // Whether the schema yml or the manifest declares a column (any case):
  // otherwise only catalog.json, i.e. the warehouse, reports it.
  const declaredInDbt = (modelName: string, columnName: string): boolean => {
    const key = normaliseName(columnName);
    const dbtName = dbtModelOf(modelName);
    if (dbtName === null) return false;
    const yml = ctx.ymlData.models.get(dbtName);
    const man = ctx.manifest.models.get(dbtName);
    return [...(yml?.columns ?? []), ...(man?.columns ?? [])].some((c) => normaliseName(c.name) === key);
  };
  const targets = selectionTargets(report);

  for (const [key, groundTruth] of Object.entries(selections)) {
    const kind = key.slice(0, key.indexOf(':'));

    if (kind === 'model') {
      const disc = targets.models.get(key);
      if (!disc || disc.status === 'matched') continue;
      const modelName = disc.name;

      const action = deriveTableAction(disc.status, groundTruth, report.sourceStage);
      if (!action) continue;

      models.push({
        modelName,
        discrepancyStatus: disc.status,
        groundTruth,
        action,
      });
      referencedModels.add(modelName);
    } else if (kind === 'col') {
      const target = targets.columns.get(key);
      const colDisc = target?.column;
      if (!target || !colDisc || colDisc.status === 'matched') continue;
      const modelName = target.model;
      const columnName = colDisc.name;

      const action = deriveColumnAction(colDisc.status, groundTruth, report.sourceStage);
      if (!action) continue;
      if (isUnreadable(modelName)) continue;

      columns.push({
        modelName,
        // A column only the warehouse reports is written as Import from dbt
        // seeds it (`LOADED_AT` → `loaded_at`); a declared one as declared.
        columnName: action === 'add-column-to-logical' && !declaredInDbt(modelName, columnName)
          ? catalogColumnName(columnName)
          : columnName,
        discrepancyStatus: colDisc.status,
        groundTruth,
        action,
        sourceDataType: colDisc.sourceDataType,
        targetDataType: colDisc.targetDataType,
        // Stage-absolute: the two fields above are named for the comparison
        // direction, not for a stage, so which one carries the ground-truth
        // value flips when the user compares from the physical stage.
        resolvedDataType: resolveGroundTruthDataType(
          groundTruth,
          report.sourceStage,
          colDisc.sourceDataType,
          colDisc.targetDataType,
        ),
      });
      referencedModels.add(modelName);
    } else if (kind === 'rel') {
      // A composite is selected by its joined key, or by its first pair's
      // (a selector that knows only single links).
      const relDisc = report.relationships.find((r) => relationshipSelectionKey(r) === key)
        ?? report.relationships.find((r) => r.pairs && relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn) === key);
      if (!relDisc || relDisc.status === 'matched') continue;
      const { fromModel, fromColumn, toModel, toColumn } = relDisc;

      let action = deriveRelationshipAction(relDisc.status, groundTruth, report.sourceStage);
      if (!action) continue;
      // Evaluate both ends, so each unreadable one is listed.
      const fromUnreadable = isUnreadable(fromModel);
      if (isUnreadable(toModel) || fromUnreadable) continue;
      // A composite the logical model draws and dbt does not declare as one
      // (#133 L2) is not wrong in the logical model: dbt is asked to declare it.
      if (relDisc.composite && action === 'remove-relationship-from-logical') action = 'add-relationship-test-to-physical';
      const storedIn = ctx.relationshipStoredIn?.({ fromModel, fromColumn, toModel, toColumn });

      relationships.push({
        fromModel,
        fromColumn,
        toModel,
        toColumn,
        discrepancyStatus: relDisc.status,
        groundTruth,
        action,
        sourceCardinality: relDisc.sourceCardinality,
        targetCardinality: relDisc.targetCardinality,
        ...(relDisc.pairs ? { pairs: relDisc.pairs.map((p) => ({ ...p })) } : {}),
        ...(relDisc.compositeKey ? { compositeKey: relDisc.compositeKey } : {}),
        ...(relDisc.composite ? { composite: true as const } : {}),
        ...(storedIn !== undefined ? { storedIn: toSlash(path.join(ctx.semanticDir, storedIn)) } : {}),
      });
      referencedModels.add(fromModel);
      referencedModels.add(toModel);
    }
  }

  // Build model context with file paths. The schema yml is the one that
  // declares the model, else a guess next to the manifest's SQL file (where a
  // new one would go). The SQL file is only ever one that is on disk, i.e. in
  // the yml walker's listing of the configured model paths (`sourceFiles`):
  // the manifest's `original_file_path` when it is listed (exact, and right
  // for a versioned model's `_v2.sql`), else the `.sql` file named after the
  // model. Never a name guessed from the yml's path: a model with only a yml
  // has no SQL file, and gets null.
  const listedSourceFiles = new Set([...(ctx.ymlData.sourceFiles?.values() ?? [])].map(toSlash));
  const modelContext: Record<string, TableContext> = {};
  for (const modelName of referencedModels) {
    // dbt's files are the ones of the dbt model the table was found as (none for one found as none).
    const dbtName = dbtModelOf(modelName);
    const manifestModel = dbtName === null ? undefined : ctx.manifest.models.get(dbtName);
    const ymlModel = dbtName === null ? undefined : ctx.ymlData.models.get(dbtName);
    let dbtSchemaPath: string | null = null;

    if (ymlModel?.filePath) {
      // Use the actual yml file path from YmlParserService
      dbtSchemaPath = toSlash(path.relative(ctx.projectRoot, ymlModel.filePath));
    } else if (manifestModel?.originalFilePath) {
      dbtSchemaPath = toSlash(manifestModel.originalFilePath).replace(/\.(sql|py)$/i, '.yml');
    }
    const compiledFrom = manifestModel?.originalFilePath ? toSlash(manifestModel.originalFilePath) : undefined;
    const sourceFile = compiledFrom && listedSourceFiles.has(compiledFrom)
      ? compiledFrom
      : dbtName === null ? undefined : ctx.ymlData.sourceFiles?.get(normaliseName(dbtName));
    const dbtSqlPath = sourceFile && /\.sql$/i.test(sourceFile) ? toSlash(sourceFile) : null;

    const relationshipsFile = ctx.relationshipsFile?.(modelName);
    modelContext[modelName] = {
      modelName,
      // The file where it actually is — top level or a layer folder.
      logicalModelPath: toSlash(path.join(
        ctx.semanticDir,
        ctx.tableLibraryFile?.(modelName)
          ?? ctx.newTableFilePath?.(modelName)
          ?? path.join(ctx.newTableLibraryDir ?? 'logical-models', ctx.modelFolder?.(modelName) ?? '', `${modelName}.yml`),
      )),
      ...(relationshipsFile !== undefined ? { relationshipsPath: toSlash(path.join(ctx.semanticDir, relationshipsFile)) } : {}),
      dbtSqlPath,
      dbtSchemaPath,
    };
  }

  // Determine if compile is needed (any physical-side action)
  const requiresCompile = [
    ...models.map((m) => m.action),
    ...columns.map((c) => c.action),
    ...relationships.map((r) => r.action),
  ].some((a) => PHYSICAL_ACTIONS.has(a));

  return {
    generatedAt: (ctx.now ?? new Date()).toISOString(),
    domain: ctx.domain,
    layer: ctx.layer,
    sourceStage: report.sourceStage,
    targetStage: report.targetStage,
    modelContext,
    models,
    columns,
    relationships,
    requiresCompile,
    ...(skipped.size > 0 ? { unreadableTables: [...skipped].sort((a, b) => a.localeCompare(b)) } : {}),
  };
}
