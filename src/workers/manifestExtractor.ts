/**
 * Pure extraction functions for dbt manifest.json nodes.
 *
 * Shared between the manifest worker thread and unit tests.
 * Returns plain objects/arrays (not Maps/Sets) so the result
 * can be transferred via structured clone (worker postMessage).
 */

import type { Meta } from '../types/semantic';
import type { RelationshipTestCondition, YmlSourceRelationshipTest, YmlSourceTable } from '../types/ymlData';
import type {
  CompositeForeignKey,
  ManifestColumn,
  ManifestModelInfo,
  ManifestRelationshipTest,
  ManifestWorkerResult,
} from '../types/manifest';
import { THROWAWAY_MARKER_KEY } from '../types/manifest';
import { readMeta } from '@erd-studio/core';
import { parseRefModelName, parseSourceCall, resolveModelNameFromNodeId } from '../services/nameUtils';

const MODEL_KEY_PREFIX = 'model.';
const TEST_KEY_PREFIX = 'test.';
/**
 * Seeds and snapshots: collected into `resourceDocs` for their descriptions
 * only, never into `models` (existence, picker and relationship derivation).
 */
const RESOURCE_DOC_KEY_PREFIXES = ['seed.', 'snapshot.'];

/**
 * Extract all model and test data from a parsed manifest JSON object.
 * This is the single entry point called by the worker thread.
 */
export function extractManifestData(
  manifest: Record<string, unknown>,
): ManifestWorkerResult {
  // Extracted before the `nodes` guard: a model dbt refuses to build is
  // evidence in its own right, and losing it to a malformed manifest would
  // let a bare .sql file pass for a working model.
  const disabledModels = extractDisabledModels(manifest.disabled);
  const placeholder = isPlaceholderManifest(manifest);

  const nodes = manifest.nodes as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes !== 'object') {
    return {
      models: {},
      relationshipTests: [],
      uniqueColumns: {},
      compositeUniqueGroups: {},
      disabledModels,
      resourceDocs: {},
      compositeForeignKeys: [],
      notNullColumns: {},
      sourceRelationshipTests: [],
      sources: extractSources(manifest.sources),
      ...(placeholder ? { placeholderProfile: true } : {}),
    };
  }

  const models: Record<string, ManifestModelInfo> = {};
  const relationshipTests: ManifestRelationshipTest[] = [];
  const uniqueColumns: Record<string, string[]> = {};
  const compositeUniqueGroups: Record<string, string[][]> = {};
  const resourceDocs: Record<string, ManifestModelInfo> = {};
  const notNullColumns: Record<string, string[]> = {};
  const sourceRelationshipTests: YmlSourceRelationshipTest[] = [];
  const addNotNull = (model: string, column: string): void => {
    const cols = (notNullColumns[model] ??= []);
    if (!cols.includes(column)) cols.push(column);
  };
  // Composite foreign keys, resolved once every model is known (a constraint's
  // `to` may be a rendered relation named by its alias).
  const declaredForeignKeys: Array<CompositeForeignKey & { to: string }> = [];

  for (const [nodeKey, nodeValue] of Object.entries(nodes)) {
    const node = nodeValue as Record<string, unknown>;

    if (nodeKey.startsWith(MODEL_KEY_PREFIX)) {
      const modelInfo = extractModelInfo(node);
      if (modelInfo) {
        // dbt versioned models share a `name` across `model.proj.name.v1`,
        // `model.proj.name.v2`, … — keep the latest version rather than
        // whichever node happens to be iterated last.
        const existing = models[modelInfo.name];
        if (!existing || isPreferredVersion(modelInfo, existing)) {
          models[modelInfo.name] = modelInfo;
        }
        declaredForeignKeys.push(...extractForeignKeyConstraints(modelInfo.name, node.constraints));
        for (const column of notNullConstraintColumns(node)) addNotNull(modelInfo.name, column);
      }
      continue;
    }

    if (RESOURCE_DOC_KEY_PREFIXES.some((prefix) => nodeKey.startsWith(prefix))) {
      const info = extractModelInfo(node);
      if (info && !resourceDocs[info.name]) {
        resourceDocs[info.name] = info;
      }
      continue;
    }

    if (nodeKey.startsWith(TEST_KEY_PREFIX)) {
      const constraintTest = extractConstraintsForeignKeyTest(node, nodes);
      if (constraintTest) {
        declaredForeignKeys.push(constraintTest);
        continue;
      }

      const sourceTest = extractSourceRelationshipTest(node, nodes);
      if (sourceTest) {
        sourceRelationshipTests.push(sourceTest);
        continue;
      }

      const relTest = extractRelationshipTest(node, nodes);
      if (relTest) {
        relationshipTests.push(relTest);
        continue;
      }

      const notNull = extractNotNullTest(node, nodes);
      if (notNull) {
        addNotNull(notNull.model, notNull.column);
        continue;
      }

      extractUniqueTest(node, uniqueColumns, nodes);
      extractCompositeUniqueTest(node, compositeUniqueGroups, nodes);
    }
  }

  const compositeForeignKeys = resolveForeignKeyTargets(declaredForeignKeys, models);
  const sources = extractSources(manifest.sources);
  const extra = { notNullColumns, sourceRelationshipTests, sources };
  if (placeholder) {
    // Parse without your credentials: every schema came from placeholder
    // connection details (`erd_studio_placeholder…`). Blank them after all
    // extraction (composite FK targets resolve by the relation's last
    // segment, so they are unaffected), so nothing shows or writes them.
    // `configSchema` is the user's own `config.schema` and is kept.
    for (const info of Object.values(models)) { info.schema = ''; }
    for (const info of Object.values(resourceDocs)) { info.schema = ''; }
    return { models, relationshipTests, uniqueColumns, compositeUniqueGroups, disabledModels, resourceDocs, compositeForeignKeys, ...extra, placeholderProfile: true };
  }
  return { models, relationshipTests, uniqueColumns, compositeUniqueGroups, disabledModels, resourceDocs, compositeForeignKeys, ...extra };
}

