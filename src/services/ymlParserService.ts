/**
 * YmlParserService — parses dbt schema .yml files to extract model and test
 * metadata directly from source code, and indexes the model / seed / snapshot
 * SOURCE files (`.sql`, `.py`, `.csv`) that sit alongside them.
 *
 * This replaces the manifest as the primary source of truth for what exists
 * in the dbt project. Unlike ManifestService (which requires `dbt compile`),
 * this service reads source files directly and is always current.
 *
 * The source-file index costs no extra IO: the directory walk that finds the
 * schema .yml files already enumerates every entry and used to throw the rest
 * away.
 *
 * Uses the `yaml` package (comment-preserving parser).
 */

import * as fs from 'fs';
import * as path from 'path';
import { LineCounter, parseDocument, isAlias, isScalar, isSeq, isMap, isNode, visit, YAMLMap } from 'yaml';
import type { Alias, Document, Pair, YAMLSeq } from 'yaml';

import type {
  YmlColumn,
  YmlData,
  YmlModelInfo,
  YmlRelationshipTest,
  RelationshipTestCondition,
  YmlResourceDoc,
  YmlSourceRelationshipTest,
  YmlSourceTable,
} from '../types/ymlData';
import type { CompositeForeignKey } from '../types/manifest';
import { readMeta, type Meta } from '@erd-studio/core';
import { normaliseName, parseRefModelName, parseSourceCall, unquoteIdentifier } from './nameUtils';
import { defaultDbtProjectConfig, type DbtProjectConfig } from './dbtProjectConfig';
import { log } from './logger';

/**
 * Directories to skip during filesystem walk. Mirrors LegacyTagCleanupService.
 * `dbt_packages` / `dbt_modules` matter most: installed packages
 * (dbt_utils, elementary, dbt_project_evaluator, ...) ship their own model
 * schema files which would otherwise pollute the model picker and shadow
 * project models of the same name.
 */
const EXCLUDED_DIRS = new Set([
  'node_modules', 'target', '.git',
  '.venv', 'venv', 'env', '.direnv', 'site-packages',
  '__pycache__', 'dist', '.tox', '.mypy_cache',
  'dbt_packages', 'dbt_modules', 'logs',
]);

/**
 * File extensions dbt builds a node from: SQL and Python models, snapshots
 * (`.sql`) and seeds (`.csv`). Their stems are what `YmlData.sourceFiles`
 * indexes.
 */
const SOURCE_FILE_EXTENSIONS = new Set(['.sql', '.py', '.csv']);

export interface YmlParserServiceOptions {
  /**
   * dbt project paths. `modelPaths` is walked for schema .yml files *and*
   * source files; `seedPaths` / `snapshotPaths` are walked for source files
   * only (they hold no schema this service parses). All default to dbt's own
   * defaults, and the seed / snapshot keys are optional so callers holding
   * only `modelPaths` keep compiling.
   */
  dbtConfig?: Pick<DbtProjectConfig, 'modelPaths'> &
    Partial<Pick<DbtProjectConfig, 'seedPaths' | 'snapshotPaths'>>;
  /**
   * False when the open root has no `dbt_project.yml` (logical-only mode):
   * every load answers empty data and never walks `models/` — a plain folder
   * may hold a `models/` directory that has nothing to do with dbt.
   * Defaults to true.
   */
  enabled?: boolean;
}

/**
 * Keys under which dbt accepts test declarations.
 * `tests:` is the classic key; `data_tests:` is recommended since dbt 1.8.
 */
const TEST_LIST_KEYS = ['tests', 'data_tests'] as const;

/** Test names that declare a foreign-key style relationship. */
const RELATIONSHIP_TEST_KEYS = [
  'relationships',
  'relationships_where',
  'dbt_utils.relationships_where',
] as const;

/**
 * Column tests that require a value in every row they test, as `not_null`
 * does: dbt's own, and dbt_expectations' (unless a `row_condition` limits it).
 * Not `dbt_utils.not_null_proportion`, which allows some nulls.
 */
const NOT_NULL_TEST_KEYS = ['not_null', 'dbt_expectations.expect_column_values_to_not_be_null'] as const;

/** Contract constraints that make a column required: `not_null`, and `primary_key` (a key is never null). */
const REQUIRING_CONSTRAINTS = new Set(['not_null', 'primary_key']);

/** What a disabled service answers: no models, tests, source files or docs. */
function emptyYmlData(): YmlData {
  return {
    models: new Map(),
    relationshipTests: [],
    uniqueColumns: new Map(),
    compositeUniqueGroups: new Map(),
    sourceFiles: new Map(),
    resourceDocs: new Map(),
    compositeForeignKeys: [],
    notNullColumns: new Map(),
    sourceRelationshipTests: [],
    sources: [],
  };
}

/** A map pair that is a YAML 1.1 merge key (`<<: *defaults`); the `yaml` package keys it `<<` or a `<<` symbol. */
function isMergePair(pair: Pair): boolean {
  if (!isScalar(pair.key)) return pair.key === '<<';
  const key = pair.key.value;
  return key === '<<' || (typeof key === 'symbol' && key.description === '<<');
}

/** How deep `<<:` merges are followed (a merge of a merge of …): far beyond any real file, and no further. */
const MAX_MERGE_DEPTH = 8;

/** `enabled: false` (a boolean, or the string `false`). */
function isFalse(value: unknown): boolean {
  return value === false || (typeof value === 'string' && value.trim().toLowerCase() === 'false');
}

export class YmlParserService {
  private cache: YmlData | null = null;
  private loadPromise: Promise<YmlData> | null = null;
  private loadId = 0;

  /** Model directories (relative to the project root) to scan for schema files. */
  private readonly modelPaths: string[];

  /** Seed directories — walked for source files only, never for schema files. */
  private readonly seedPaths: string[];

  /** Snapshot directories — walked for source files only, never for schema files. */
  private readonly snapshotPaths: string[];

  private readonly enabled: boolean;

