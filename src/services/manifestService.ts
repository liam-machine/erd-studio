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

  private async parseManifest(projectPath: string): Promise<ManifestData> {
    const manifestPath = path.join(projectPath, 'target', 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(
        `[ManifestService] manifest.json not found at ${manifestPath}. ` +
        'Run "dbt compile" to generate it.'
      );
      return { models: new Map(), relationshipTests: [] };
    }

    const models = new Map<string, ManifestModelInfo>();
    const relationshipTests: ManifestRelationshipTest[] = [];

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

        // Extract relationship test nodes
        if (nodeKey.startsWith(TEST_KEY_PREFIX)) {
          const relTest = this.extractRelationshipTest(node);
          if (relTest) {
            relationshipTests.push(relTest);
          }
          return;
        }
      });

      pipeline.on('end', () => {
        resolve({ models, relationshipTests });
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
    };
  }

  /**
   * Extract relationship test info from a manifest test node.
   *
   * Relationship tests in dbt manifest have:
   * - test_metadata.name = 'relationships'
   * - test_metadata.kwargs.column_name = FK column in the source model
   * - test_metadata.kwargs.field = PK column in the target model
   * - test_metadata.kwargs.to = ref('target_model_name')
   * - depends_on.nodes includes the source model (where the FK is)
   */
  private extractRelationshipTest(
    node: Record<string, unknown>,
  ): ManifestRelationshipTest | null {
    // Check if this is a relationship test
    const testMetadata = node.test_metadata as Record<string, unknown> | undefined;
    if (!testMetadata || testMetadata.name !== 'relationships') {
      return null;
    }

    const kwargs = testMetadata.kwargs as Record<string, unknown> | undefined;
    if (!kwargs) {
      return null;
    }

    // Extract column names
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

    // Parse model name from ref('model_name') or ref("model_name")
    const refMatch = toRef.match(/ref\(['"](.+?)['"]\)/);
    const toModel = refMatch?.[1];

    if (!toModel) {
      return null;
    }

    // Extract fromModel from attached_node (preferred) or depends_on.nodes (fallback)
    // attached_node was added in dbt 1.0+ and is the most reliable source
    const attachedNode = node.attached_node as string | undefined;
    let fromModel: string | undefined;

    if (attachedNode && attachedNode.startsWith('model.')) {
      // Use attached_node if available (more reliable)
      const parts = attachedNode.split('.');
      fromModel = parts[parts.length - 1];
    } else {
      // Fallback: find the first model node that is NOT the target model
      // This may be less reliable for complex dependency chains
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

      if (fromModel) {
        console.warn(
          `[ManifestService] Relationship test "${node.unique_id ?? 'unknown'}" ` +
            `missing attached_node; inferred fromModel="${fromModel}" from depends_on.nodes`,
        );
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
}