/** A non-empty string, trimmed; undefined for anything else (dbt writes `where: null` on every test). */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** A test node's `config.where`, when it limits the rows tested. */
function whereOf(node: Record<string, unknown>): string | undefined {
  const config = node.config;
  return isPlainObject(config) ? text(config.where) : undefined;
}

/** dbt's own `not_null` (no namespace) and dbt_expectations' not-null test. */
const NOT_NULL_TESTS: ReadonlyArray<{ namespace: string | null; name: string }> = [
  { namespace: null, name: 'not_null' },
  { namespace: 'dbt_expectations', name: 'expect_column_values_to_not_be_null' },
];

/**
 * A not-null test node (`test_metadata`, written under `tests:` or
 * `data_tests:`, kwargs top-level or under dbt 1.10's `arguments:` — the
 * manifest records both as `kwargs`): the model it is attached to and the
 * column, as dbt passes it (quoted when the column has `quote: true`). Null
 * when a `where:` config or a `row_condition` limits it to some rows: it
 * does not say the column is never null.
 */
function extractNotNullTest(node: Record<string, unknown>, nodes: Record<string, unknown>): { model: string; column: string } | null {
  const meta = node.test_metadata;
  if (!isPlainObject(meta) || typeof meta.name !== 'string') return null;
  const namespace = typeof meta.namespace === 'string' && meta.namespace !== 'dbt' ? meta.namespace : null;
  if (!NOT_NULL_TESTS.some((t) => t.name === meta.name && t.namespace === namespace)) return null;
  const kwargs = isPlainObject(meta.kwargs) ? meta.kwargs : {};
  if (whereOf(node) || text(kwargs.row_condition)) return null;
  const column = text(kwargs.column_name) ?? text(node.column_name);
  if (!column) return null;
  const model = resolveModelFromTestNode(node, nodes);
  return model ? { model, column } : null;
}

/**
 * The columns a model's contract makes required: a column's own
 * `constraints: [{ type: not_null }]` (or `primary_key`, never null), and a
 * model-level `not_null` / `primary_key` constraint's `columns`.
 */
function notNullConstraintColumns(node: Record<string, unknown>): string[] {
  const requiring = (c: unknown): boolean => isPlainObject(c) && (c.type === 'not_null' || c.type === 'primary_key');
  const out: string[] = [];
  if (isPlainObject(node.columns)) {
    for (const [key, col] of Object.entries(node.columns)) {
      if (!isPlainObject(col) || !Array.isArray(col.constraints) || !col.constraints.some(requiring)) continue;
      out.push(text(col.name) ?? key);
    }
  }
  if (Array.isArray(node.constraints)) {
    for (const c of node.constraints) {
      if (!requiring(c)) continue;
      for (const column of columnList((c as Record<string, unknown>).columns) ?? []) out.push(column);
    }
  }
  return out;
}

