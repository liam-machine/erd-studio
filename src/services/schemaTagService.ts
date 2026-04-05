/**
 * SchemaTagService — syncs `domain:{domainName}` tags to dbt model YAML files.
 *
 * When a model is added to or removed from an ERD domain, this service
 * adds or removes the corresponding tag in the model's schema YAML file.
 * Uses the `yaml` package for comment-preserving round-trips.
 *
 * Tag format: `domain:{domainName}` where domainName is the domain JSON
 * filename without extension (e.g. `domain:work-lots`).
 *
 * YAML path is resolved by scanning the workspace filesystem for
 * `{modelName}.yml` or `{modelName}.yaml` (one YAML per model convention).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Document, parseDocument, isSeq, isMap, YAMLMap, YAMLSeq } from 'yaml';

import type { DomainService } from './domainService';

const DOMAIN_TAG_PREFIX = 'domain:';

/** Directories to skip during filesystem walk. */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'target', '.git', '.venv', 'venv',
  '__pycache__', 'dist', '.tox', '.mypy_cache',
]);

export class SchemaTagService {
  /** Transient cache populated during a single `reconcileAll` call. */
  private _yamlCache: Map<string, string> | undefined = undefined;

  constructor(
    private readonly domainService: DomainService,
    private readonly workspaceRoot: string,
    private readonly semanticDir: string,
  ) {}

  /**
   * Add a `domain:{domainName}` tag to the model's dbt YAML file.
   * Called after a model is successfully added to a domain.
   * Silently skips if the YAML file doesn't exist or the model isn't found in it.
   */
  async addDomainTag(modelName: string, domainName: string): Promise<void> {
    const yamlPath = this.resolveYamlPath(modelName);
    if (!yamlPath) {
      return;
    }

    const doc = this.readYaml(yamlPath);
    if (!doc) {
      return;
    }

    const modelNode = this.findModelNode(doc, modelName);
    if (!modelNode) {
      return;
    }

    const tag = `${DOMAIN_TAG_PREFIX}${domainName}`;
    const tags = this.getOrCreateTagsSeq(doc, modelNode);

    if (this.seqContains(tags, tag)) {
      return;
    }

    tags.add(tag);
    this.writeYaml(yamlPath, doc);

    const chosen = await vscode.window.showInformationMessage(
      `Tag "${tag}" added to ${path.basename(yamlPath)}`,
      'Show File',
    );
    if (chosen === 'Show File') {
      await vscode.window.showTextDocument(vscode.Uri.file(yamlPath), { preview: true });
    }
  }

  /**
   * Remove a `domain:{domainName}` tag from the model's dbt YAML file.
   * Checks all other domains first — only removes if no other domain claims this model.
   * Called after a model is successfully removed from a domain.
   */
  async removeDomainTag(
    modelName: string,
    domainName: string,
    excludeFilePath: string,
  ): Promise<void> {
    if (this.isModelInOtherDomain(modelName, domainName, excludeFilePath)) {
      return;
    }

    const yamlPath = this.resolveYamlPath(modelName);
    if (!yamlPath) {
      return;
    }

    const doc = this.readYaml(yamlPath);
    if (!doc) {
      return;
    }

    const modelNode = this.findModelNode(doc, modelName);
    if (!modelNode) {
      return;
    }

    const tag = `${DOMAIN_TAG_PREFIX}${domainName}`;
    const configNode = modelNode.get('config');
    if (!isMap(configNode)) {
      return;
    }
    const tagsNode = configNode.get('tags');
    if (!isSeq(tagsNode)) {
      return;
    }

    const idx = this.seqIndexOf(tagsNode, tag);
    if (idx === -1) {
      return;
    }

    tagsNode.delete(idx);

    // Clean up empty tags array and config map
    if (tagsNode.items.length === 0) {
      configNode.delete('tags');
    }
    if (isMap(configNode) && configNode.items.length === 0) {
      modelNode.delete('config');
    }

    this.writeYaml(yamlPath, doc);

    const chosen = await vscode.window.showInformationMessage(
      `Tag "${tag}" removed from ${path.basename(yamlPath)}`,
      'Show File',
    );
    if (chosen === 'Show File') {
      await vscode.window.showTextDocument(vscode.Uri.file(yamlPath), { preview: true });
    }
  }

