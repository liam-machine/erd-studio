/**
 * ManifestService — stream-parses dbt's target/manifest.json to extract model
 * and column metadata. Uses stream-json to handle ~43MB manifests without
 * blocking the extension host.
 *
 * Only the "nodes" section is extracted; macros, sources, exposures, and
 * metrics are skipped to minimise memory usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/Pick';
import { streamObject } from 'stream-json/streamers/StreamObject';
import { chain } from 'stream-chain';

import type {
  ManifestColumn,
  ManifestData,
  ManifestModelInfo,
  ManifestRelationshipTest,
} from '../types/manifest';

const MODEL_KEY_PREFIX = 'model.';
const TEST_KEY_PREFIX = 'test.';

export class ManifestService {
  private cache: ManifestData | null = null;
  private loadPromise: Promise<ManifestData> | null = null;
  private loadId = 0;

  /**
   * Stream-parse the manifest and cache model data.
   * Returns cached data on subsequent calls until invalidate() is called.
   *
   * If the manifest file does not exist, returns an empty ManifestData
   * (graceful degradation — user may not have run `dbt compile` yet).
   */
  async loadManifest(projectPath: string): Promise<ManifestData> {
    if (this.cache) {
      return this.cache;
    }

    // Deduplicate concurrent calls — if a parse is already in progress, wait for it
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const currentLoadId = ++this.loadId;
    this.loadPromise = this.parseManifest(projectPath);
    try {
      const result = await this.loadPromise;
      // Only cache if we haven't been invalidated during the parse
      if (currentLoadId === this.loadId) {
        this.cache = result;
      }
      return result;
    } finally {
      if (currentLoadId === this.loadId) {
        this.loadPromise = null;
      }
    }
  }

  /** Get columns for a specific model by short name (e.g. "dim_work_lot"). */
  getModelColumns(modelName: string): ManifestColumn[] {
    const model = this.cache?.models.get(modelName);
    return model?.columns ?? [];
  }

  /** Check if a model exists in the manifest by short name. */
  hasModel(modelName: string): boolean {
    return this.cache?.models.has(modelName) ?? false;
  }

  /** Get all short model names from the manifest. */
  getModelNames(): string[] {
    if (!this.cache) {
      return [];
    }
    return Array.from(this.cache.models.keys());
  }

  /** Get full model info by short name. */
  getModel(modelName: string): ManifestModelInfo | undefined {
    return this.cache?.models.get(modelName);
  }

  /** Get all relationship tests from the manifest. */
  getRelationshipTests(): ManifestRelationshipTest[] {
    return this.cache?.relationshipTests ?? [];
  }

  /** Clear the cache so the next loadManifest call re-parses from disk. */
  invalidate(): void {
    this.loadId++;
    this.cache = null;
    this.loadPromise = null;
  }

  /**
   * Get unique top-level model folders from the manifest.
   * Extracts the first two path segments (e.g., "models/silver") from each model's
   * originalFilePath. Only includes paths starting with "models/".
   *
   * @returns Sorted array of folder paths (e.g., ["models/gold", "models/silver"])
   */
  getModelFolders(): string[] {
    if (!this.cache) {
      return [];
    }

    const folders = new Set<string>();
    for (const model of this.cache.models.values()) {
      const filePath = model.originalFilePath;
      if (!filePath || !filePath.startsWith('models/')) {
        continue;
      }

      // Extract top-level folder: "models/silver/core/dim_customer.sql" → "models/silver"
      const parts = filePath.split('/');
      if (parts.length >= 2) {
        folders.add(`${parts[0]}/${parts[1]}`);
      }
    }

    return Array.from(folders).sort();
  }

  private async parseManifest(projectPath: string): Promise<ManifestData> {
    const manifestPath = path.join(projectPath, 'target', 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(
        `[ManifestService] manifest.json not found at ${manifestPath}. ` +
        'Run "dbt compile" to generate it.'
      );
      return {
        models: new Map(),
        relationshipTests: [],
        uniqueColumns: new Map(),
        compositeUniqueGroups: new Map(),
      };
    }

    const models = new Map<string, ManifestModelInfo>();
    const relationshipTests: ManifestRelationshipTest[] = [];
    const uniqueColumns = new Map<string, Set<string>>();
    const compositeUniqueGroups = new Map<string, string[][]>();

    return new Promise<ManifestData>((resolve, reject) => {
      const pipeline = chain([
        fs.createReadStream(manifestPath, { encoding: 'utf-8' }),
        parser(),
        pick({ filter: 'nodes' }),
        streamObject(),
      ]);

      pipeline.on('data', (data: { key: string; value: unknown }) => {
        // Each entry is a key-value pair from the "nodes" object.
        // key = manifest node key (e.g. "model.my_project.dim_work_lot")
        // value = the full node object
        const nodeKey = data.key;
        const node = data.value as Record<string, unknown>;

        // Extract model nodes
        if (nodeKey.startsWith(MODEL_KEY_PREFIX)) {
          const modelInfo = this.extractModelInfo(node);
          if (modelInfo) {
            models.set(modelInfo.name, modelInfo);
          }
          return;
        }

        // Extract test nodes (relationships, unique, unique_combination_of_columns)
        if (nodeKey.startsWith(TEST_KEY_PREFIX)) {
          const relTest = this.extractRelationshipTest(node);
          if (relTest) {
            relationshipTests.push(relTest);
            return;
          }

          this.extractUniqueTest(node, uniqueColumns);
          this.extractCompositeUniqueTest(node, compositeUniqueGroups);
          return;
        }
      });

      pipeline.on('end', () => {
        resolve({ models, relationshipTests, uniqueColumns, compositeUniqueGroups });
      });

      pipeline.on('error', (err: Error) => {
        console.error(`[ManifestService] Failed to parse manifest: ${err.message}`);
        pipeline.destroy();
        reject(new Error(`Failed to parse manifest.json: ${err.message}`));
      });
    });
  }

  private extractModelInfo(node: Record<string, unknown>): ManifestModelInfo | null {
    const uniqueId = node.unique_id;
    const name = node.name;

    if (typeof name !== 'string' || !name) {
      return null;
    }

    if (typeof uniqueId !== 'string' || !uniqueId) {
      return null;
    }

    // Extract project name from unique_id: "model.project_name.model_name"
    const parts = uniqueId.split('.');
    const projectName = parts.length >= 2 ? parts[1] : '';

    // Extract columns from the manifest node
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
   *
   * kwargs structure:
   * - kwargs.column_name = FK column in the source model
   * - kwargs.field = PK column in the target model
   * - kwargs.to = ref('target_model_name')
   */
  private extractRelationshipTest(
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

    // Extract column names — must have the relationship kwargs signature
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

    // Must contain a ref() call to be a relationship test
    // Handles both ref('model') and ref('project', 'model') (cross-project)
    const refMatch = toRef.match(/ref\(['"]([\w]+)['"]\s*\)/);
    const twoArgRefMatch = toRef.match(/ref\(['"][^'"]+['"],\s*['"]([\w]+)['"]\s*\)/);
    const toModel = twoArgRefMatch?.[1] ?? refMatch?.[1];

    if (!toModel) {
      return null;
    }

    // Extract fromModel from attached_node or depends_on.nodes
    // For relationship tests, we need the model that is NOT the target
    const attachedNode = node.attached_node as string | undefined;
    let fromModel: string | undefined;

    if (attachedNode && attachedNode.startsWith('model.')) {
      const parts = attachedNode.split('.');
      fromModel = parts[parts.length - 1];
    } else {
      // Fallback: find the first model node that is NOT the target model
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

    return {
      fromModel,
      fromColumn,
      toModel,
      toColumn,
    };
  }

  /**
   * Extract a standalone `unique` test from a manifest test node.
   *
   * Unique tests have:
   * - test_metadata.name = 'unique'
   * - test_metadata.kwargs.column_name = the unique column
   * - attached_node or depends_on.nodes to identify the model
   */
  private extractUniqueTest(
    node: Record<string, unknown>,
    uniqueColumns: Map<string, Set<string>>,
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

    const modelName = this.resolveModelFromTestNode(node);
    if (!modelName) {
      return;
    }

    let columns = uniqueColumns.get(modelName);
    if (!columns) {
      columns = new Set<string>();
      uniqueColumns.set(modelName, columns);
    }
    columns.add(columnName);
  }

  /**
   * Extract a `unique_combination_of_columns` test from a manifest test node.
   *
   * These tests have:
   * - test_metadata.name = 'unique_combination_of_columns'
   * - test_metadata.kwargs.combination_of_columns = ['col_a', 'col_b']
   * - attached_node or depends_on.nodes to identify the model
   */
  private extractCompositeUniqueTest(
    node: Record<string, unknown>,
    compositeUniqueGroups: Map<string, string[][]>,
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

    // Validate all entries are strings
    const columns = combinationOfColumns.filter(
      (c): c is string => typeof c === 'string',
    );
    if (columns.length === 0) {
      return;
    }

    const modelName = this.resolveModelFromTestNode(node);
    if (!modelName) {
      return;
    }

    let groups = compositeUniqueGroups.get(modelName);
    if (!groups) {
      groups = [];
      compositeUniqueGroups.set(modelName, groups);
    }
    groups.push(columns);
  }

  /**
   * Resolve the model name from a test node using attached_node (preferred)
   * or depends_on.nodes (fallback).
   */
  private resolveModelFromTestNode(node: Record<string, unknown>): string | undefined {
    // Prefer attached_node (dbt 1.0+)
    const attachedNode = node.attached_node as string | undefined;
    if (attachedNode && attachedNode.startsWith('model.')) {
      const parts = attachedNode.split('.');
      return parts[parts.length - 1];
    }

    // Fallback: first model in depends_on.nodes
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
}
