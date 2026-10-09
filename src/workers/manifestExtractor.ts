/**
 * Pure extraction functions for dbt manifest.json nodes.
 *
 * Shared between the manifest worker thread and unit tests.
 * Returns plain objects/arrays (not Maps/Sets) so the result
 * can be transferred via structured clone (worker postMessage).
 */

import type { Meta } from '../types/semantic';
import type {
  CompositeForeignKey,
  ManifestColumn,
  ManifestModelInfo,
  ManifestRelationshipTest,
  ManifestWorkerResult,
} from '../types/manifest';
import { readMeta } from '@erd-studio/core';
import { parseRefModelName, resolveModelNameFromNodeId } from '../services/nameUtils';

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
    };
  }

  const models: Record<string, ManifestModelInfo> = {};
  const relationshipTests: ManifestRelationshipTest[] = [];
  const uniqueColumns: Record<string, string[]> = {};
  const compositeUniqueGroups: Record<string, string[][]> = {};
  const resourceDocs: Record<string, ManifestModelInfo> = {};
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

      const relTest = extractRelationshipTest(node, nodes);
      if (relTest) {
        relationshipTests.push(relTest);
        continue;
      }

      extractUniqueTest(node, uniqueColumns, nodes);
      extractCompositeUniqueTest(node, compositeUniqueGroups, nodes);
    }
  }

  const compositeForeignKeys = resolveForeignKeyTargets(declaredForeignKeys, models);
  return { models, relationshipTests, uniqueColumns, compositeUniqueGroups, disabledModels, resourceDocs, compositeForeignKeys };
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

  return {
    name,
    uniqueId,
    projectName,
    schema: typeof node.schema === 'string' ? node.schema : '',
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

  return { fromModel, fromColumn, toModel, toColumn };
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