  /**
   * Bulk reconcile all domain tags across the workspace.
   * Scans every domain file, builds expected tags per model, then
   * adds missing tags and removes stale ones from YAML files.
   */
  async reconcileAll(): Promise<{ added: number; removed: number; skipped: number; errors: string[] }> {
    const result = { added: 0, removed: 0, skipped: 0, errors: [] as string[] };

    try {
      // Build YAML index once for the entire reconciliation
      this._yamlCache = this.buildYamlIndex();

      // Build expected: model → Set<domainName>
      const expected = new Map<string, Set<string>>();
      const allDomains = this.domainService.listDomains(this.workspaceRoot, this.semanticDir);

      for (const summary of allDomains) {
        try {
          const domain = this.domainService.getDomain(summary.filePath);
          const models = domain.logical?.models ?? [];
          for (const model of models) {
            let domains = expected.get(model.name);
            if (!domains) {
              domains = new Set();
              expected.set(model.name, domains);
            }
            domains.add(summary.domain);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Failed to read ${summary.filePath}: ${msg}`);
        }
      }

      // Pass 1 — Forward: sync tags for models currently in domains
      const processedPaths = new Set<string>();

      for (const modelName of expected.keys()) {
        const yamlPath = this.resolveYamlPath(modelName);
        if (!yamlPath) {
          result.skipped++;
          continue;
        }

        const doc = this.readYaml(yamlPath);
        if (!doc) {
          result.skipped++;
          continue;
        }

        const modelNode = this.findModelNode(doc, modelName);
        if (!modelNode) {
          result.skipped++;
          continue;
        }

        processedPaths.add(yamlPath);
        const domainNames = expected.get(modelName)!;
        let modified = false;

        // Add missing domain tags
        const tags = this.getOrCreateTagsSeq(doc, modelNode);
        for (const domainName of domainNames) {
          const tag = `${DOMAIN_TAG_PREFIX}${domainName}`;
          if (!this.seqContains(tags, tag)) {
            tags.add(tag);
            result.added++;
            modified = true;
          }
        }

        // Remove stale domain tags (tags for domains this model no longer belongs to)
        modified = this.removeStaleTagsFromNode(tags, domainNames, result) || modified;

        if (modified) {
          try {
            this.writeYaml(yamlPath, doc);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to write ${yamlPath}: ${msg}`);
          }
        }
      }

      // Pass 2 — Reverse: clean orphaned domain tags from YAML files
      // not already fully processed in Pass 1
      for (const [, yamlPath] of this._yamlCache) {
        if (processedPaths.has(yamlPath)) {
          continue;
        }

        const doc = this.readYaml(yamlPath);
        if (!doc) { continue; }

        const modelsNode = doc.get('models');
        if (!isSeq(modelsNode)) { continue; }

        let fileModified = false;
        for (const item of modelsNode.items) {
          if (!isMap(item)) { continue; }

          // Skip models that are still in a domain (handled in Pass 1)
          const modelName = item.get('name');
          if (typeof modelName === 'string' && expected.has(modelName)) {
            continue;
          }

          const configNode = item.get('config');
          if (!isMap(configNode)) { continue; }
          const tagsNode = configNode.get('tags');
          if (!isSeq(tagsNode)) { continue; }

          const emptyDomains = new Set<string>();
          if (this.removeStaleTagsFromNode(tagsNode, emptyDomains, result)) {
            fileModified = true;
            // Clean up empty tags/config
            if (tagsNode.items.length === 0) {
              (configNode as YAMLMap).delete('tags');
            }
            if (isMap(configNode) && (configNode as YAMLMap).items.length === 0) {
              (item as YAMLMap).delete('config');
            }
          }
        }

        if (fileModified) {
          try {
            this.writeYaml(yamlPath, doc);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            result.errors.push(`Failed to write ${yamlPath}: ${msg}`);
          }
        }
      }
    } finally {
      this.clearYamlCache();
    }

