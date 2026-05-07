/**
 * Pure extraction functions for dbt manifest.json nodes.
 *
 * Shared between the manifest worker thread and unit tests.
 * Returns plain objects/arrays (not Maps/Sets) so the result
 * can be transferred via structured clone (worker postMessage).
 */

import type {
  ManifestColumn,
  ManifestModelInfo,
  ManifestRelationshipTest,
  ManifestWorkerResult,
} from '../types/manifest';

const MODEL_KEY_PREFIX = 'model.';
const TEST_KEY_PREFIX = 'test.';

/**
 * Extract all model and test data from a parsed manifest JSON object.
 * This is the single entry point called by the worker thread.
 */
export function extractManifestData(
  manifest: Record<string, unknown>,
): ManifestWorkerResult {
  const nodes = manifest.nodes as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes !== 'object') {
    return { models: {}, relationshipTests: [], uniqueColumns: {}, compositeUniqueGroups: {} };
  }

  const models: Record<string, ManifestModelInfo> = {};
  const relationshipTests: ManifestRelationshipTest[] = [];
  const uniqueColumns: Record<string, string[]> = {};
  const compositeUniqueGroups: Record<string, string[][]> = {};

  for (const [nodeKey, nodeValue] of Object.entries(nodes)) {
    const node = nodeValue as Record<string, unknown>;

    if (nodeKey.startsWith(MODEL_KEY_PREFIX)) {
      const modelInfo = extractModelInfo(node);
      if (modelInfo) {
        models[modelInfo.name] = modelInfo;
      }
      continue;
    }

    if (nodeKey.startsWith(TEST_KEY_PREFIX)) {
      const relTest = extractRelationshipTest(node);
      if (relTest) {
        relationshipTests.push(relTest);
        continue;
      }

      extractUniqueTest(node, uniqueColumns);
      extractCompositeUniqueTest(node, compositeUniqueGroups);
    }
  }

  return { models, relationshipTests, uniqueColumns, compositeUniqueGroups };
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
        columns.push({
          name: typeof col.name === 'string' ? col.name : '',
          data_type: typeof col.data_type === 'string' ? col.data_type : null,
          description: typeof col.description === 'string' ? col.description : '',
        });
      }
    }
  }

  return {
    name,
    uniqueId,
    projectName,
    schema: typeof node.schema === 'string' ? node.schema : '',
    description: typeof node.description === 'string' ? node.description : '',
    columns,
    originalFilePath:
      typeof node.original_file_path === 'string' ? node.original_file_path : undefined,
  };
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

  const refMatch = toRef.match(/ref\(['"]([\w]+)['"]\s*\)/);
  const twoArgRefMatch = toRef.match(/ref\(['"][^'"]+['"],\s*['"]([\w]+)['"]\s*\)/);
  const toModel = twoArgRefMatch?.[1] ?? refMatch?.[1];

  if (!toModel) {
    return null;
  }

  const attachedNode = node.attached_node as string | undefined;
  let fromModel: string | undefined;

  if (attachedNode && attachedNode.startsWith('model.')) {
    const parts = attachedNode.split('.');
    fromModel = parts[parts.length - 1];
  } else {
    const dependsOn = node.depends_on as { nodes?: string[] } | undefined;
    const nodeRefs = dependsOn?.nodes ?? [];

    for (const ref of nodeRefs) {
      if (ref.startsWith('model.')) {
        const parts = ref.split('.');
        const modelName = parts[parts.length - 1];
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

  const modelName = resolveModelFromTestNode(node);
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

  const modelName = resolveModelFromTestNode(node);
  if (!modelName) {
    return;
  }

  if (!compositeUniqueGroups[modelName]) {
    compositeUniqueGroups[modelName] = [];
  }
  compositeUniqueGroups[modelName].push(columns);
}

function resolveModelFromTestNode(node: Record<string, unknown>): string | undefined {
  const attachedNode = node.attached_node as string | undefined;
  if (attachedNode && attachedNode.startsWith('model.')) {
    const parts = attachedNode.split('.');
    return parts[parts.length - 1];
  }

  const dependsOn = node.depends_on as { nodes?: string[] } | undefined;
  const nodeRefs = dependsOn?.nodes ?? [];

  for (const ref of nodeRefs) {
    if (ref.startsWith('model.')) {
      const parts = ref.split('.');
      return parts[parts.length - 1];
    }
  }

  return undefined;
}
