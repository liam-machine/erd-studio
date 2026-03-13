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
 * YAML path is derived from ManifestModelInfo.originalFilePath by swapping
 * `.sql` → `.yml` (assumes one YAML per SQL convention).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Document, parseDocument, isSeq, isMap, YAMLMap, YAMLSeq } from 'yaml';

import type { ManifestService } from './manifestService';
import type { DomainService } from './domainService';

const DOMAIN_TAG_PREFIX = 'domain:';

export class SchemaTagService {
  constructor(
    private readonly manifestService: ManifestService,
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

    // Sync YAML for all manifest models — both those in domains and those not
    const allModelNames = new Set([
      ...expected.keys(),
      ...this.manifestService.getModelNames(),
    ]);

    for (const modelName of allModelNames) {
      const yamlPath = this.resolveYamlPath(modelName);
      if (!yamlPath) {
        if (expected.has(modelName)) { result.skipped++; }
        continue;
      }

      const doc = this.readYaml(yamlPath);
      if (!doc) {
        if (expected.has(modelName)) { result.skipped++; }
        continue;
      }

      const modelNode = this.findModelNode(doc, modelName);
      if (!modelNode) {
        if (expected.has(modelName)) { result.skipped++; }
        continue;
      }

      const domainNames = expected.get(modelName) ?? new Set<string>();
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
      for (let i = tags.items.length - 1; i >= 0; i--) {
        const item = tags.items[i];
        if (item == null) { continue; }
        const value = typeof item === 'object' && 'value' in item ? item.value : item;
        if (typeof value === 'string' && value.startsWith(DOMAIN_TAG_PREFIX)) {
          const tagDomain = value.slice(DOMAIN_TAG_PREFIX.length);
          if (!domainNames.has(tagDomain)) {
            tags.delete(i);
            result.removed++;
            modified = true;
          }
        }
      }

      if (modified) {
        try {
          this.writeYaml(yamlPath, doc);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Failed to write ${yamlPath}: ${msg}`);
        }
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private resolveYamlPath(modelName: string): string | null {
    const model = this.manifestService.getModel(modelName);
    if (!model?.originalFilePath) {
      return null;
    }

    const base = model.originalFilePath.replace(/\.sql$/i, '');
    for (const ext of ['.yml', '.yaml']) {
      const candidate = path.join(this.workspaceRoot, `${base}${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
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