/**
 * A relationships test whose `to:` is a dbt `source('raw', 'customers')`: a
 * source is not a model, so no draft draws it; kept to be said. Null for any
 * other test.
 */
function extractSourceRelationshipTest(node: Record<string, unknown>, nodes: Record<string, unknown>): YmlSourceRelationshipTest | null {
  const meta = node.test_metadata;
  if (!isPlainObject(meta) || !isPlainObject(meta.kwargs)) return null;
  const kwargs = meta.kwargs;
  const to = text(kwargs.to);
  const field = text(kwargs.field);
  const fromColumn = text(kwargs.column_name);
  const target = to ? parseSourceCall(to) : undefined;
  if (!target || !field || !fromColumn) return null;
  const fromModel = resolveModelFromTestNode(node, nodes);
  if (!fromModel) return null;
  const file = text(node.original_file_path);
  return { fromModel, fromColumn, source: `${target.source}.${target.table}`, toColumn: field, ...(file ? { file } : {}) };
}

/**
 * The manifest's enabled `sources` (dbt moves a disabled one to `disabled`):
 * one entry per source table, with its `identifier` when it differs from its
 * name and whether the identifier is quoted.
 */
function extractSources(sources: unknown): YmlSourceTable[] {
  if (!isPlainObject(sources)) return [];
  const out: YmlSourceTable[] = [];
  for (const value of Object.values(sources)) {
    if (!isPlainObject(value)) continue;
    const name = text(value.name);
    const source = text(value.source_name);
    if (!name || !source) continue;
    if (isPlainObject(value.config) && value.config.enabled === false) continue;
    const identifier = text(value.identifier);
    const quoting = isPlainObject(value.quoting) ? value.quoting : {};
    const columns = isPlainObject(value.columns)
      ? Object.values(value.columns).filter(isPlainObject).map((c) => ({
        name: typeof c.name === 'string' ? c.name : '',
        description: typeof c.description === 'string' ? c.description : '',
        dataType: typeof c.data_type === 'string' ? c.data_type : null,
      })).filter((c) => c.name !== '')
      : [];
    const uniqueId = text(value.unique_id);
    const projectName = text(value.package_name) ?? (uniqueId?.split('.')[1] || undefined);
    out.push({
      source,
      name,
      ...(identifier && identifier !== name ? { identifier } : {}),
      ...(quoting.identifier === true ? { quoted: true } : {}),
      description: typeof value.description === 'string' ? value.description : '',
      columns,
      file: text(value.original_file_path) ?? '',
      ...(projectName ? { projectName } : {}),
    });
  }
  return out;
}

/** A relationships test's condition: `relationships_where`'s `from_condition` / `to_condition`, and a `where:` config. */
function conditionOf(kwargs: Record<string, unknown>, node: Record<string, unknown>): RelationshipTestCondition | undefined {
  const from = text(kwargs.from_condition);
  const to = text(kwargs.to_condition);
  const where = whereOf(node) ?? text(kwargs.where) ?? text(kwargs.row_condition);
  if (!from && !to && !where) return undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(where ? { where } : {}) };
}

/** A plain (non-null, non-array) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether Parse without your credentials wrote this manifest: its
 * `metadata.env` holds `THROWAWAY_MARKER_KEY` as the string `"1"`.
 */
function isPlaceholderManifest(manifest: Record<string, unknown>): boolean {
  const metadata = manifest.metadata;
  if (!isPlainObject(metadata)) return false;
  const env = metadata.env;
  if (!isPlainObject(env)) return false;
  return env[THROWAWAY_MARKER_KEY] === '1';
}

/** A list of column names, or null when it is not a list of strings. */
function columnList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((c) => typeof c === 'string' && c.trim() !== '')) return null;
  return (value as string[]).map((c) => c.trim());
}

/**
 * A model's dbt ≥ 1.9 model-level `foreign_key` constraints over two or more
 * columns (#133 L2): `columns`, `to` and `to_columns` of one length. `to` is
 * resolved later (`resolveForeignKeyTargets`).
 */
function extractForeignKeyConstraints(fromModel: string, constraints: unknown): Array<CompositeForeignKey & { to: string }> {
  if (!Array.isArray(constraints)) return [];
  const out: Array<CompositeForeignKey & { to: string }> = [];
  for (const raw of constraints) {
    const c = raw as Record<string, unknown> | null;
    if (!c || typeof c !== 'object' || c.type !== 'foreign_key' || typeof c.to !== 'string') continue;
    const fromColumns = columnList(c.columns);
    const toColumns = columnList(c.to_columns);
    if (!fromColumns || !toColumns || fromColumns.length < 2 || fromColumns.length !== toColumns.length) continue;
    out.push({
      fromModel, fromColumns, toModel: '', toColumns, to: c.to,
      ...(typeof c.name === 'string' && c.name.trim() ? { name: c.name.trim() } : {}),
    });
  }
  return out;
}

