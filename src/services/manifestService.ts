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

import type { ManifestColumn, ManifestData, ManifestModelInfo } from '../types/manifest';

const MODEL_KEY_PREFIX = 'model.';

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
      return { models: new Map() };
    }

    const models = new Map<string, ManifestModelInfo>();

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

        if (!nodeKey.startsWith(MODEL_KEY_PREFIX)) {
          return; // Skip non-model nodes (tests, seeds, snapshots, etc.)
        }

        const node = data.value as Record<string, unknown>;
        const modelInfo = this.extractModelInfo(node);
        if (modelInfo) {
          models.set(modelInfo.name, modelInfo);
        }
      });

      pipeline.on('end', () => {
        resolve({ models });
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
}