    return result;
  }

  /**
   * Remove `domain:*` tags from a tags sequence that are not in the allowed set.
   * Returns true if any tags were removed.
   */
  private removeStaleTagsFromNode(
    tags: YAMLSeq,
    allowedDomains: Set<string>,
    result: { removed: number },
  ): boolean {
    let modified = false;
    for (let i = tags.items.length - 1; i >= 0; i--) {
      const item = tags.items[i];
      if (item == null) { continue; }
      const value = typeof item === 'object' && 'value' in item ? item.value : item;
      if (typeof value === 'string' && value.startsWith(DOMAIN_TAG_PREFIX)) {
        const tagDomain = value.slice(DOMAIN_TAG_PREFIX.length);
        if (!allowedDomains.has(tagDomain)) {
          tags.delete(i);
          result.removed++;
          modified = true;
        }
      }
    }
    return modified;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a model name to its dbt schema YAML file path by searching
   * the workspace filesystem. Returns null if no matching file is found.
   */
  private resolveYamlPath(modelName: string): string | null {
    return this.getYamlIndex().get(modelName) ?? null;
  }

  /**
   * Return the YAML index, using the transient cache if available
   * (during `reconcileAll`), otherwise building a fresh index.
   */
  private getYamlIndex(): Map<string, string> {
    if (this._yamlCache) {
      return this._yamlCache;
    }
    return this.buildYamlIndex();
  }

  /**
   * Recursively walk the workspace collecting `.yml`/`.yaml` files into
   * a Map keyed by filename stem (e.g. `dim_project` → `/abs/path/dim_project.yml`).
   *
   * NOTE: dbt requires unique model names across the project, so stem
   * collisions between directories are not expected in valid projects.
   * If they do occur the last file encountered wins.
   */
  private buildYamlIndex(): Map<string, string> {
    const index = new Map<string, string>();
    this.walkDir(this.workspaceRoot, index);
    return index;
  }

  private walkDir(dir: string, index: Map<string, string>): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission error or deleted dir — skip
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          this.walkDir(path.join(dir, entry.name), index);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          const stem = path.basename(entry.name, path.extname(entry.name));
          index.set(stem, path.join(dir, entry.name));
        }
      }
    }
  }

  private clearYamlCache(): void {
    this._yamlCache = undefined;
  }

  private readYaml(yamlPath: string): Document | null {
    try {
      const raw = fs.readFileSync(yamlPath, 'utf-8');
      return parseDocument(raw);
    } catch (err) {
      console.warn(
        `[SchemaTagService] Failed to parse ${yamlPath}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return null;
    }
  }

  private writeYaml(yamlPath: string, doc: Document): void {
    fs.writeFileSync(yamlPath, doc.toString(), 'utf-8');
  }

  /**
   * Find the model entry in the YAML's `models:` sequence by name.
   * Returns the YAMLMap node for the matching model, or null.
   */
  private findModelNode(doc: Document, modelName: string): YAMLMap | null {
    const modelsNode = doc.get('models');
    if (!isSeq(modelsNode)) {
      return null;
    }

    for (const item of modelsNode.items) {
      if (isMap(item) && item.get('name') === modelName) {
        return item;
      }
    }

    return null;
  }

  /**
   * Get or create the `config.tags` YAML sequence on a model node.
   */
  private getOrCreateTagsSeq(doc: Document, modelNode: YAMLMap): YAMLSeq {
    let configNode = modelNode.get('config');
    if (!isMap(configNode)) {
      modelNode.set('config', doc.createNode({ tags: [] }));
      configNode = modelNode.get('config') as YAMLMap;
    }

    const configMap = configNode as YAMLMap;
    let tagsNode = configMap.get('tags');

    if (!isSeq(tagsNode)) {
      // Preserve an existing scalar tag value (e.g. `tags: my-tag`)
      const seed = typeof tagsNode === 'string' ? [tagsNode] : [];
      configMap.set('tags', doc.createNode(seed));
      tagsNode = configMap.get('tags') as YAMLSeq;
    }

    return tagsNode as YAMLSeq;
  }

  private seqContains(seq: YAMLSeq, value: string): boolean {
    return this.seqIndexOf(seq, value) !== -1;
  }

  private seqIndexOf(seq: YAMLSeq, value: string): number {
    for (let i = 0; i < seq.items.length; i++) {
      const item = seq.items[i];
      const resolved = typeof item === 'object' && item !== null && 'value' in item ? item.value : item;
      if (resolved === value) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Check if a model still belongs to another domain with the same name.
   * Used to prevent removing a tag when the model is shared across domains.
   */
  private isModelInOtherDomain(
    modelName: string,
    domainName: string,
    excludeFilePath: string,
  ): boolean {
    const allDomains = this.domainService.listDomains(this.workspaceRoot, this.semanticDir);

    for (const summary of allDomains) {
      if (summary.domain !== domainName) {
        continue;
      }
      if (summary.filePath === excludeFilePath) {
        continue;
      }

      try {
        const domain = this.domainService.getDomain(summary.filePath);
        const models = domain.logical?.models ?? [];
        if (models.some((m) => m.name === modelName)) {
          return true;
        }
      } catch {
        // Skip malformed domain files
      }
    }

    return false;
  }
}