/**
 * A `dbt_constraints.foreign_key` test over two or more columns (#133 L2):
 * `fk_column_names` on the model the test is attached to, `pk_column_names`
 * on `pk_table_name`. Null for any other test.
 */
function extractConstraintsForeignKeyTest(
  node: Record<string, unknown>,
  nodes: Record<string, unknown>,
): (CompositeForeignKey & { to: string }) | null {
  const meta = node.test_metadata as Record<string, unknown> | undefined;
  if (!meta || meta.namespace !== 'dbt_constraints' || meta.name !== 'foreign_key') return null;
  const kwargs = meta.kwargs as Record<string, unknown> | undefined;
  const fromColumns = columnList(kwargs?.fk_column_names);
  const toColumns = columnList(kwargs?.pk_column_names);
  const to = kwargs?.pk_table_name;
  if (!fromColumns || !toColumns || typeof to !== 'string') return null;
  if (fromColumns.length < 2 || fromColumns.length !== toColumns.length) return null;
  const toModel = parseRefModelName(to);
  const attached = node.attached_node as string | undefined;
  let fromModel: string | undefined;
  if (attached && attached.startsWith(MODEL_KEY_PREFIX)) {
    fromModel = resolveModelNameFromNodeId(attached, nodes);
  } else {
    const refs = (node.depends_on as { nodes?: string[] } | undefined)?.nodes ?? [];
    fromModel = refs.filter((r) => r.startsWith(MODEL_KEY_PREFIX)).map((r) => resolveModelNameFromNodeId(r, nodes)).find((m) => m !== toModel);
  }
  if (!fromModel) return null;
  return { fromModel, fromColumns, toModel: '', toColumns, to };
}

/**
 * Resolve each declaration's `to` to a model: a `ref()` (versioned refs too),
 * or a rendered relation (`"db"."schema"."x"`, `db.schema.x`) by its last
 * identifier, against model names then aliases, without case. Declarations
 * whose target cannot be resolved are dropped; one per (from, columns, to).
 */
