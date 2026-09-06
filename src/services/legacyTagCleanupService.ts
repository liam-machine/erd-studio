/**
 * LegacyTagCleanupService — one-shot walker that strips `domain:*` tags from
 * every dbt model YAML under the project's `model-paths`.
 *
 * Background: ERD Studio previously wrote `tags: [domain:foo]` into each
 * member model's schema.yml. That mechanism has been replaced by a single
 * root-level `selectors.yml`. The old tags are now inert (nothing reads them
 * from ERD Studio), but they still pollute PR diffs and cause a CI cascade
 * any time dbt state comparison runs against an older manifest.
 *
 * This service is the cleanup pass users run once, review, and commit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Document, parseDocument, isSeq, isMap, isScalar, YAMLMap, YAMLSeq } from 'yaml';

const DOMAIN_TAG_PREFIX = 'domain:';

/** dbt's default when `model-paths` is not set in dbt_project.yml. */
const DEFAULT_MODEL_PATHS = ['models'];

/**
 * Stringify options for rewritten files. `lineWidth: 0` disables folding so
 * long descriptions are not re-wrapped at 80 columns — the diff should show
 * only the tags that were removed (matches SelectorsService).
 */
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

const EXCLUDED_DIRS = new Set([
  'node_modules', 'target', '.git',
  '.venv', 'venv', 'env', '.direnv', 'site-packages',
  '__pycache__', 'dist', '.tox', '.mypy_cache',
  'dbt_packages', 'dbt_modules',
]);

export interface StripResult {
  filesScanned: number;
  filesModified: number;
  tagsRemoved: number;
  modifiedPaths: string[];
  errors: string[];
}

export class LegacyTagCleanupService {
  constructor(private readonly workspaceRoot: string) {}

  stripAll(): StripResult {
    const result: StripResult = {
      filesScanned: 0,
      filesModified: 0,
      tagsRemoved: 0,
      modifiedPaths: [],
      errors: [],
    };

    const yamlFiles: string[] = [];
    for (const modelPath of this.resolveModelPaths()) {
      this.walk(modelPath, yamlFiles);
    }

    for (const filePath of yamlFiles) {
      result.filesScanned++;

      let raw: string;
      try {
        raw = fs.readFileSync(filePath, 'utf-8');
      } catch (err) {
        result.errors.push(`Read failed: ${filePath}: ${this.msg(err)}`);
        continue;
      }

      let doc: Document;
      try {
        doc = parseDocument(raw);
      } catch (err) {
        // Skip non-YAML or malformed files silently
        result.errors.push(`Parse failed: ${filePath}: ${this.msg(err)}`);
        continue;
      }
      // parseDocument reports syntax errors on the document rather than
      // throwing; never re-serialise a partial AST over a malformed file.
      if (doc.errors.length > 0) {
        result.errors.push(`Parse failed: ${filePath}: ${doc.errors[0].message}`);
        continue;
      }

      const modelsNode = doc.get('models');
      if (!isSeq(modelsNode)) { continue; }

      let fileTagsRemoved = 0;

      for (const item of modelsNode.items) {
        if (!isMap(item)) { continue; }
        fileTagsRemoved += this.stripFromModelNode(item as YAMLMap);
      }

      if (fileTagsRemoved > 0) {
        try {
          fs.writeFileSync(filePath, doc.toString(STRINGIFY_OPTIONS), 'utf-8');
          result.filesModified++;
          result.tagsRemoved += fileTagsRemoved;
          result.modifiedPaths.push(filePath);
        } catch (err) {
          result.errors.push(`Write failed: ${filePath}: ${this.msg(err)}`);
        }
      }
    }

    return result;
  }

  /**
   * Strip domain:* tags from both `config.tags` and a model-level `tags`
   * sequence (dbt supports tags in either place). Removes emptied `tags`
   * arrays and `config` maps.
   */
  private stripFromModelNode(modelNode: YAMLMap): number {
    let removed = 0;

    // config.tags
    const configNode = modelNode.get('config');
    if (isMap(configNode)) {
      const tagsNode = (configNode as YAMLMap).get('tags');
      if (isSeq(tagsNode)) {
        removed += this.stripFromSeq(tagsNode as YAMLSeq);
        if ((tagsNode as YAMLSeq).items.length === 0) {
          (configNode as YAMLMap).delete('tags');
        }
      }
      if ((configNode as YAMLMap).items.length === 0) {
        modelNode.delete('config');
      }
    }

    // Top-level tags on the model
    const topTagsNode = modelNode.get('tags');
    if (isSeq(topTagsNode)) {
      removed += this.stripFromSeq(topTagsNode as YAMLSeq);
      if ((topTagsNode as YAMLSeq).items.length === 0) {
        modelNode.delete('tags');
      }
    }

    return removed;
  }

  private stripFromSeq(seq: YAMLSeq): number {
    let removed = 0;
    for (let i = seq.items.length - 1; i >= 0; i--) {
      const item = seq.items[i];
      const value = typeof item === 'object' && item !== null && 'value' in item
        ? (item as { value: unknown }).value
        : item;
      if (typeof value === 'string' && value.startsWith(DOMAIN_TAG_PREFIX)) {
        seq.delete(i);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Resolve the absolute directories to scan from `model-paths` in
   * dbt_project.yml (falling back to the pre-1.0 `source-paths` key, then
   * dbt's default `models/`). Only the model tree is touched so YAML
   * elsewhere in the workspace (seeds, CI configs, packages) is never rewritten.
   */
  private resolveModelPaths(): string[] {
    let configured: string[] | null = null;
    try {
      const raw = fs.readFileSync(path.join(this.workspaceRoot, 'dbt_project.yml'), 'utf-8');
      const doc = parseDocument(raw);
      if (doc.errors.length === 0) {
        configured = this.readPathList(doc.get('model-paths', true))
          ?? this.readPathList(doc.get('source-paths', true));
      }
    } catch {
      // Missing or unreadable dbt_project.yml — use dbt's default.
    }
    const relPaths = configured && configured.length > 0 ? configured : DEFAULT_MODEL_PATHS;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const rel of relPaths) {
      const abs = path.resolve(this.workspaceRoot, rel);
      if (seen.has(abs)) { continue; }
      seen.add(abs);
      out.push(abs);
    }
    return out;
  }

  /** Read a YAML sequence of strings (or a single string) into a string array. */
  private readPathList(node: unknown): string[] | null {
    if (isScalar(node)) {
      return typeof node.value === 'string' && node.value.trim() !== '' ? [node.value] : null;
    }
    if (!isSeq(node)) { return null; }
    const paths: string[] = [];
    for (const item of node.items) {
      if (isScalar(item) && typeof item.value === 'string' && item.value.trim() !== '') {
        paths.push(item.value);
      }
    }
    return paths.length > 0 ? paths : null;
  }

  private walk(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          this.walk(path.join(dir, entry.name), out);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          out.push(path.join(dir, entry.name));
        }
      }
    }
  }

  private msg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