  constructor(options: YmlParserServiceOptions = {}) {
    const defaults = defaultDbtProjectConfig();
    const configured = options.dbtConfig?.modelPaths ?? [];
    this.modelPaths = configured.length > 0 ? [...configured] : defaults.modelPaths;

    const seeds = options.dbtConfig?.seedPaths ?? [];
    this.seedPaths = seeds.length > 0 ? [...seeds] : defaults.seedPaths;

    const snapshots = options.dbtConfig?.snapshotPaths ?? [];
    this.snapshotPaths = snapshots.length > 0 ? [...snapshots] : defaults.snapshotPaths;

    this.enabled = options.enabled !== false;
  }

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

    // Logical-only (no dbt_project.yml): never walk the folder.
    if (!this.enabled) {
      this.cache = emptyYmlData();
      return this.cache;
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
      const relativePath = path.relative(projectPath, model.filePath).replace(/\\/g, '/');
      const modelPath = this.modelPaths.find((mp) => relativePath.startsWith(mp + '/'));
      if (!modelPath) {
        continue;
      }

      const rest = relativePath.slice(modelPath.length + 1).split('/');
      if (rest.length >= 2) {
        folders.add(`${modelPath}/${rest[0]}`);
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
    const compositeForeignKeys: CompositeForeignKey[] = [];
    const notNullColumns = new Map<string, Set<string>>();
    const sourceRelationshipTests: YmlSourceRelationshipTest[] = [];
    const sources: YmlSourceTable[] = [];

    // One walk finds both the schema .yml files and the source files that
    // define models, seeds and snapshots.
    const { ymlFiles, resourceYmlFiles, sourceFilePaths } = this.findProjectFiles(projectPath);

    for (const filePath of ymlFiles) {
      try {
        this.currentFile = path.relative(projectPath, filePath).replace(/\\/g, '/');
        this.parseYmlFile(
          filePath,
          models,
          relationshipTests,
          uniqueColumns,
          compositeUniqueGroups,
          compositeForeignKeys,
          notNullColumns,
          sourceRelationshipTests,
          sources,
        );
      } catch (err) {
        log.warn(
          `[YmlParserService] Failed to parse ${filePath}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    // `seeds:` / `snapshots:` blocks may sit in a property file under any of
    // the three roots; they only ever feed descriptions (see YmlResourceDoc).
    const resourceDocs = new Map<string, YmlResourceDoc>();
    for (const filePath of [...ymlFiles, ...resourceYmlFiles]) {
      try {
        this.parseResourceDocs(filePath, resourceDocs);
      } catch (err) {
        log.warn(
          `[YmlParserService] Failed to parse ${filePath}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    const sourceFiles = new Map<string, string>();
    for (const filePath of sourceFilePaths) {
      const stem = normaliseName(path.basename(filePath, path.extname(filePath)));
      if (!stem || sourceFiles.has(stem)) {
        // First entry wins on a duplicate stem (e.g. a `.sql` and a `.py` of
        // the same name), matching indexByNormalisedName's convention.
        continue;
      }
      sourceFiles.set(stem, path.relative(projectPath, filePath).replace(/\\/g, '/'));
    }

    return { models, relationshipTests, uniqueColumns, compositeUniqueGroups, sourceFiles, resourceDocs, compositeForeignKeys, notNullColumns, sourceRelationshipTests, sources };
  }

  /**
   * Collect `seeds:` / `snapshots:` entries from one property file into
   * `resourceDocs` — name, description and column descriptions only. Tests
   * declared on them are ignored on purpose: seeds and snapshots take no part
   * in relationship or cardinality derivation.
   */
  private parseResourceDocs(filePath: string, resourceDocs: Map<string, YmlResourceDoc>): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!/^(seeds|snapshots)\s*:/m.test(raw)) {
      return; // cheap pre-check: most model schema files have neither key
    }
    // Read as a models file is: YAML 1.1 merges (`<<: *defaults`) and aliases (`columns: *cols`,
    // `description: *anchor`) resolved in this file, never in the last one read.
    const doc = parseDocument(raw, { merge: true });
    const before = { aliasDoc: this.aliasDoc, merged: this.merged };
    this.aliasDoc = doc;
    this.merged = new WeakMap();
    try {
      this.readResourceDocs(doc, filePath, resourceDocs);
    } finally {
      this.aliasDoc = before.aliasDoc;
      this.merged = before.merged;
    }
  }

  private readResourceDocs(doc: Document, filePath: string, resourceDocs: Map<string, YmlResourceDoc>): void {
    for (const [key, resourceType] of [['seeds', 'seed'], ['snapshots', 'snapshot']] as const) {
      const seq = this.deref(doc.get(key));
      if (!isSeq(seq)) {
        continue;
      }
      for (const rawItem of (seq as YAMLSeq).items) {
        const item = this.deref(rawItem);
        if (!isMap(item)) {
          continue;
        }
        const node = item as YAMLMap;
        const name = this.getString(node, 'name');
        if (!name || resourceDocs.has(normaliseName(name))) {
          continue; // first declaration wins, as for source files
        }
        const columns: YmlColumn[] = [];
        const columnsNode = this.deref(node.get('columns'));
        if (isSeq(columnsNode)) {
          for (const rawCol of (columnsNode as YAMLSeq).items) {
            const colItem = this.deref(rawCol);
            if (!isMap(colItem)) {
              continue;
            }
            const colName = this.getString(colItem as YAMLMap, 'name');
            if (colName) {
              columns.push({
                name: colName,
                description: this.getString(colItem as YAMLMap, 'description'),
                dataType: this.getStringOrNull(colItem as YAMLMap, 'data_type'),
              });
            }
          }
        }
        resourceDocs.set(normaliseName(name), {
          name,
          resourceType,
          description: this.getString(node, 'description'),
          columns,
          filePath,
        });
      }
    }
  }

  /**
   * Recursively walk the configured dbt directories once, collecting both the
   * schema .yml files and the source files that define nodes.
   *
   * `model-paths` (default `models/`) yields schema .yml files for `models:`
   * parsing. A .yml under `seed-paths` / `snapshot-paths` lands in
   * `resourceYmlFiles` instead, which is read ONLY for `seeds:` / `snapshots:`
   * documentation — it must NOT enter `YmlData.models`, because that map feeds
   * the Add Existing Model picker and relationship derivation.
   *
   * Skips excluded directories (packages, venvs, build output): a model
   * vendored under `dbt_packages` or a venv is not part of this project and
   * must not count as existing.
   */
  private findProjectFiles(projectPath: string): {
    ymlFiles: string[];
    resourceYmlFiles: string[];
    sourceFilePaths: string[];
  } {
    const ymlFiles: string[] = [];
    const resourceYmlFiles: string[] = [];
    const sourceFilePaths: string[] = [];
    // Roots can be duplicated or nested (e.g. `seed-paths: ["models/seeds"]`);
    // walking a resolved root twice would only cost IO, so guard on it.
    const walked = new Set<string>();

    const walkRoots = (roots: string[], ymlTarget: string[]): void => {
      for (const root of roots) {
        const dir = path.resolve(projectPath, root);
        if (walked.has(dir)) {
          continue;
        }
        walked.add(dir);
        this.walkDir(dir, ymlTarget, sourceFilePaths);
      }
    };

    walkRoots(this.modelPaths, ymlFiles);
    walkRoots(this.seedPaths, resourceYmlFiles);
    walkRoots(this.snapshotPaths, resourceYmlFiles);

    return { ymlFiles, resourceYmlFiles, sourceFilePaths };
  }

  /**
   * Walk one directory tree, pushing .yml/.yaml files into `ymlFiles` (the
   * caller's list for this root) and source files into `sourceFiles`.
   *
   * Never reads a file body — the walk is pure `readdirSync`, which already
   * enumerates every entry, so indexing the source files is free.
   */
  private walkDir(dir: string, ymlFiles: string[], sourceFiles: string[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission error or deleted dir — skip
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          this.walkDir(path.join(dir, entry.name), ymlFiles, sourceFiles);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === '.yml' || ext === '.yaml') {
          ymlFiles.push(path.join(dir, entry.name));
        } else if (SOURCE_FILE_EXTENSIONS.has(ext)) {
          sourceFiles.push(path.join(dir, entry.name));
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
    compositeForeignKeys: CompositeForeignKey[] = [],
    notNullColumns: Map<string, Set<string>> = new Map(),
    sourceRelationshipTests: YmlSourceRelationshipTest[] = [],
    sources: YmlSourceTable[] = [],
  ): void {
    const raw = fs.readFileSync(filePath, 'utf-8');
    // `merge`: dbt reads YAML 1.1, where `<<: *anchor` merges a map. Conversions
    // through the document (meta) see it; `get()` lookups do not, so every map a
    // test is read from goes through {@link deref}, which applies the merges.
    this.lineCounter = new LineCounter();
    const doc = parseDocument(raw, { merge: true, lineCounter: this.lineCounter });
    // `tests: *key_tests`, `- relationships: *to_dim`: dbt reads an alias as the node it
    // names. Resolved where a test is read ({@link deref}), never expanded in place, so an
    // alias bomb costs only what is read.
    this.aliasDoc = doc;
    this.merged = new WeakMap();
    this.merging.clear();

    this.extractSources(this.deref(doc.get('sources')), sources);

    const modelsNode = this.deref(doc.get('models'));
    if (!isSeq(modelsNode)) {
      return; // Not a dbt model schema file — skip
    }

    for (const rawItem of (modelsNode as YAMLSeq).items) {
      const item = this.deref(rawItem);
      if (!isMap(item)) {
        continue;
      }
      this.extractModel(
        doc,
        item as YAMLMap,
        filePath,
        models,
        relationshipTests,
        uniqueColumns,
        compositeUniqueGroups,
        compositeForeignKeys,
        notNullColumns,
        sourceRelationshipTests,
      );
    }
  }

  /**
   * Extract a single model entry from a parsed YAML model node.
   */
  private extractModel(
    doc: Document,
    modelNode: YAMLMap,
    filePath: string,
    models: Map<string, YmlModelInfo>,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    compositeUniqueGroups: Map<string, string[][]>,
    compositeForeignKeys: CompositeForeignKey[],
    notNullColumns: Map<string, Set<string>> = new Map(),
    sourceRelationshipTests: YmlSourceRelationshipTest[] = [],
  ): void {
    const name = modelNode.get('name');
    if (typeof name !== 'string' || !name) {
      return;
    }

    const description = this.getString(modelNode, 'description');
    const tags = this.extractTags(modelNode);
    const columns: YmlColumn[] = [];

    // Parse columns and their tests: the model's own, or (a versioned model) its latest version's.
    const { columns: columnNodes, version } = this.modelColumnNodes(modelNode);
    {
      for (const col of columnNodes) {
        const colName = this.getString(col, 'name');
        if (!colName) {
          continue;
        }

        const colMeta = this.extractMeta(doc, col);
        columns.push({
          name: colName,
          description: this.getString(col, 'description'),
          dataType: this.getStringOrNull(col, 'data_type'),
          ...(colMeta ? { meta: colMeta } : {}),
        });

        // Extract tests on this column
        this.extractColumnTests(
          name,
          colName,
          col,
          relationshipTests,
          uniqueColumns,
          notNullColumns,
          sourceRelationshipTests,
        );
        // A contract's column constraint: `constraints: [{ type: not_null }]` (or `primary_key`, never null).
        if (this.hasNotNullConstraint(this.deref(col.get('constraints')))) {
          this.addColumn(name, colName, notNullColumns);
        }
      }
    }
    // A contract's model-level constraint: `constraints: [{ type: not_null, columns: [a, b] }]`
    // (or `primary_key`: a key's columns are never null).
    const modelConstraints = modelNode.get('constraints');
    if (isSeq(modelConstraints)) {
      for (const item of (modelConstraints as YAMLSeq).items) {
        if (!isMap(item) || !REQUIRING_CONSTRAINTS.has(this.getString(item as YAMLMap, 'type'))) continue;
        const cols = (item as YAMLMap).get('columns');
        if (!isSeq(cols)) continue;
        for (const c of (cols as YAMLSeq).items) {
          const colName = this.resolveScalar(c);
          if (colName) this.addColumn(name, colName, notNullColumns);
        }
      }
    }

    // Model-level tests that name a column (`column_name:`), then unique_combination_of_columns.
    this.extractModelColumnTests(name, modelNode, relationshipTests, uniqueColumns, notNullColumns, sourceRelationshipTests);
    this.extractModelLevelTests(name, modelNode, compositeUniqueGroups);
    compositeForeignKeys.push(...this.extractCompositeForeignKeys(name, modelNode));

    const meta = this.extractMeta(doc, modelNode);
    const configSchema = this.extractConfigSchema(modelNode);
    const config = this.deref(modelNode.get('config'));
    const disabled = isMap(config) && isFalse((config as YAMLMap).get('enabled'));
    models.set(name, {
      name,
      description,
      columns,
      filePath,
      tags,
      ...(meta ? { meta } : {}),
      ...(configSchema ? { configSchema } : {}),
      ...(disabled ? { disabled: true as const } : {}),
      ...(version !== undefined ? { version } : {}),
    });
  }

  /**
   * The column maps a model's yml declares, merges applied. For a versioned
   * model (`versions:`) they are its latest version's (`latest_version`, else
   * the highest `v`), as dbt builds it: the top-level `columns:` the version
   * includes (`include: all` / `'*'` / a list, minus `exclude:`; all of them
   * when it says nothing), then each column the version declares itself,
   * replacing a top-level one of the same name.
   */
  private modelColumnNodes(modelNode: YAMLMap): { columns: YAMLMap[]; version?: number } {
    const mapsOf = (node: unknown): YAMLMap[] => (isSeq(node)
      ? (node as YAMLSeq).items.map((i) => this.deref(i)).filter((i): i is YAMLMap => isMap(i))
      : []);
    const topLevel = mapsOf(this.deref(modelNode.get('columns')));
    const versions = mapsOf(this.deref(modelNode.get('versions')));
    const vOf = (m: YAMLMap): number | undefined => {
      const v = m.get('v');
      const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : undefined;
      return n !== undefined && Number.isFinite(n) ? n : undefined;
    };
    const numbered = versions.filter((m) => vOf(m) !== undefined);
    if (numbered.length === 0) return { columns: topLevel };
    const latestRaw = modelNode.get('latest_version');
    const latest = typeof latestRaw === 'number' ? latestRaw : typeof latestRaw === 'string' ? Number(latestRaw.trim()) : NaN;
    const chosen = numbered.find((m) => vOf(m) === latest) ?? numbered.reduce((a, b) => (vOf(b)! > vOf(a)! ? b : a));
    const version = vOf(chosen)!;

    const own = mapsOf(this.deref(chosen.get('columns')));
    if (own.length === 0 && !chosen.has('columns')) return { columns: topLevel, version };
    const rule = own.find((m) => m.has('include') || m.has('exclude'));
    const names = (node: unknown): Set<string> => new Set((isSeq(node) ? (node as YAMLSeq).items : [])
      .map((i) => this.resolveScalar(i)).filter((x): x is string => !!x).map(normaliseName));
    const include = rule ? this.deref(rule.get('include')) : undefined;
    const includeAll = include === undefined || include === null || (typeof include === 'string' && ['all', '*'].includes(include.trim().toLowerCase()));
    const included = includeAll ? undefined : names(include);
    const excluded = rule ? names(this.deref(rule.get('exclude'))) : new Set<string>();
    const ownByName = new Map(own.filter((m) => this.getString(m, 'name')).map((m) => [normaliseName(this.getString(m, 'name')), m]));
    const out: YAMLMap[] = [];
    const taken = new Set<string>();
    for (const m of topLevel) {
      const key = normaliseName(this.getString(m, 'name'));
      if (!key || (included && !included.has(key)) || excluded.has(key)) continue;
      out.push(ownByName.get(key) ?? m);
      taken.add(key);
    }
    for (const [key, m] of ownByName) if (!taken.has(key)) out.push(m);
    return { columns: out, version };
  }

  /**
   * The enabled tables of a schema file's `sources:` blocks: a source with
   * `config: enabled: false` (or `enabled: false`) turns off all its tables,
   * a table's own turns off that one. `identifier:` and `quoting: identifier:`
   * are read from the table, else its source.
   */
  private extractSources(sourcesNode: unknown, out: YmlSourceTable[]): void {
    if (!isSeq(sourcesNode)) return;
    const enabled = (m: YAMLMap): boolean => {
      const config = this.deref(m.get('config'));
      return !isFalse(m.get('enabled')) && !(isMap(config) && isFalse((config as YAMLMap).get('enabled')));
    };
    const quotedIdentifier = (m: YAMLMap): boolean | undefined => {
      const quoting = this.deref(m.get('quoting'));
      const q = isMap(quoting) ? (quoting as YAMLMap).get('identifier') : undefined;
      return q === undefined || q === null ? undefined : q === true || (typeof q === 'string' && q.trim().toLowerCase() === 'true');
    };
    for (const rawSource of (sourcesNode as YAMLSeq).items) {
      const source = this.deref(rawSource);
      if (!isMap(source)) continue;
      const sourceMap = source as YAMLMap;
      const sourceName = this.getString(sourceMap, 'name').trim();
      if (!sourceName || !enabled(sourceMap)) continue;
      const tables = this.deref(sourceMap.get('tables'));
      if (!isSeq(tables)) continue;
      for (const rawTable of (tables as YAMLSeq).items) {
        const table = this.deref(rawTable);
        if (!isMap(table)) continue;
        const t = table as YAMLMap;
        const name = this.getString(t, 'name').trim();
        if (!name || !enabled(t)) continue;
        const identifier = this.getString(t, 'identifier').trim();
        const quoted = quotedIdentifier(t) ?? quotedIdentifier(sourceMap) ?? false;
        const columnsNode = this.deref(t.get('columns'));
        const columns: YmlColumn[] = isSeq(columnsNode)
          ? (columnsNode as YAMLSeq).items.map((i) => this.deref(i)).filter((i): i is YAMLMap => isMap(i))
            .map((c) => ({ name: this.getString(c, 'name'), description: this.getString(c, 'description'), dataType: this.getStringOrNull(c, 'data_type') }))
            .filter((c) => c.name.trim() !== '')
          : [];
        const line = this.lineOf(rawTable);
        out.push({
          source: sourceName,
          name,
          ...(identifier && identifier !== name ? { identifier } : {}),
          ...(quoted ? { quoted: true } : {}),
          description: this.getString(t, 'description'),
          columns,
          file: this.currentFile,
          ...(line !== undefined ? { line } : {}),
        });
      }
    }
  }

  /** The custom schema a model's `config: schema:` sets, when it is a non-empty string. */
  private extractConfigSchema(modelNode: YAMLMap): string | undefined {
    const configNode = modelNode.get('config');
    if (!isMap(configNode)) return undefined;
    const schema = (configNode as YAMLMap).get('schema');
    return typeof schema === 'string' && schema.trim() !== '' ? schema.trim() : undefined;
  }

  /**
   * Extract tests from a column's `tests:` / `data_tests:` sequence.
   *
   * Handles:
   * - scalar tests: `- unique`
   * - map-form tests with config: `- unique: { config: { severity: warn } }`
   * - object tests: `- relationships: { to: ..., field: ... }`
   * - dbt 1.10 `arguments:` nesting: `- relationships: { arguments: { to, field } }`
   */
  private extractColumnTests(
    modelName: string,
    columnName: string,
    colNode: YAMLMap,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    notNullColumns: Map<string, Set<string>> = new Map(),
    sourceRelationshipTests: YmlSourceRelationshipTest[] = [],
  ): void {
    for (const listKey of TEST_LIST_KEYS) {
      const testsNode = this.deref(colNode.get(listKey));
      if (!isSeq(testsNode)) {
        continue;
      }

      for (const testItem of (testsNode as YAMLSeq).items) {
        this.readColumnTest(modelName, columnName, testItem, relationshipTests, uniqueColumns, notNullColumns, sourceRelationshipTests);
      }
    }
  }

  /**
   * A model's own `tests:` / `data_tests:` that name their column with
   * `column_name:` (`- relationships: { column_name: customer_id, to: …, field: … }`,
   * `- not_null: { column_name: id }`): read as the column's tests. A
   * `column_name` that is an expression (`coalesce(a, b)`) names no column and is skipped.
   */
  private extractModelColumnTests(
    modelName: string,
    modelNode: YAMLMap,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    notNullColumns: Map<string, Set<string>>,
    sourceRelationshipTests: YmlSourceRelationshipTest[],
  ): void {
    const keys: readonly string[] = ['unique', ...NOT_NULL_TEST_KEYS, ...RELATIONSHIP_TEST_KEYS];
    for (const listKey of TEST_LIST_KEYS) {
      const testsNode = this.deref(modelNode.get(listKey));
      if (!isSeq(testsNode)) continue;
      for (const rawItem of (testsNode as YAMLSeq).items) {
        const testItem = this.deref(rawItem);
        if (!isMap(testItem)) continue;
        const testMap = testItem as YAMLMap;
        const testName = this.getString(testMap, 'test_name').trim();
        const key = keys.find((k) => testName === k || testMap.has(k));
        if (!key) continue;
        const node = testName === key ? testMap : this.deref(testMap.get(key));
        const columnName = this.testMaps(node).map((m) => this.getString(m, 'column_name').trim()).find(Boolean);
        // A plain identifier, or any name in quotes (`"Order Id"`, a `quote: true` column); not an expression.
        if (!columnName) continue;
        const unquoted = unquoteIdentifier(columnName);
        if (unquoted === columnName && !/^[A-Za-z_][\w$]*$/.test(unquoted)) continue;
        this.readColumnTest(modelName, unquoted, rawItem, relationshipTests, uniqueColumns, notNullColumns, sourceRelationshipTests);
      }
    }
  }

  /** One item of a column's test list (see {@link extractColumnTests}). */
  private readColumnTest(
    modelName: string,
    columnName: string,
    testItem: unknown,
    relationshipTests: YmlRelationshipTest[],
    uniqueColumns: Map<string, Set<string>>,
    notNullColumns: Map<string, Set<string>>,
    sourceRelationshipTests: YmlSourceRelationshipTest[],
  ): void {
    const rawItem = testItem;
    testItem = this.deref(testItem);
    // Scalar test: `- unique` or `- not_null`
    const scalarValue = this.resolveScalar(testItem);
    if (scalarValue === 'unique') {
      this.addUniqueColumn(modelName, columnName, uniqueColumns);
      return;
    }
    if (scalarValue !== undefined && (NOT_NULL_TEST_KEYS as readonly string[]).includes(scalarValue)) {
      this.addColumn(modelName, columnName, notNullColumns);
      return;
    }

    if (!isMap(testItem)) {
      return;
    }
    const testMap = testItem as YAMLMap;
    // dbt's alternative format: `- name: my_test` + `test_name: not_null`, its
    // arguments and `config:` beside them. Read as `- <test_name>: <the map>`.
    const testName = this.getString(testMap, 'test_name').trim();
    const testNode = (key: string): unknown => (testName === key ? testMap : this.deref(testMap.get(key)));
    const declares = (key: string): boolean => testName === key || testMap.has(key);

    // Map-form unique test carrying config: `- unique:` / `- unique: { config: ... }`
    if (declares('unique')) {
      this.addUniqueColumn(modelName, columnName, uniqueColumns);
    }
    // Map-form not_null (`- not_null:` / `- not_null: { config: { severity: warn } }`): required,
    // unless a `where:` (or dbt_expectations' `row_condition:`) limits it to some rows or
    // `enabled: false` turns it off.
    if (NOT_NULL_TEST_KEYS.some((key) => declares(key) && this.testHoldsForEveryRow(testNode(key)) && this.testIsEnabled(testNode(key)))) {
      this.addColumn(modelName, columnName, notNullColumns);
    }

    // Relationship tests (relationships, relationships_where, …)
    for (const key of RELATIONSHIP_TEST_KEYS) {
      const relNode = testNode(key);
      if (isMap(relNode)) {
        const target = this.relationshipTarget(relNode as YAMLMap);
        const line = this.lineOf(rawItem);
        const at = { file: this.currentFile, ...(line !== undefined ? { line } : {}) };
        if (target?.source) {
          // `to: source('raw', 'customers')`: a source is not a model, so it is never drawn; kept to be said.
          sourceRelationshipTests.push({ fromModel: modelName, fromColumn: columnName, source: target.source, toColumn: target.toColumn, ...at });
          continue;
        }
        const relTest = this.extractRelationshipTest(
          modelName,
          columnName,
          relNode as YAMLMap,
        );
        if (relTest) {
          // relationships_where holds for the rows its conditions pick; a where: config likewise.
          // A disabled test still declares the link: it has no condition.
          if (key !== 'relationships' || !this.testHoldsForEveryRow(relNode)) relTest.conditional = true;
          const condition = this.conditionOf(relNode);
          relationshipTests.push({ ...relTest, ...(condition ? { condition } : {}), ...at });
        }
      }
    }
  }

  /** Adds `columnName` to `modelName`'s set in `byModel`. */
  private addColumn(modelName: string, columnName: string, byModel: Map<string, Set<string>>): void {
    let cols = byModel.get(modelName);
    if (!cols) {
      cols = new Set<string>();
      byModel.set(modelName, cols);
    }
    cols.add(columnName);
  }

  /**
   * Whether a test's node (its kwargs map, or null for `- not_null:`) holds
   * for every row: no `where:` (at the top, under `arguments:` or in
   * `config:`) and no dbt_expectations `row_condition:`.
   */
  private testHoldsForEveryRow(node: unknown): boolean {
    for (const m of this.testMaps(node)) {
      for (const key of ['where', 'row_condition']) {
        const where = m.get(key);
        if (typeof where === 'string' && where.trim() !== '') return false;
      }
    }
    return true;
  }

  /** Whether a test is on: not `enabled: false` (at the top or in `config:`). */
  private testIsEnabled(node: unknown): boolean {
    return !this.testMaps(node).some((m) => {
      const enabled = m.get('enabled');
      return enabled === false || (typeof enabled === 'string' && enabled.trim().toLowerCase() === 'false');
    });
  }

  /** A test node's own map, its `arguments:` and its `config:` (the places dbt reads a setting from). */
  private testMaps(node: unknown): YAMLMap[] {
    if (!isMap(node)) return [];
    const testNode = this.deref(node) as YAMLMap;
    const nested = ['arguments', 'config'].map((k) => this.deref(testNode.get(k))).filter((n): n is YAMLMap => isMap(n));
    return [testNode, ...nested];
  }

  /**
   * A relationships test's condition as written: `from_condition` /
   * `to_condition` (dbt_utils' `relationships_where`) and `where:` (at the
   * top, under `arguments:` or in `config:`). Undefined when it has none.
   */
  private conditionOf(node: unknown): RelationshipTestCondition | undefined {
    const pick = (key: string): string | undefined => {
      for (const m of this.testMaps(node)) {
        const v = m.get(key);
        if (typeof v === 'string' && v.trim() !== '') return v.trim();
      }
      return undefined;
    };
    const from = pick('from_condition');
    const to = pick('to_condition');
    // `row_condition` limits rows as `where:` does (the reader's conditional rule, {@link testHoldsForEveryRow}).
    const where = pick('where') ?? pick('row_condition');
    if (!from && !to && !where) return undefined;
    return { ...(from ? { from } : {}), ...(to ? { to } : {}), ...(where ? { where } : {}) };
  }

  /** The 1-based line a node starts on in the file being read, when the parser recorded it. */
  private lineOf(node: unknown): number | undefined {
    const start = isNode(node) ? node.range?.[0] : undefined;
    if (start === undefined || !this.lineCounter) return undefined;
    return this.lineCounter.linePos(start).line;
  }

  /** Whether a column's `constraints:` list holds a `type: not_null` or `type: primary_key`. */
  private hasNotNullConstraint(node: unknown): boolean {
    if (!isSeq(node)) return false;
    return (node as YAMLSeq).items.some((item) => isMap(item) && REQUIRING_CONSTRAINTS.has(this.getString(item as YAMLMap, 'type')));
  }

  /**
   * A relationship test's target: `source` (`raw.customers`) when `to:` is a
   * `source('raw', 'customers')`, with the `field`; undefined otherwise (a
   * `ref()` is {@link extractRelationshipTest}'s).
   */
  private relationshipTarget(relNode: YAMLMap): { source?: string; toColumn: string } | undefined {
    const argsNode = this.deref(relNode.get('arguments'));
    const kwargs = isMap(argsNode) ? (argsNode as YAMLMap) : relNode;
    const to = this.getString(kwargs, 'to') || this.getString(relNode, 'to');
    const toColumn = this.getString(kwargs, 'field') || this.getString(relNode, 'field');
    const source = parseSourceCall(to);
    if (!source || !toColumn) return undefined;
    return { source: `${source.source}.${source.table}`, toColumn };
  }

  /** The repo-relative path of the schema file being read (forward slashes), for `file:`. */
  private currentFile = '';

  /** Line positions of the schema file being read, for {@link lineOf}. */
  private lineCounter: LineCounter | undefined;

  /** The schema file being read, for {@link deref}. */
  private aliasDoc: Document | undefined;

  /** The schema file's maps with their merges applied ({@link withMerges}), each built once. */
  private merged = new WeakMap<YAMLMap, YAMLMap>();

  /** Maps whose merges are being applied, so a map that merges itself stops. */
  private merging = new Set<YAMLMap>();

  /**
   * A node, or the node an alias names (`tests: *key_tests`), once: what it
   * names is read as written, so a nested alias is resolved only when it is
   * read too. Undefined for an alias that names nothing.
   */
  private deref(node: unknown, depth = 0): unknown {
    let resolved: unknown = node;
    if (isAlias(node)) {
      resolved = this.aliasTarget(node);
    }
    return isMap(resolved) ? this.withMerges(resolved as YAMLMap, depth) : resolved;
  }

  /**
   * The node an alias names in {@link aliasDoc}: the last node anchored with its
   * name before it, as YAML reads it (yaml's `Alias.resolve`). Every alias's
   * target is found in one walk of the document, built the first time one is
   * asked for: `Alias.resolve` without a cache walks the whole document per
   * alias, so a file sharing descriptions through anchors cost aliases x nodes.
   */
  private aliasTarget(alias: Alias): unknown {
    const doc = this.aliasDoc;
    if (!doc) return undefined;
    let targets = this.aliasTargets.get(doc);
    if (!targets) {
      targets = new Map();
      const last = new Map<string, unknown>();
      const found = targets;
      visit(doc, {
        Node: (_key, node) => {
          if (isAlias(node)) found.set(node, last.get(node.source));
          else if (node.anchor) last.set(node.anchor, node);
        },
      });
      this.aliasTargets.set(doc, targets);
    }
    return targets.get(alias);
  }

  /** Each document's aliases with the node each names ({@link aliasTarget}). */
  private aliasTargets = new WeakMap<Document, Map<Alias, unknown>>();

  /**
   * A map with its YAML 1.1 merge keys applied (`<<: *defaults`,
   * `<<: [*a, *b]`), as dbt reads it: the map's own keys win, then each
   * merged map's in order, the first to give a key keeping it. A map with no
   * merge key is returned as it is; otherwise a new map holds the pairs (the
   * file's nodes are never changed).
   */
  private withMerges(map: YAMLMap, depth: number): YAMLMap {
    if (!map.items.some(isMergePair) || depth >= MAX_MERGE_DEPTH) return map;
    // Each map is merged once per file: an anchor merged many times over
    // (`<<: [*a, *a, …]` at every level) would otherwise cost fan-out^depth.
    // A map met again while its own merge is being built (it merges itself)
    // is read as written.
    const done = this.merged.get(map);
    if (done) return done;
    if (this.merging.has(map)) return map;
    this.merging.add(map);
    try {
      const out = this.buildMerged(map, depth);
      this.merged.set(map, out);
      return out;
    } finally {
      this.merging.delete(map);
    }
  }

  /** {@link withMerges}' map, built. */
  private buildMerged(map: YAMLMap, depth: number): YAMLMap {
    const keyOf = (pair: Pair): unknown => (isScalar(pair.key) ? pair.key.value : pair.key);
    const out = new YAMLMap();
    const seen = new Set<unknown>();
    for (const pair of map.items) {
      if (isMergePair(pair)) continue;
      seen.add(keyOf(pair));
      out.items.push(pair);
    }
    for (const pair of map.items) {
      if (!isMergePair(pair)) continue;
      const value = this.deref(pair.value, depth + 1);
      const merged = isSeq(value) ? (value as YAMLSeq).items.map((i) => this.deref(i, depth + 1)) : [value];
      for (const m of merged) {
        if (!isMap(m)) continue;
        for (const inner of (m as YAMLMap).items) {
          const key = keyOf(inner);
          if (seen.has(key)) continue;
          seen.add(key);
          out.items.push(inner);
        }
      }
    }
    return out;
  }

  private addUniqueColumn(
    modelName: string,
    columnName: string,
    uniqueColumns: Map<string, Set<string>>,
  ): void {
    let cols = uniqueColumns.get(modelName);
    if (!cols) {
      cols = new Set<string>();
      uniqueColumns.set(modelName, cols);
    }
    cols.add(columnName);
  }

  /**
   * Extract a relationship test from its kwargs map.
   *
   * Expected YAML structure (kwargs at the top level, or nested under
   * `arguments:` as dbt 1.10 recommends):
   * ```yaml
   * - relationships:
   *     to: ref('dim_project')
   *     field: project_id
   * - relationships:
   *     arguments:
   *       to: ref('dim_project')
   *       field: project_id
   * ```
   */
  private extractRelationshipTest(
    fromModel: string,
    fromColumn: string,
    relNode: YAMLMap,
  ): YmlRelationshipTest | null {
    const argsNode = this.deref(relNode.get('arguments'));
    const kwargs = isMap(argsNode) ? (argsNode as YAMLMap) : relNode;

    const toRef = this.getString(kwargs, 'to') || this.getString(relNode, 'to');
    const toColumn = this.getString(kwargs, 'field') || this.getString(relNode, 'field');

    if (!toRef || !toColumn) {
      return null;
    }

    // Extract model name from ref('model'), ref('project', 'model') or ref('model', v=2)
    const toModel = parseRefModelName(toRef);

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
    for (const key of TEST_LIST_KEYS) {
      const testsNode = this.deref(modelNode.get(key));
      if (!isSeq(testsNode)) {
        continue;
      }

      for (const rawTest of (testsNode as YAMLSeq).items) {
        const testItem = this.deref(rawTest);
        if (!isMap(testItem)) {
          continue;
        }
        const testMap = testItem as YAMLMap;

        // Check for unique_combination_of_columns (with or without dbt_utils prefix)
        for (const testKey of [
          'unique_combination_of_columns',
          'dbt_utils.unique_combination_of_columns',
        ]) {
          const ucoNode = this.deref(testMap.get(testKey));
          if (!isMap(ucoNode)) {
            continue;
          }
          // dbt 1.10 nests test kwargs under `arguments:`
          const ucoArgs = this.deref((ucoNode as YAMLMap).get('arguments'));
          const ucoKwargs = isMap(ucoArgs) ? (ucoArgs as YAMLMap) : (ucoNode as YAMLMap);
          const combo = ucoKwargs.get('combination_of_columns')
            ?? (ucoNode as YAMLMap).get('combination_of_columns');
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

  /**
   * A model's composite foreign keys (#133 L2), two or more columns each: dbt
   * ≥ 1.9 model-level `constraints:` of `type: foreign_key` (`columns`,
   * `to: ref(...)`, `to_columns`), and `dbt_constraints.foreign_key` tests
   * under `tests:` / `data_tests:` (`fk_column_names`, `pk_table_name`,
   * `pk_column_names`, possibly nested under `arguments:`). Lists of unequal
   * length, or a target that is not a `ref()`, are skipped.
   */
  private extractCompositeForeignKeys(modelName: string, modelNode: YAMLMap): CompositeForeignKey[] {
    const list = (node: unknown): string[] | null => {
      if (!isSeq(node)) return null;
      const cols = (node as YAMLSeq).items.map((item) => this.resolveScalar(item));
      return cols.every((c): c is string => typeof c === 'string' && c.trim() !== '') ? cols.map((c) => c.trim()) : null;
    };
    const out: CompositeForeignKey[] = [];
    const add = (fromColumns: string[] | null, to: string, toColumns: string[] | null, name?: string): void => {
      const toModel = parseRefModelName(to);
      if (!toModel || !fromColumns || !toColumns || fromColumns.length < 2 || fromColumns.length !== toColumns.length) return;
      out.push({ fromModel: modelName, fromColumns, toModel, toColumns, ...(name ? { name } : {}) });
    };

    const constraints = modelNode.get('constraints');
    if (isSeq(constraints)) {
      for (const item of (constraints as YAMLSeq).items) {
        if (!isMap(item)) continue;
        const c = item as YAMLMap;
        if (this.getString(c, 'type') !== 'foreign_key') continue;
        add(list(c.get('columns')), this.getString(c, 'to'), list(c.get('to_columns')), this.getString(c, 'name') || undefined);
      }
    }

    for (const key of TEST_LIST_KEYS) {
      const testsNode = modelNode.get(key);
      if (!isSeq(testsNode)) continue;
      for (const testItem of (testsNode as YAMLSeq).items) {
        if (!isMap(testItem)) continue;
        const fkNode = (testItem as YAMLMap).get('dbt_constraints.foreign_key');
        if (!isMap(fkNode)) continue;
        const args = (fkNode as YAMLMap).get('arguments');
        const kwargs = isMap(args) ? (args as YAMLMap) : (fkNode as YAMLMap);
        add(list(kwargs.get('fk_column_names')), this.getString(kwargs, 'pk_table_name'), list(kwargs.get('pk_column_names')));
      }
    }
    return out;
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

    // Source files carry a project-relative path already, so the same prefix
    // test applies.
    let filteredSourceFiles: Map<string, string> | undefined;
    if (data.sourceFiles) {
      filteredSourceFiles = new Map<string, string>();
      for (const [stem, relativePath] of data.sourceFiles) {
        if (relativePath.startsWith(normalizedPrefix)) {
          filteredSourceFiles.set(stem, relativePath);
        }
      }
    }

    let filteredResourceDocs: Map<string, YmlResourceDoc> | undefined;
    if (data.resourceDocs) {
      filteredResourceDocs = new Map<string, YmlResourceDoc>();
      for (const [key, doc] of data.resourceDocs) {
        const relativePath = path.relative(projectPath, doc.filePath).replace(/\\/g, '/');
        if (relativePath.startsWith(normalizedPrefix)) {
          filteredResourceDocs.set(key, doc);
        }
      }
    }

    return {
      models: filteredModels,
      relationshipTests: filteredRelTests,
      uniqueColumns: filteredUniqueColumns,
      compositeUniqueGroups: filteredCompositeGroups,
      sourceFiles: filteredSourceFiles,
      resourceDocs: filteredResourceDocs,
      ...(data.compositeForeignKeys
        ? { compositeForeignKeys: data.compositeForeignKeys.filter((fk) => modelNames.has(fk.fromModel) && modelNames.has(fk.toModel)) }
        : {}),
      ...(data.notNullColumns
        ? { notNullColumns: new Map([...data.notNullColumns].filter(([model]) => modelNames.has(model))) }
        : {}),
      ...(data.sourceRelationshipTests
        ? { sourceRelationshipTests: data.sourceRelationshipTests.filter((t) => modelNames.has(t.fromModel)) }
        : {}),
      ...(data.sources ? { sources: data.sources.filter((t) => t.file.startsWith(normalizedPrefix)) } : {}),
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

  /**
   * A model's or column's dbt `meta:` — the top-level key merged with
   * `config: meta:` (where dbt 1.10 moved it), the config winning per key as
   * dbt merges them. Read for the CLI inventory only; the physical stage never
   * shows or compares it.
   *
   * Converted through the document, so anchors, aliases (a whole `meta: *shared`
   * too) and `<<:` merge keys resolve as dbt reads them; an alias bomb past the
   * library's alias limit throws and reads as no meta.
   */
  private extractMeta(doc: Document, node: YAMLMap): Meta | undefined {
    const plain = (value: unknown): unknown => {
      if (!isNode(value)) { return undefined; }
      try {
        return value.toJS(doc);
      } catch {
        return undefined;
      }
    };
    const config = plain(node.get('config'));
    const configMeta = config && typeof config === 'object' ? (config as Record<string, unknown>).meta : undefined;
    return readMeta(plain(node.get('meta')), configMeta);
  }

  /** Get a string value from a YAML map, defaulting to ''. */
  private getString(node: YAMLMap, key: string): string {
    return this.stringValue(node.get(key)) ?? '';
  }

  /** Get a string value from a YAML map, or null if missing/non-string. */
  private getStringOrNull(node: YAMLMap, key: string): string | null {
    return this.stringValue(node.get(key)) ?? null;
  }

  /** A value as a string: `description: *shared_desc` is the string its anchor names, as dbt reads it. */
  private stringValue(val: unknown): string | undefined {
    if (typeof val === 'string') return val;
    if (!isAlias(val)) return undefined;
    const resolved = this.deref(val);
    return isScalar(resolved) && typeof resolved.value === 'string' ? resolved.value : undefined;
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
