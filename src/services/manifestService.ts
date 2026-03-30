/**
 * ManifestService — parses dbt's target/manifest.json to extract model
 * and column metadata. Uses JSON.parse in a worker thread for non-blocking
 * parsing of large manifests (~14x faster than stream-json for 60MB files).
 *
 * Only the "nodes" section is extracted; macros, sources, exposures, and
 * metrics are skipped to minimise memory usage.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

import type {
  ManifestColumn,
  ManifestData,
  ManifestModelInfo,
  ManifestRelationshipTest,
  ManifestWorkerError,
  ManifestWorkerResult,
} from '../types/manifest';

/** Reconstruct Maps and Sets from the worker's plain-object result. */
function deserializeWorkerResult(raw: ManifestWorkerResult): ManifestData {
  const models = new Map(Object.entries(raw.models));

  const uniqueColumns = new Map<string, Set<string>>();
  for (const [model, cols] of Object.entries(raw.uniqueColumns)) {
    uniqueColumns.set(model, new Set(cols));
  }

  const compositeUniqueGroups = new Map(Object.entries(raw.compositeUniqueGroups));

  return {
    models,
    relationshipTests: raw.relationshipTests,
    uniqueColumns,
    compositeUniqueGroups,
  };
}

export class ManifestService {
  private cache: ManifestData | null = null;
  private loadPromise: Promise<ManifestData> | null = null;
  private loadId = 0;

  /**
   * Last successfully parsed manifest data. Survives invalidate() so it can
   * serve as a fallback when a parse fails (e.g. manifest mid-write by dbt).
   */
  private lastKnownGood: ManifestData | null = null;

  /**
   * True when the most recent loadManifest() returned stale/fallback data
   * because the parse failed. Callers can check this to schedule a retry.
   */
  private _isStale = false;
  get isStale(): boolean {
    return this._isStale;
  }

  /**
   * Parse the manifest and cache model data.
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
        // Semantic regression: parse succeeded but returned 0 models when
        // we previously had data. This happens when dbt partially flushes
        // a valid-but-incomplete JSON file (e.g. `{"metadata":{},"nodes":{}}`).
        // Treat it like a parse failure — serve stale data and trigger retry.
        if (
          result.models.size === 0 &&
          this.lastKnownGood &&
          this.lastKnownGood.models.size > 0
        ) {
          console.warn(
            '[ManifestService] Parse returned 0 models (previously had data). ' +
            'File likely mid-write. Returning last known good data.',
          );
          this.cache = this.lastKnownGood;
          this._isStale = true;
          return this.lastKnownGood;
        }

        this.cache = result;
        this.lastKnownGood = result;
        this._isStale = false;
      }
      return result;
    } catch (err) {
      // Parse failed — likely manifest is mid-write by dbt.
      // Return stale data (or empty) so the graph stays visible.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[ManifestService] Parse failed (file may be mid-write): ${message}. ` +
        'Returning last known good data.',
      );
      const fallback = this.lastKnownGood ?? this.emptyManifest();
      if (currentLoadId === this.loadId) {
        this.cache = fallback;
        this._isStale = true;
      }
      return fallback;
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
    this._isStale = false;
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

      const parts = filePath.split('/');
      if (parts.length >= 2) {
        folders.add(`${parts[0]}/${parts[1]}`);
      }
    }

    return Array.from(folders).sort();
  }

  /**
   * Parse manifest.json in a worker thread using JSON.parse.
   * File existence and 0-byte checks run on the main thread for fast rejection.
   */
  private parseManifest(projectPath: string): Promise<ManifestData> {
    const manifestPath = path.join(projectPath, 'target', 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
      console.warn(
        `[ManifestService] manifest.json not found at ${manifestPath}. ` +
        'Run "dbt compile" to generate it.'
      );
      return Promise.resolve(this.emptyManifest());
    }

    // Guard: file exists but is 0 bytes — dbt truncates the file before
    // writing new content (Python open("w")), so the watcher can fire
    // in between truncation and write. Rejecting here triggers the
    // stale-while-revalidate fallback in loadManifest().
    const stat = fs.statSync(manifestPath);
    if (stat.size === 0) {
      return Promise.reject(new Error('Manifest file is empty (likely mid-write by dbt)'));
    }

    return new Promise<ManifestData>((resolve, reject) => {
      // In production (bundled by esbuild), both extension.js and manifestWorker.js
      // live in dist/. When running tests (vitest, unbundled), __dirname is src/services/
      // so we resolve from the project root's dist/ directory instead.
      const isUnbundled = __dirname.endsWith(path.join('src', 'services'));
      const workerPath = isUnbundled
        ? path.resolve(__dirname, '..', '..', 'dist', 'manifestWorker.js')
        : path.join(__dirname, 'manifestWorker.js');
      const worker = new Worker(workerPath);

      worker.once('message', (msg: ManifestWorkerResult | ManifestWorkerError) => {
        worker.terminate();
        if ('error' in msg) {
          console.error(`[ManifestService] Failed to parse manifest: ${(msg as ManifestWorkerError).error}`);
          reject(new Error(`Failed to parse manifest.json: ${(msg as ManifestWorkerError).error}`));
          return;
        }
        resolve(deserializeWorkerResult(msg as ManifestWorkerResult));
      });

      worker.once('error', (err) => {
        worker.terminate();
        reject(new Error(`Manifest worker crashed: ${err.message}`));
      });

      worker.once('exit', (code) => {
        // Fires if the worker exits without posting a message (e.g. OOM kill).
        // If resolve/reject was already called, this is a no-op.
        reject(new Error(`Manifest worker exited unexpectedly with code ${code}`));
      });

      worker.postMessage(manifestPath);
    });
  }

  private emptyManifest(): ManifestData {
    return {
      models: new Map(),
      relationshipTests: [],
      uniqueColumns: new Map(),
      compositeUniqueGroups: new Map(),
    };
  }
}