function resolveForeignKeyTargets(
  declared: ReadonlyArray<CompositeForeignKey & { to: string }>,
  models: Record<string, ManifestModelInfo>,
): CompositeForeignKey[] {
  const infos = Object.values(models);
  const target = (to: string): string | undefined => {
    const ref = parseRefModelName(to);
    if (ref) return ref;
    const last = to.trim().split('.').pop()?.replace(/^["`[]|["`\]]$/g, '').trim().toLowerCase();
    if (!last) return undefined;
    return infos.find((m) => m.name.toLowerCase() === last)?.name ?? infos.find((m) => m.alias?.toLowerCase() === last)?.name;
  };
  const seen = new Set<string>();
  const out: CompositeForeignKey[] = [];
  for (const { to, ...fk } of declared) {
    const toModel = target(to);
    if (!toModel) continue;
    const key = [fk.fromModel, fk.fromColumns.join('+'), toModel, fk.toColumns.join('+')].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...fk, toModel });
  }
  return out;
}

/**
 * Collect the short names of models dbt has disabled.
 *
 * `{{ config(enabled=false) }}`, a `+enabled: false` subtree in
 * `dbt_project.yml` or an excluded package moves a node out of `nodes` and
 * into the sibling `disabled` dict — keyed by unique_id, with ARRAYS of node
 * dicts as values (dbt records every candidate definition of the name). The
 * `.sql` file stays on disk, so this set is the only evidence that `ref()` to
 * it will not compile.
 *
 * Only `model.` keys are collected: seeds, snapshots and tests share the dict
 * but `ManifestData.models` is a model index, and widening it would change
 * what the Add-Existing picker and the relationship derivation see.
 */
function extractDisabledModels(disabled: unknown): string[] {
  if (!disabled || typeof disabled !== 'object' || Array.isArray(disabled)) {
    return [];
  }

  const names = new Set<string>();

  for (const [nodeKey, value] of Object.entries(disabled as Record<string, unknown>)) {
    if (!nodeKey.startsWith(MODEL_KEY_PREFIX)) {
      continue;
    }

    // Normally an array; tolerate a bare node dict rather than lose the name.
    const candidates = Array.isArray(value) ? value : [value];
    let name: string | undefined;

    for (const candidate of candidates) {
      const entry = candidate as Record<string, unknown> | null;
      if (entry && typeof entry === 'object' && typeof entry.name === 'string' && entry.name) {
        name = entry.name;
        break;
      }
    }

    names.add(name ?? resolveModelNameFromNodeId(nodeKey));
  }

  return [...names];
}

function extractModelInfo(node: Record<string, unknown>): ManifestModelInfo | null {
  const uniqueId = node.unique_id;
  const name = node.name;

  if (typeof name !== 'string' || !name) {
    return null;
  }

  if (typeof uniqueId !== 'string' || !uniqueId) {
    return null;
  }

  const parts = uniqueId.split('.');
  const projectName = parts.length >= 2 ? parts[1] : '';

  const rawColumns = node.columns;
  const columns: ManifestColumn[] = [];

  if (rawColumns && typeof rawColumns === 'object' && !Array.isArray(rawColumns)) {
    for (const col of Object.values(rawColumns as Record<string, Record<string, unknown>>)) {
      if (col && typeof col === 'object') {
        const colMeta = metaOf(col);
        columns.push({
          name: typeof col.name === 'string' ? col.name : '',
          data_type: typeof col.data_type === 'string' ? col.data_type : null,
          description: typeof col.description === 'string' ? col.description : '',
          ...(colMeta ? { meta: colMeta } : {}),
        });
      }
    }
  }

  const meta = metaOf(node);
  const version = parseVersion(node.version);
  const latestVersion = parseVersion(node.latest_version);
  // A versioned model's default alias is `<name>_v<N>`: that is dbt's naming
  // of the version, not a table name the user chose, so it is not recorded.
  const alias = typeof node.alias === 'string' ? node.alias.trim() : '';
  const hasOwnAlias = alias !== '' && alias !== name && (version === undefined || alias !== `${name}_v${version}`);

  const config = node.config;
  const configured = config && typeof config === 'object' ? (config as Record<string, unknown>).schema : undefined;
  const configSchema = typeof configured === 'string' ? configured.trim() : '';

  return {
    name,
    uniqueId,
    projectName,
    schema: typeof node.schema === 'string' ? node.schema : '',
    ...(configSchema !== '' ? { configSchema } : {}),
    ...(hasOwnAlias ? { alias } : {}),
    description: typeof node.description === 'string' ? node.description : '',
    columns,
    ...(meta ? { meta } : {}),
    originalFilePath:
      typeof node.original_file_path === 'string' ? node.original_file_path : undefined,
    ...(version !== undefined ? { version } : {}),
    ...(latestVersion !== undefined ? { latestVersion } : {}),
  };
}

/**
 * A node's or column's dbt `meta`: the top-level `meta` merged with
 * `config.meta`, the config winning per key. dbt 1.10 moved `meta` under
 * `config`; older manifests carry the project-level `+meta` only there.
 */
function metaOf(entry: Record<string, unknown>): Meta | undefined {
  const config = entry.config;
  const configMeta = config && typeof config === 'object' ? (config as Record<string, unknown>).meta : undefined;
  return readMeta(entry.meta, configMeta);
}

/** dbt records `version` / `latest_version` as a number or string; normalise to a number. */
function parseVersion(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/**
 * Decide whether `candidate` should replace `existing` when two manifest
 * nodes resolve to the same short model name (dbt versioned models).
 *
 * Preference order: the node dbt marks as `latest_version`, then the highest
 * numeric version, otherwise keep the existing entry.
 */
function isPreferredVersion(candidate: ManifestModelInfo, existing: ManifestModelInfo): boolean {
  const candidateIsLatest =
    candidate.version !== undefined && candidate.version === candidate.latestVersion;
  const existingIsLatest =
    existing.version !== undefined && existing.version === existing.latestVersion;

  if (candidateIsLatest !== existingIsLatest) {
    return candidateIsLatest;
  }
  if (candidate.version !== undefined && existing.version !== undefined) {
    return candidate.version > existing.version;
  }
  return false;
}

/**
 * Extract relationship test info from a manifest test node.
 *
 * Matches any test with relationship-like kwargs structure:
 * - Standard: test_metadata.name = 'relationships'
 * - Custom: test_metadata.name starts with 'relationships' (e.g. 'relationships_where')
 * - Fallback: any test with kwargs.column_name, kwargs.field, kwargs.to containing ref()
 */
function extractRelationshipTest(
  node: Record<string, unknown>,
  nodes: Record<string, unknown>,
): ManifestRelationshipTest | null {
  const testMetadata = node.test_metadata as Record<string, unknown> | undefined;
  if (!testMetadata) {
    return null;
  }

  const kwargs = testMetadata.kwargs as Record<string, unknown> | undefined;
  if (!kwargs) {
    return null;
  }

  const fromColumn = kwargs.column_name;
  const toColumn = kwargs.field;
  const toRef = kwargs.to;

  if (
    typeof fromColumn !== 'string' ||
    typeof toColumn !== 'string' ||
    typeof toRef !== 'string'
  ) {
    return null;
  }

  // Handles ref('m'), ref('proj', 'm') and versioned ref('m', v=2) / version=2
  const toModel = parseRefModelName(toRef);

  if (!toModel) {
    return null;
  }

  const attachedNode = node.attached_node as string | undefined;
  let fromModel: string | undefined;

  if (attachedNode && attachedNode.startsWith('model.')) {
    fromModel = resolveModelNameFromNodeId(attachedNode, nodes);
  } else {
    const dependsOn = node.depends_on as { nodes?: string[] } | undefined;
    const nodeRefs = dependsOn?.nodes ?? [];

    for (const ref of nodeRefs) {
      if (ref.startsWith('model.')) {
        const modelName = resolveModelNameFromNodeId(ref, nodes);
        if (modelName !== toModel) {
          fromModel = modelName;
          break;
        }
      }
    }
  }

  if (!fromModel) {
    return null;
  }

  // relationships_where holds for the rows its conditions pick; a where: config likewise (the yml reader's rule).
  const condition = conditionOf(kwargs, node);
  const conditional = testMetadata.name === 'relationships_where' || condition !== undefined;
  const file = text(node.original_file_path);
  return {
    fromModel, fromColumn, toModel, toColumn,
    ...(conditional ? { conditional: true as const } : {}),
    ...(condition ? { condition } : {}),
    ...(file ? { file } : {}),
  };
}

function extractUniqueTest(
  node: Record<string, unknown>,
  uniqueColumns: Record<string, string[]>,
  nodes: Record<string, unknown>,
): void {
  const testMetadata = node.test_metadata as Record<string, unknown> | undefined;
  if (!testMetadata || testMetadata.name !== 'unique') {
    return;
  }

  const kwargs = testMetadata.kwargs as Record<string, unknown> | undefined;
  const columnName = kwargs?.column_name;
  if (typeof columnName !== 'string') {
    return;
  }

  const modelName = resolveModelFromTestNode(node, nodes);
  if (!modelName) {
    return;
  }

  if (!uniqueColumns[modelName]) {
    uniqueColumns[modelName] = [];
  }
  if (!uniqueColumns[modelName].includes(columnName)) {
    uniqueColumns[modelName].push(columnName);
  }
}

function extractCompositeUniqueTest(
  node: Record<string, unknown>,
  compositeUniqueGroups: Record<string, string[][]>,
  nodes: Record<string, unknown>,
): void {
  const testMetadata = node.test_metadata as Record<string, unknown> | undefined;
  if (!testMetadata || testMetadata.name !== 'unique_combination_of_columns') {
    return;
  }

  const kwargs = testMetadata.kwargs as Record<string, unknown> | undefined;
  const combinationOfColumns = kwargs?.combination_of_columns;
  if (!Array.isArray(combinationOfColumns)) {
    return;
  }

  const columns = combinationOfColumns.filter(
    (c): c is string => typeof c === 'string',
  );
  if (columns.length === 0) {
    return;
  }

  const modelName = resolveModelFromTestNode(node, nodes);
  if (!modelName) {
    return;
  }

  if (!compositeUniqueGroups[modelName]) {
    compositeUniqueGroups[modelName] = [];
  }
  compositeUniqueGroups[modelName].push(columns);
}

function resolveModelFromTestNode(
  node: Record<string, unknown>,
  nodes: Record<string, unknown>,
): string | undefined {
  const attachedNode = node.attached_node as string | undefined;
  if (attachedNode && attachedNode.startsWith('model.')) {
    return resolveModelNameFromNodeId(attachedNode, nodes);
  }

  const dependsOn = node.depends_on as { nodes?: string[] } | undefined;
  const nodeRefs = dependsOn?.nodes ?? [];

  for (const ref of nodeRefs) {
    if (ref.startsWith('model.')) {
      return resolveModelNameFromNodeId(ref, nodes);
    }
  }

  return undefined;
}
