/**
 * YmlParserService — parses dbt schema .yml files to extract model and test
 * metadata directly from source code.
 *
 * This replaces the manifest as the primary source of truth for what exists
 * in the dbt project. Unlike ManifestService (which requires `dbt compile`),
 * this service reads source files directly and is always current.
 *
 * Uses the `yaml` package (comment-preserving parser).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseDocument, isSeq, isMap } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';

import type {
  YmlColumn,
  YmlData,
  YmlModelInfo,
  YmlRelationshipTest,
} from '../types/ymlData';

/** Directories to skip during filesystem walk. */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'target', '.git', '.venv', 'venv',
  '__pycache__', 'dist', '.tox', '.mypy_cache',
]);

/**
 * Regex to extract a model name from a dbt ref() call.
 * Handles both single-arg `ref('model')` and two-arg `ref('project', 'model')`.
 */
const REF_SINGLE = /ref\(['"](\w+)['"]\s*\)/;
const REF_TWO_ARG = /ref\(['"][^'"]+['"],\s*['"](\w+)['"]\s*\)/;

export class YmlParserService {
  private cache: YmlData | null = null;
  private loadPromise: Promise<YmlData> | null = null;
  private loadId = 0;

  /**
   * Parse all dbt schema .yml files and cache the result.
   * Returns cached data on subsequent calls until invalidate() is called.
   *
   * @param projectPath — workspace root containing the dbt project
   * @param modelFolder — optional path prefix filter (e.g. "models/silver")
   */
  async loadYmlData(projectPath: string, modelFolder?: string): Promise<YmlData> {
    if (this.cache) {
      return modelFolder ? this.filterByFolder(this.cache, projectPath, modelFolder) : this.cache;
    }

    if (this.loadPromise) {
      const result = await this.loadPromise;
      return modelFolder ? this.filterByFolder(result, projectPath, modelFolder) : result;
    }

    const currentLoadId = ++this.loadId;
    this.loadPromise = this.parseAllYmlFiles(projectPath);
    try {
      const result = await this.loadPromise;
      if (currentLoadId === this.loadId) {
        this.cache = result;
      }
      return modelFolder ? this.filterByFolder(result, projectPath, modelFolder) : result;
    } finally {
      if (currentLoadId === this.loadId) {
        this.loadPromise = null;
      }
    }
  }

  /** Clear the cache so the next loadYmlData call re-parses from disk. */
  invalidate(): void {
    this.loadId++;
    this.cache = null;
    this.loadPromise = null;
  }

  /**
   * Get unique top-level model folders from discovered .yml files.
   * Extracts the first two path segments relative to projectPath
   * (e.g., "models/silver") from each model's filePath.
   */
  getModelFolders(projectPath: string): string[] {
    if (!this.cache) {
      return [];
    }

    const folders = new Set<string>();
    for (const model of this.cache.models.values()) {
      const relativePath = path.relative(projectPath, model.filePath);
      if (!relativePath.startsWith('models' + path.sep) && !relativePath.startsWith('models/')) {
        continue;
      }

      const parts = relativePath.split(/[/\\]/);
      if (parts.length >= 2) {
        folders.add(`${parts[0]}/${parts[1]}`);
      }
    }

    return Array.from(folders).sort();
  }

  // ---------------------------------------------------------------------------
  // Internal parsing
  // ---------------------------------------------------------------------------

  private async parseAllYmlFiles(projectPath: string): Promise<YmlData> {
    const models = new Map<string, YmlModelInfo>();
    const relationshipTests: YmlRelationshipTest[] = [];
    const uniqueColumns = new Map<string, Set<string>>();
    const compositeUniqueGroups = new Map<string, string[][]>();

    // Walk filesystem to find all .yml/.yaml files
    const ymlFiles = this.findYmlFiles(projectPath);

    for (const filePath of ymlFiles) {
      try {
        this.parseYmlFile(
          filePath,
          models,
          relationshipTests,
          uniqueColumns,
          compositeUniqueGroups,
        );
      } catch (err) {
        console.warn(
          `[YmlParserService] Failed to parse ${filePath}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return { models, relationshipTests, uniqueColumns, compositeUniqueGroups };
  }

  /**
   * Recursively walk the project directory collecting .yml/.yaml files.
   * Skips excluded directories and files outside the models/ tree.
   */
  private findYmlFiles(projectPath: string): string[] {
    const files: string[] = [];
    this.walkDir(projectPath, files);
    return files;
  }

  private walkDir(dir: string, files: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission error or deleted dir — skip
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          this.walkDir(path.join(dir, entry.name), files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  }

  /**
   * Parse a single .yml file, extracting all models and their test metadata
   * into the accumulator maps.
   */
  private parseYmlFile(
    filePath: string,
    models: Map<string, YmlModelInfo>,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    compositeUniqueGroups: Map<string, string[][]>,
  ): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const doc = parseDocument(raw);

    const modelsNode = doc.get('models');
    if (!isSeq(modelsNode)) {
      return; // Not a dbt model schema file — skip
    }

    for (const item of (modelsNode as YAMLSeq).items) {
      if (!isMap(item)) {
        continue;
      }
      this.extractModel(
        item as YAMLMap,
        filePath,
        models,
        relationshipTests,
        uniqueColumns,
        compositeUniqueGroups,
      );
    }
  }

  /**
   * Extract a single model entry from a parsed YAML model node.
   */
  private extractModel(
    modelNode: YAMLMap,
    filePath: string,
    models: Map<string, YmlModelInfo>,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    compositeUniqueGroups: Map<string, string[][]>,
  ): void {
    const name = modelNode.get('name');
    if (typeof name !== 'string' || !name) {
      return;
    }

    const description = this.getString(modelNode, 'description');
    const tags = this.extractTags(modelNode);
    const columns: YmlColumn[] = [];

    // Parse columns and their tests
    const columnsNode = modelNode.get('columns');
    if (isSeq(columnsNode)) {
      for (const colItem of (columnsNode as YAMLSeq).items) {
        if (!isMap(colItem)) {
          continue;
        }
        const col = colItem as YAMLMap;
        const colName = this.getString(col, 'name');
        if (!colName) {
          continue;
        }

        columns.push({
          name: colName,
          description: this.getString(col, 'description'),
          dataType: this.getStringOrNull(col, 'data_type'),
        });

        // Extract tests on this column
        this.extractColumnTests(
          name,
          colName,
          col,
          relationshipTests,
          uniqueColumns,
        );
      }
    }

    // Extract model-level tests (unique_combination_of_columns)
    this.extractModelLevelTests(name, modelNode, compositeUniqueGroups);

    models.set(name, {
      name,
      description,
      columns,
      filePath,
      tags,
    });
  }

  /**
   * Extract tests from a column's `tests:` sequence.
   * Handles both scalar tests (`- unique`) and object tests (`- relationships: {...}`).
   */
  private extractColumnTests(
    modelName: string,
    columnName: string,
    colNode: YAMLMap,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
  ): void {
    const testsNode = colNode.get('tests');
    if (!isSeq(testsNode)) {
      return;
    }

    for (const testItem of (testsNode as YAMLSeq).items) {
      // Scalar test: `- unique` or `- not_null`
      const scalarValue = this.resolveScalar(testItem);
      if (scalarValue === 'unique') {
        let cols = uniqueColumns.get(modelName);
        if (!cols) {
          cols = new Set<string>();
          uniqueColumns.set(modelName, cols);
        }
        cols.add(columnName);
        continue;
      }

      // Object test: `- relationships: { to: ..., field: ... }`
      if (!isMap(testItem)) {
        continue;
      }
      const testMap = testItem as YAMLMap;

      // Check for relationship tests (relationships, relationships_where)
      for (const key of ['relationships', 'relationships_where']) {
        const relNode = testMap.get(key);
        if (isMap(relNode)) {
          const relTest = this.extractRelationshipTest(
            modelName,
            columnName,
            relNode as YAMLMap,
          );
          if (relTest) {
            relationshipTests.push(relTest);
          }
        }
      }
    }
  }

  /**
   * Extract a relationship test from its kwargs map.
   *
   * Expected YAML structure:
   * ```yaml
   * - relationships:
   *     to: ref('dim_project')
   *     field: project_id
   * ```
   */
  private extractRelationshipTest(
    fromModel: string,
    fromColumn: string,
    relNode: YAMLMap,
  ): YmlRelationshipTest | null {
    const toRef = this.getString(relNode, 'to');
    const toColumn = this.getString(relNode, 'field');

    if (!toRef || !toColumn) {
      return null;
    }

    // Extract model name from ref('model') or ref('project', 'model')
    const twoArgMatch = toRef.match(REF_TWO_ARG);
    const singleMatch = toRef.match(REF_SINGLE);
    const toModel = twoArgMatch?.[1] ?? singleMatch?.[1];

    if (!toModel) {
      return null;
    }

    return { fromModel, fromColumn, toModel, toColumn };
  }

  /**
   * Extract model-level tests like `unique_combination_of_columns`.
   *
   * These appear at the model level (not column level):
   * ```yaml
   * models:
   *   - name: my_model
   *     tests:
   *       - dbt_utils.unique_combination_of_columns:
   *           combination_of_columns:
   *             - col_a
   *             - col_b
   * ```
   *
   * Also handles `data_tests:` key (dbt 1.8+).
   */
  private extractModelLevelTests(
    modelName: string,
    modelNode: YAMLMap,
    compositeUniqueGroups: Map<string, string[][]>,
  ): void {
    // dbt supports both `tests:` and `data_tests:` at model level
    for (const key of ['tests', 'data_tests']) {
      const testsNode = modelNode.get(key);
      if (!isSeq(testsNode)) {
        continue;
      }

      for (const testItem of (testsNode as YAMLSeq).items) {
        if (!isMap(testItem)) {
          continue;
        }
        const testMap = testItem as YAMLMap;

        // Check for unique_combination_of_columns (with or without dbt_utils prefix)
        for (const testKey of [
          'unique_combination_of_columns',
          'dbt_utils.unique_combination_of_columns',
        ]) {
          const ucoNode = testMap.get(testKey);
          if (!isMap(ucoNode)) {
            continue;
          }
          const combo = (ucoNode as YAMLMap).get('combination_of_columns');
          if (!isSeq(combo)) {
            continue;
          }

          const columns = (combo as YAMLSeq).items
            .map((item) => this.resolveScalar(item))
            .filter((s): s is string => typeof s === 'string' && s.length > 0);

          if (columns.length > 0) {
            let groups = compositeUniqueGroups.get(modelName);
            if (!groups) {
              groups = [];
              compositeUniqueGroups.set(modelName, groups);
            }
            groups.push(columns);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Folder filtering
  // ---------------------------------------------------------------------------

  /**
   * Filter YmlData to only include models whose file path starts with
   * the given folder prefix (e.g. "models/silver").
   */
  private filterByFolder(data: YmlData, projectPath: string, modelFolder: string): YmlData {
    const normalizedPrefix = modelFolder.replace(/\\/g, '/');

    const filteredModels = new Map<string, YmlModelInfo>();
    for (const [name, model] of data.models) {
      const relativePath = path.relative(projectPath, model.filePath).replace(/\\/g, '/');
      if (relativePath.startsWith(normalizedPrefix)) {
        filteredModels.set(name, model);
      }
    }

    const modelNames = new Set(filteredModels.keys());

    // Filter relationship tests to only those where both models are in scope
    const filteredRelTests = data.relationshipTests.filter(
      (t) => modelNames.has(t.fromModel) && modelNames.has(t.toModel),
    );

    // Filter uniqueness data to only scoped models
    const filteredUniqueColumns = new Map<string, Set<string>>();
    for (const [model, cols] of data.uniqueColumns) {
      if (modelNames.has(model)) {
        filteredUniqueColumns.set(model, cols);
      }
    }

    const filteredCompositeGroups = new Map<string, string[][]>();
    for (const [model, groups] of data.compositeUniqueGroups) {
      if (modelNames.has(model)) {
        filteredCompositeGroups.set(model, groups);
      }
    }

    return {
      models: filteredModels,
      relationshipTests: filteredRelTests,
      uniqueColumns: filteredUniqueColumns,
      compositeUniqueGroups: filteredCompositeGroups,
    };
  }

  // ---------------------------------------------------------------------------
  // YAML helpers
  // ---------------------------------------------------------------------------

  /** Extract tags from `config.tags` on a model node. */
  private extractTags(modelNode: YAMLMap): string[] {
    const configNode = modelNode.get('config');
    if (!isMap(configNode)) {
      return [];
    }
    const tagsNode = (configNode as YAMLMap).get('tags');
    if (!isSeq(tagsNode)) {
      return [];
    }
    return (tagsNode as YAMLSeq).items
      .map((item) => this.resolveScalar(item))
      .filter((s): s is string => typeof s === 'string');
  }

  /** Get a string value from a YAML map, defaulting to ''. */
  private getString(node: YAMLMap, key: string): string {
    const val = node.get(key);
    return typeof val === 'string' ? val : '';
  }

  /** Get a string value from a YAML map, or null if missing/non-string. */
  private getStringOrNull(node: YAMLMap, key: string): string | null {
    const val = node.get(key);
    return typeof val === 'string' ? val : null;
  }

  /**
   * Resolve a YAML scalar value to a string.
   * Handles both plain scalars and wrapped Scalar nodes.
   */
  private resolveScalar(item: unknown): string | undefined {
    if (typeof item === 'string') {
      return item;
    }
    if (item && typeof item === 'object' && 'value' in item) {
      const val = (item as { value: unknown }).value;
      if (typeof val === 'string') {
        return val;
      }
    }
    return undefined;
  }
}
