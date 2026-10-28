/**
 * Sync plan construction — turns a `DiscrepancyReport` plus the user's
 * per-item ground-truth choices into a `SyncPlan`.
 *
 * Extracted from `SemanticEditorProvider.handleGenerateSyncPlan`, which now
 * only reads the setting, writes `.sync-plan.json` and opens it. The
 * `erd-studio diff` CLI builds its plan here too (with `allSelections(report,
 * 'physical')`), so the fixes it reports are the ones the canvas would write.
 *
 * Pure: no I/O and no `vscode` — bundled into `dist/cli.js`.
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
   * The host passes `TableLibraryService.pathForNewTable`.
   */
  newTableFilePath?: (modelName: string) => string | undefined;
  /**
   * The relationships file holding a DBML table's Refs, relative to the
   * semantic dir (`relationshipsFileFor`), or undefined for a YAML table.
   */
  relationshipsFile?: (modelName: string) => string | undefined;
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

  for (const [key, groundTruth] of Object.entries(selections)) {
    const parts = key.split(':');
    const kind = parts[0];

    if (kind === 'model') {
      const modelName = parts[1];
      const disc = report.models.find((m) => m.name === modelName);
      if (!disc || disc.status === 'matched') continue;

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
      const modelName = parts[1];
      const columnName = parts.slice(2).join(':'); // column name may contain colons
      const modelDisc = report.models.find((m) => m.name === modelName);
      const colDisc = modelDisc?.columns.find((c) => c.name === columnName);
      if (!colDisc || colDisc.status === 'matched') continue;

      const action = deriveColumnAction(colDisc.status, groundTruth, report.sourceStage);
      if (!action) continue;

      columns.push({
        modelName,
        columnName,
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
      // A composite the logical model draws and dbt does not declare as one
      // (#133 L2) is not wrong in the logical model: dbt is asked to declare it.
      if (relDisc.composite && action === 'remove-relationship-from-logical') action = 'add-relationship-test-to-physical';

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
      });
      referencedModels.add(fromModel);
      referencedModels.add(toModel);
    }
  }

  // Build model context with file paths (prefer yml source, fall back to manifest heuristic).
  // Every path is project-relative with forward slashes on every platform —
  // the CLI's JSON promises that, and the Claude sync consumer reads either.
  const toSlash = (p: string): string => p.replace(/\\/g, '/');
  const modelContext: Record<string, TableContext> = {};
  for (const modelName of referencedModels) {
    const manifestModel = ctx.manifest.models.get(modelName);
    const ymlModel = ctx.ymlData.models.get(modelName);
    let dbtSqlPath: string | null = null;
    let dbtSchemaPath: string | null = null;

    if (ymlModel?.filePath) {
      // Use the actual yml file path from YmlParserService
      dbtSchemaPath = toSlash(path.relative(ctx.projectRoot, ymlModel.filePath));
      // Heuristic: SQL file is next to the YAML file with .sql extension
      dbtSqlPath = dbtSchemaPath.replace(/\.ya?ml$/, '.sql');
    } else if (manifestModel?.originalFilePath) {
      dbtSqlPath = toSlash(manifestModel.originalFilePath);
      dbtSchemaPath = dbtSqlPath.replace(/\.sql$/, '.yml');
    }

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
  };
}
