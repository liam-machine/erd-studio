/**
 * SchemaTagService — manages domain tags in dbt schema.yml files.
 *
 * Adds/removes tags in format `domain:{domain_name}` to model configurations.
 * Assumes one schema.yml per model in the same directory as the .sql file.
 *
 * When a repo model is added to a semantic domain:
 *   - Add `domain:{domain_name}` tag to model's schema.yml
 *
 * When a repo model is removed from a semantic domain:
 *   - Remove that specific domain tag from schema.yml
 *
 * This enables: `dbt build --select tag:domain:work-lots`
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';

import type { DomainService } from './domainService';
import type { ManifestService } from './manifestService';

/**
 * Structure of a dbt schema.yml file.
 * We only care about the models array and config.tags within each model.
 */
interface SchemaYaml {
  version?: number;
  models?: Array<{
    name: string;
    description?: string;
    config?: {
      tags?: string[];
      [key: string]: unknown;
    };
    columns?: unknown[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export class SchemaTagService {
  constructor(private readonly manifestService: ManifestService) {}

  /**
   * Add a domain tag to a model's schema.yml file.
   *
   * @param modelName - Short model name (e.g., "dim_work_lot")
   * @param domainName - Domain slug (e.g., "work-lots")
   * @param workspaceRoot - dbt project root path
   * @returns WorkspaceEdit to apply, or null if model not found in manifest or tag already exists
   */
  async addDomainTag(
    modelName: string,
    domainName: string,
    workspaceRoot: string,
  ): Promise<vscode.WorkspaceEdit | null> {
    const schemaPath = this.deriveSchemaPath(modelName, workspaceRoot);
    if (!schemaPath) {
      console.warn(
        `[SchemaTagService] Cannot tag ${modelName}: No originalFilePath in manifest`,
      );
      return null;
    }

    const tag = this.formatDomainTag(domainName);

    try {
      const { content, parsed } = await this.loadOrCreateSchema(schemaPath, modelName);

      // Find or create model entry
      let modelEntry = parsed.models?.find((m) => m.name === modelName);
      if (!modelEntry) {
        // Add model entry if it doesn't exist
        if (!parsed.models) {
          parsed.models = [];
        }
        modelEntry = { name: modelName };
        parsed.models.push(modelEntry);
      }

      // Ensure config.tags exists
      if (!modelEntry.config) {
        modelEntry.config = {};
      }
      if (!modelEntry.config.tags) {
        modelEntry.config.tags = [];
      }

      // Check if tag already exists
      if (modelEntry.config.tags.includes(tag)) {
        console.log(
          `[SchemaTagService] Tag "${tag}" already exists for ${modelName}`,
        );
        return null;
      }

      // Add the tag
      modelEntry.config.tags.push(tag);

      return this.createEdit(schemaPath, content, parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[SchemaTagService] Failed to add tag for ${modelName}: ${message}`,
      );
      void vscode.window.showErrorMessage(
        `Failed to add domain tag for ${modelName}: ${message}`,
      );
      return null;
    }
  }

  /**
   * Remove a domain tag from a model's schema.yml file.
   *
   * @param modelName - Short model name
   * @param domainName - Domain slug
   * @param workspaceRoot - dbt project root path
   * @returns WorkspaceEdit to apply, or null if no changes needed
   */
  async removeDomainTag(
    modelName: string,
    domainName: string,
    workspaceRoot: string,
  ): Promise<vscode.WorkspaceEdit | null> {
    const schemaPath = this.deriveSchemaPath(modelName, workspaceRoot);
    if (!schemaPath) {
      console.warn(
        `[SchemaTagService] Cannot remove tag from ${modelName}: No originalFilePath in manifest`,
      );
      return null;
    }

    if (!fs.existsSync(schemaPath)) {
      console.log(
        `[SchemaTagService] Schema file not found for ${modelName}, nothing to remove`,
      );
      return null;
    }

    const tag = this.formatDomainTag(domainName);

    try {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const parsed = yaml.load(content) as SchemaYaml;

      if (!parsed || typeof parsed !== 'object') {
        console.warn(`[SchemaTagService] Invalid YAML in ${schemaPath}`);
        return null;
      }

      // Find model entry
      const modelEntry = parsed.models?.find((m) => m.name === modelName);
      if (!modelEntry?.config?.tags) {
        console.log(
          `[SchemaTagService] No tags found for ${modelName}, nothing to remove`,
        );
        return null;
      }

      // Check if tag exists
      const tagIndex = modelEntry.config.tags.indexOf(tag);
      if (tagIndex === -1) {
        console.log(
          `[SchemaTagService] Tag "${tag}" not found for ${modelName}`,
        );
        return null;
      }

      // Remove the tag
      modelEntry.config.tags.splice(tagIndex, 1);

      // Clean up empty tags array
      if (modelEntry.config.tags.length === 0) {
        delete modelEntry.config.tags;
      }

      // Clean up empty config object
      if (Object.keys(modelEntry.config).length === 0) {
        delete modelEntry.config;
      }

      return this.createEdit(schemaPath, content, parsed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[SchemaTagService] Failed to remove tag from ${modelName}: ${message}`,
      );
      void vscode.window.showErrorMessage(
        `Failed to remove domain tag from ${modelName}: ${message}`,
      );
      return null;
    }
  }

  /**
   * Get all domain tags for a model (for verification/testing).
   *
   * @param modelName - Short model name
   * @param workspaceRoot - dbt project root path
   * @returns Array of domain tags (e.g., ["domain:work-lots", "domain:projects"])
   */
  async getDomainTags(
    modelName: string,
    workspaceRoot: string,
  ): Promise<string[]> {
    const schemaPath = this.deriveSchemaPath(modelName, workspaceRoot);
    if (!schemaPath || !fs.existsSync(schemaPath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const parsed = yaml.load(content) as SchemaYaml;

      if (!parsed || typeof parsed !== 'object') {
        return [];
      }

      const modelEntry = parsed.models?.find((m) => m.name === modelName);
      if (!modelEntry?.config?.tags) {
        return [];
      }

      // Filter to only domain tags
      return modelEntry.config.tags.filter((t) => t.startsWith('domain:'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[SchemaTagService] Failed to get domain tags for ${modelName}: ${message}`,
      );
      return [];
    }
  }

  /**
   * Sync domain tags for all built models across all semantic domain files.
   *
   * Iterates every domain JSON, finds built models, and ensures each has
   * a `domain:{domain_name}` tag in its schema.yml. Skips models that
   * already have the correct tag (idempotent).
   *
   * @param domainService - DomainService to discover all domains
   * @param workspaceRoot - dbt project root path
   * @param semanticDir - Semantic directory relative path (e.g., "erd-studio")
   * @returns Number of tags added
   */
  async syncAllDomainTags(
    domainService: DomainService,
    workspaceRoot: string,
    semanticDir: string,
  ): Promise<number> {
    const domains = domainService.listDomains(workspaceRoot, semanticDir);
    let tagsAdded = 0;

    for (const summary of domains) {
      let domain;
      try {
        domain = domainService.getDomain(summary.filePath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[SchemaTagService] Skipping ${summary.filePath}: ${message}`);
        continue;
      }

      const domainName = domain.domain;
      if (!domainName) {
        continue;
      }

      for (const model of domain.models) {
        if (model.source !== 'built') {
          continue;
        }

        const tagEdit = await this.addDomainTag(model.name, domainName, workspaceRoot);
        if (tagEdit) {
          const success = await vscode.workspace.applyEdit(tagEdit);
          if (success) {
            tagsAdded++;
          }
        }
      }
    }

    if (tagsAdded > 0) {
      await vscode.workspace.saveAll(false);
    }

    return tagsAdded;
  }

  /**
   * Format a domain name as a tag.
   */
  private formatDomainTag(domainName: string): string {
    return `domain:${domainName}`;
  }

  /**
   * Derive the schema.yml path for a model from its originalFilePath in the manifest.
   * Converts "models/silver/dim_work_lot.sql" → "{workspaceRoot}/models/silver/dim_work_lot.yml"
   */
  private deriveSchemaPath(
    modelName: string,
    workspaceRoot: string,
  ): string | null {
    const model = this.manifestService.getModel(modelName);
    if (!model?.originalFilePath) {
      return null;
    }

    // Replace .sql extension with .yml
    const yamlPath = model.originalFilePath.replace(/\.sql$/, '.yml');
    return path.join(workspaceRoot, yamlPath);
  }

  /**
   * Load an existing schema.yml or create a minimal structure.
   */
  private async loadOrCreateSchema(
    schemaPath: string,
    modelName: string,
  ): Promise<{ content: string; parsed: SchemaYaml }> {
    if (fs.existsSync(schemaPath)) {
      const content = fs.readFileSync(schemaPath, 'utf-8');
      const parsed = yaml.load(content) as SchemaYaml;

      if (!parsed || typeof parsed !== 'object') {
        throw new Error(`Invalid YAML structure in ${schemaPath}`);
      }

      return { content, parsed };
    }

    // Create minimal schema structure
    const parsed: SchemaYaml = {
      version: 2,
      models: [
        {
          name: modelName,
          config: {
            tags: [],
          },
        },
      ],
    };

    return { content: '', parsed };
  }

  /**
   * Create a WorkspaceEdit for the schema file change.
   * For new files, writes directly to disk (more reliable than WorkspaceEdit.createFile).
   * Returns null if the file was written directly (no WorkspaceEdit needed).
   */
  private createEdit(
    schemaPath: string,
    originalContent: string,
    updatedParsed: SchemaYaml,
  ): vscode.WorkspaceEdit | null {
    const uri = vscode.Uri.file(schemaPath);

    // Dump YAML with consistent formatting
    const newContent = yaml.dump(updatedParsed, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
      quotingType: '"',
      forceQuotes: false,
    });

    if (originalContent === '') {
      // Creating new file - write directly to disk (more reliable)
      fs.writeFileSync(schemaPath, newContent, 'utf-8');
      console.log(`[SchemaTagService] Created new schema file: ${schemaPath}`);
      return null; // No WorkspaceEdit needed, file already saved
    }

    // Updating existing file - use WorkspaceEdit for undo/redo support
    const edit = new vscode.WorkspaceEdit();
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.fsPath === schemaPath,
    );

    if (doc) {
      // Document is open - use document range
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(originalContent.length),
      );
      edit.replace(uri, fullRange, newContent);
    } else {
      // Document not open - calculate range from content
      const lines = originalContent.split('\n');
      const lastLine = lines.length - 1;
      const lastChar = lines[lastLine]?.length ?? 0;
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        new vscode.Position(lastLine, lastChar),
      );
      edit.replace(uri, fullRange, newContent);
    }

    return edit;
  }
}
