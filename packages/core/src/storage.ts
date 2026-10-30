/**
 * Where things live in a semantic dir, for every storage ERD Studio reads:
 * the single file classifier ({@link classifySemanticFile}), the order a
 * table name is looked up in ({@link tableFileCandidates}), the paths that
 * belong together (a table's relationships file, a diagram's layout file),
 * the shapes and path builders of the layer-first DBML tree (2.0) and of
 * the 1.9 pre-release's tree it replaces, and the posix path helpers core
 * needs because it may not import `node:path`.
 *
 * Parser-free and pure: no file access, no `@dbml/parse`.
 */

import { NON_SUBJECT_AREA_DIRS } from './domain.js';
import { LAYERS_CONFIG_FILE } from './layers.js';
import { LOGICAL_MODELS_DIR, TABLES_DIR } from './logicalModel.js';
import {
  DBML_RELATIONSHIPS_FILE_NAME,
  DBML_RELATIONSHIPS_FILE_STEM,
  ERD_STUDIO_DBML_HEADER_PREFIX,
} from './dbmlRichProperties.js';

/** The folder of table templates; never a layer. */
export const TEMPLATES_DIR = 'templates';

/** What a file under the semantic dir is. */
export type SemanticFileKind = 'diagram' | 'table' | 'relationships' | 'layout' | 'layers' | 'template' | 'other';

/** The answer of {@link classifySemanticFile}. */
export interface SemanticFileClass {
  kind: SemanticFileKind;
  /** A diagram's (`json` / `dbml`), a table's (`yaml` / `dbml`) or a relationships file's (`dbml`) storage. */
  storage?: 'json' | 'dbml' | 'yaml';
  /** A diagram's or layout file's layer folder. */
  layer?: string;
  /** A table's or relationships file's library folder; absent at the top level. */
  folder?: string;
  /** A diagram's, layout file's or table's file stem. */
  name?: string;
}

/** Options for {@link classifySemanticFile}. */
export interface ClassifySemanticFileOptions {
  /** The project keeps a layer folder called `tables` (a pre-v6 project): it is then no table library. */
  tablesDirIsLayer: boolean;
  /**
   * The file's first line, when the caller has read it. A `.dbml` in a layer
   * folder that starts with the rich export's header is an export saved
   * there, not a diagram. Watchers and decorations classify by path only.
   */
  firstLine?: string;
}

/**
 * A library folder's name as the extension lists folders: any non-empty name
 * without a separator or NUL that does not start with `.` (`Finance` and
 * `SAP FI` included). `TABLE_FOLDER_PATTERN` stays the rule for the folders
 * ERD Studio creates, never for the ones it reads.
 */
export function isLibraryFolderName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name !== '' &&
    !name.startsWith('.') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\u0000')
  );
}

/**
 * Whether `name` is the reserved relationships-file stem `_relationships`,
 * as `sameName` compares names (case-insensitive, surrounding white space
 * ignored), so a create path that trims a name after validating it cannot
 * slip past. A new `.dbml` table may not take it; an existing YAML table
 * called that stays a table.
 */
export function isReservedTableName(name: string): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === DBML_RELATIONSHIPS_FILE_STEM;
}

/** Whether a listed file stem, exactly as listed (any case, never trimmed), is the relationships file's. */
function isRelationshipsStem(stem: string): boolean {
  return stem.toLowerCase() === DBML_RELATIONSHIPS_FILE_STEM;
}

/** `name` without its final extension, and the extension (with its dot), or `''` when it has none. */
function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? { stem: name, ext: '' } : { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** A file name a classifier accepts: not hidden, and with a stem before its extension. */
function isPlainFileName(name: string): boolean {
  return name !== '' && !name.startsWith('.') && !name.includes('\\') && !name.includes('\u0000');
}

/**
 * The one answer to "what is this file?" for every host: watchers,
 * decorations, listings, the custom editor's reroute, `doctor`, `inventory`
 * and Convert. `relPath` is posix and relative to the semantic dir.
 *
 * - `layers.json` → `layers`; `templates/**` → `template`;
 * - `logical-models/[<f>/]<n>.yml` → a YAML `table`;
 * - while `tables/` is the library: `tables/[<f>/]_relationships.dbml` (any
 *   case) → `relationships`, `tables/[<f>/]<n>.dbml` → a DBML `table`,
 *   `tables/[<f>/]<n>.yml` → a YAML `table` (`_relationships.yml` included),
 *   anything else under `tables/` → `other`;
 * - `<d>/<n>.json` → a JSON `diagram`, `<d>/<n>.dbml` → a DBML `diagram`
 *   (unless `<n>` is reserved or `firstLine` is the export header) and
 *   `<d>/<n>.dbdiagram` → its `layout`, when `<d>` is a layer: not hidden,
 *   not in `NON_SUBJECT_AREA_DIRS` and not the library (a `tables` layer
 *   holds JSON diagrams only);
 * - everything else → `other`.
 */
export function classifySemanticFile(relPath: string, options: ClassifySemanticFileOptions): SemanticFileClass {
  const other: SemanticFileClass = { kind: 'other' };
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\\')) return other;
  if (relPath.startsWith('/')) return other;
  const normalised = normalisePosix(relPath);
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) return other;
  const segments = normalised.split('/');
  const fileName = segments[segments.length - 1];

  if (segments.length === 1) {
    return fileName === LAYERS_CONFIG_FILE ? { kind: 'layers' } : other;
  }
  if (segments[0] === TEMPLATES_DIR) {
    return { kind: 'template' };
  }
  if (!isPlainFileName(fileName)) return other;
  const { stem, ext } = splitExtension(fileName);
  if (stem === '') return other;

  const libraryFolder = segments.length === 3 ? segments[1] : undefined;
  const inLibraryShape = segments.length === 2 || (segments.length === 3 && isLibraryFolderName(segments[1]));
  const folderPart = libraryFolder !== undefined ? { folder: libraryFolder } : {};

  if (segments[0] === LOGICAL_MODELS_DIR) {
    return inLibraryShape && ext === '.yml' ? { kind: 'table', storage: 'yaml', ...folderPart, name: stem } : other;
  }

  if (segments[0] === TABLES_DIR && !options.tablesDirIsLayer) {
    if (!inLibraryShape) return other;
    if (ext === '.dbml') {
      return isRelationshipsStem(stem)
        ? { kind: 'relationships', storage: 'dbml', ...folderPart }
        : { kind: 'table', storage: 'dbml', ...folderPart, name: stem };
    }
    if (ext === '.yml') return { kind: 'table', storage: 'yaml', ...folderPart, name: stem };
    return other;
  }

  if (segments.length !== 2) return other;
  const layer = segments[0];
  if (layer.startsWith('.') || NON_SUBJECT_AREA_DIRS.has(layer)) return other;

  if (ext === '.json') {
    return { kind: 'diagram', storage: 'json', layer, name: stem };
  }
  // A `tables` layer belongs to a YAML project: its `.dbml` files are not
  // diagrams (doctor's tablesLayerConflict names them).
  if (layer === TABLES_DIR) return other;
  if (ext === '.dbml') {
    if (isRelationshipsStem(stem)) return other;
    if (options.firstLine !== undefined && options.firstLine.replace(/^﻿/, '').startsWith(ERD_STUDIO_DBML_HEADER_PREFIX)) {
      return other;
    }
    return { kind: 'diagram', storage: 'dbml', layer, name: stem };
  }
  if (ext === '.dbdiagram') {
    return isRelationshipsStem(stem) ? other : { kind: 'layout', layer, name: stem };
  }
  return other;
}

/** A subject area file's storage, by its extension: `json`, `dbml`, or undefined for anything else. */
export function subjectAreaStorageOf(path: string): 'json' | 'dbml' | undefined {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.dbml')) return 'dbml';
  return undefined;
}

/** The index of the last path separator (`/`, or `\` for a Windows host path). */
function lastSeparator(path: string): number {
  return Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
}

/** The relationships file of a table file's folder: the same directory, `_relationships.dbml`. */
export function relationshipsFilePathOf(tableFilePath: string): string {
  return tableFilePath.slice(0, lastSeparator(tableFilePath) + 1) + DBML_RELATIONSHIPS_FILE_NAME;
}

/** A DBML diagram's layout file, beside it: `sales.dbml` → `sales.dbdiagram`. */
export function layoutFilePathOf(diagramPath: string): string {
  return (diagramPath.endsWith('.dbml') ? diagramPath.slice(0, -'.dbml'.length) : diagramPath) + '.dbdiagram';
}

/** The diagram a layout file belongs to: `sales.dbdiagram` → `sales.dbml`. */
export function diagramPathOfLayout(layoutPath: string): string {
  return (layoutPath.endsWith('.dbdiagram') ? layoutPath.slice(0, -'.dbdiagram'.length) : layoutPath) + '.dbml';
}

/**
 * Where a table name may live, in the order every host looks (§3.4 of the
 * native DBML storage spec): `logical-models/<name>.yml`, then each of its
 * folders; then, for the top level and each folder in turn, `tables/…/<name>.dbml`
 * (only when `options.dbml`) before `tables/…/<name>.yml`. `folders` is
 * de-duplicated and sorted with `localeCompare`, so a name that (wrongly)
 * exists in two folders resolves to the same file in every host. `prefix` is
 * the semantic dir with its trailing separator (or `''`).
 */
export function tableFileCandidates(prefix: string, name: string, folders: readonly string[], options: { dbml: boolean }): string[] {
  const sorted = [...new Set(folders)].sort((a, b) => a.localeCompare(b));
  const subs = ['', ...sorted.map((f) => `${f}/`)];
  const candidates = subs.map((sub) => `${prefix}${LOGICAL_MODELS_DIR}/${sub}${name}.yml`);
  for (const sub of subs) {
    if (options.dbml) candidates.push(`${prefix}${TABLES_DIR}/${sub}${name}.dbml`);
    candidates.push(`${prefix}${TABLES_DIR}/${sub}${name}.yml`);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// The layer-first DBML tree (2.0)
// ---------------------------------------------------------------------------

/** A DBML layer's diagrams folder: `<layer>/diagrams/<n>.dbml`. */
export const DIAGRAMS_DIR = 'diagrams';

/** A DBML layer's relationships folder: `<layer>/relationships/<f>.dbml`, flat. */
export const RELATIONSHIPS_DIR = 'relationships';

/**
 * Folder names no layer may take, compared case-insensitively: `tables`
 * (`tables/tables/S/x.dbml` would have the 1.9 pre-release's shape),
 * `templates` (ERD Studio's own folder) and `logical-models` (the YAML
 * library beside the layers). `diagrams` and `relationships` are not
 * reserved: the tree is read by depth, so `diagrams/diagrams/x.dbml` is a
 * diagram of the layer `diagrams`.
 */
export const RESERVED_LAYER_NAMES: ReadonlySet<string> = new Set([TABLES_DIR, TEMPLATES_DIR, LOGICAL_MODELS_DIR]);

/** A layer id as `layers.json` and the layer folder spell it: lower-case, starting with a letter. */
const LAYER_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;

/** The extension of every file of the layer-first tree, compared exactly. */
const DBML_EXTENSION = '.dbml';

/** Whether `name` is one of {@link RESERVED_LAYER_NAMES}, in any case. */
export function isReservedLayerName(name: string): boolean {
  return typeof name === 'string' && RESERVED_LAYER_NAMES.has(name.toLowerCase());
}

/**
 * Whether a top-level folder is a DBML layer: a library folder name
 * ({@link isLibraryFolderName}), not reserved ({@link isReservedLayerName}),
 * not one of `NON_SUBJECT_AREA_DIRS` (exactly, as JSON layers compare it),
 * and a layer id (`^[a-z][a-z0-9_-]*$`), so the folder is the layer's id and
 * its display name is its `label` in `layers.json`. `Gold/`, `sales area/`
 * and `gold.old/` are never layers. Being listed in `layers.json` is not
 * required: a diagram needs that to open, its tables and relationships do not.
 */
export function isDbmlLayerName(name: string): boolean {
  return (
    isLibraryFolderName(name) &&
    !isReservedLayerName(name) &&
    !NON_SUBJECT_AREA_DIRS.has(name) &&
    LAYER_ID_PATTERN.test(name)
  );
}

/** The stem of a `.dbml` file name (exact extension, plain name), or undefined. */
function dbmlStemOf(fileName: string): string | undefined {
  if (!isPlainFileName(fileName)) return undefined;
  const { stem, ext } = splitExtension(fileName);
  return ext === DBML_EXTENSION && stem !== '' ? stem : undefined;
}

/**
 * Where a DBML diagram belongs, from any spelling of its path (absolute or
 * relative, either separator): its last three segments must be
 * `<layer>/diagrams/<name>.dbml`, with `<layer>` a DBML layer name
 * ({@link isDbmlLayerName}) and `diagrams` and `.dbml` spelled exactly.
 * `dir` is the diagram's folder relative to the semantic dir, the base its
 * `use` paths resolve against. Undefined for any other path.
 */
export function diagramPathOf(anyPath: string): { layer: string; dir: string; name: string } | undefined {
  if (typeof anyPath !== 'string') return undefined;
  const segments = anyPath.split(/[\\/]/).filter((s) => s !== '');
  if (segments.length < 3) return undefined;
  const [layer, folder, file] = segments.slice(-3);
  if (folder !== DIAGRAMS_DIR || !isDbmlLayerName(layer)) return undefined;
  const name = dbmlStemOf(file);
  return name === undefined ? undefined : { layer, dir: `${layer}/${DIAGRAMS_DIR}`, name };
}

/** A file of the layer-first DBML tree, from {@link dbmlTreePathOf}. */
export interface DbmlTreePath {
  kind: 'table' | 'relationships' | 'diagram';
  /** The layer folder, as listed. */
  layer: string;
  /** A table's schema folder, as listed. */
  schema?: string;
  /** The file stem: the table's or diagram's name, or the relationships file's. */
  name: string;
}

/**
 * The exact shapes of the layer-first tree, for a posix path relative to the
 * semantic dir: `L/diagrams/n.dbml` (a diagram), `L/relationships/f.dbml` (a
 * relationships file, never in a subfolder) and `L/tables/S/n.dbml` (a table
 * of the schema `S`), where `L` is a DBML layer name ({@link isDbmlLayerName}),
 * `S` a library folder name, and the fixed folder names and `.dbml` are
 * spelled exactly. `L/tables/relationships/x.dbml` is a table. Undefined for
 * every other path (absolute, `..`, five segments, `gold/Diagrams/x.dbml`).
 */
export function dbmlTreePathOf(rel: string): DbmlTreePath | undefined {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\\') || rel.startsWith('/')) return undefined;
  const normalised = normalisePosix(rel);
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) return undefined;
  const segments = normalised.split('/');
  const layer = segments[0];
  if (segments.length < 3 || segments.length > 4 || !isDbmlLayerName(layer)) return undefined;
  const name = dbmlStemOf(segments[segments.length - 1]);
  if (name === undefined) return undefined;
  if (segments.length === 3) {
    if (segments[1] === DIAGRAMS_DIR) return { kind: 'diagram', layer, name };
    if (segments[1] === RELATIONSHIPS_DIR) return { kind: 'relationships', layer, name };
    return undefined;
  }
  if (segments[1] !== TABLES_DIR || !isLibraryFolderName(segments[2])) return undefined;
  return { kind: 'table', layer, schema: segments[2], name };
}

/** A DBML table's file: `L/tables/S/n.dbml`. */
export function dbmlTablePath(layer: string, schema: string, name: string): string {
  return `${layer}/${TABLES_DIR}/${schema}/${name}${DBML_EXTENSION}`;
}

/** A relationships file: `L/relationships/stem.dbml`. */
export function relationshipsFilePath(layer: string, stem: string): string {
  return `${layer}/${RELATIONSHIPS_DIR}/${stem}${DBML_EXTENSION}`;
}

/** A DBML diagram's file: `L/diagrams/n.dbml`. */
export function diagramFilePath(layer: string, name: string): string {
  return `${layer}/${DIAGRAMS_DIR}/${name}${DBML_EXTENSION}`;
}

/** What a file of the ERD Studio 1.9 pre-release's DBML tree was, by its path alone. */
export type LegacyDbmlShape = 'table' | 'relationships' | 'diagram' | 'layout';

/** The 1.9 pre-release's per-folder relationships file stem (`tables/[f/]_relationships.dbml`, any case). */
const LEGACY_RELATIONSHIPS_STEM = '_relationships';

/**
 * Whether a path relative to the semantic dir has a shape only the 1.9
 * pre-release wrote, which 2.0 does not read: any `*.dbdiagram` (a layout
 * file); `tables/n.dbml` or `tables/f/n.dbml` (a relationships file when the
 * stem is `_relationships` in any case, else a table); and a two-segment
 * `d/n.dbml` whose folder is not hidden and not `templates` (a diagram).
 * Path-only. Undefined for anything else, the whole layer-first tree included.
 */
export function legacyDbmlShapeOf(relPath: string): LegacyDbmlShape | undefined {
  if (typeof relPath !== 'string' || relPath === '' || relPath.includes('\\') || relPath.startsWith('/')) return undefined;
  const normalised = normalisePosix(relPath);
  if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) return undefined;
  if (normalised.endsWith('.dbdiagram')) return 'layout';
  const segments = normalised.split('/');
  const stem = dbmlStemOf(segments[segments.length - 1]);
  if (stem === undefined) return undefined;
  if (segments[0] === TABLES_DIR && (segments.length === 2 || (segments.length === 3 && isLibraryFolderName(segments[1])))) {
    return stem.toLowerCase() === LEGACY_RELATIONSHIPS_STEM ? 'relationships' : 'table';
  }
  if (segments.length === 2 && !segments[0].startsWith('.') && segments[0] !== TEMPLATES_DIR) return 'diagram';
  return undefined;
}

/**
 * Core's message for one file of the 1.9 pre-release's tree
 * ({@link legacyDbmlShapeOf}): core has no listing, so it names the file and
 * points at `doctor`, whose project-wide message lists the steps.
 */
export function legacyDbmlFileMessage(rel: string): string {
  return `${rel} was written by an ERD Studio 1.9 pre-release, whose folder layout 2.0 does not read. `
    + 'Run erd-studio doctor in the project for the steps to convert it again.';
}

// ---------------------------------------------------------------------------
// Posix path helpers (core may not import node:path)
// ---------------------------------------------------------------------------

/**
 * `path` with `.` segments, empty segments and `x/..` pairs removed. A
 * leading `/` is kept; a relative path keeps the `..` it cannot resolve
 * (`../a`). The empty path is `.`.
 */
export function normalisePosix(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(segment);
  }
  const joined = out.join('/');
  if (absolute) return `/${joined}`;
  return joined === '' ? '.' : joined;
}

/** The parts joined with `/` and normalised. */
export function joinPosix(...parts: string[]): string {
  return normalisePosix(parts.filter((p) => p !== '').join('/'));
}

/** The directory of `path`: `a/b/c.dbml` → `a/b`, `c.dbml` → `.`, `/c` → `/`. */
export function dirnamePosix(path: string): string {
  const normalised = normalisePosix(path);
  const slash = normalised.lastIndexOf('/');
  if (slash < 0) return '.';
  return slash === 0 ? '/' : normalised.slice(0, slash);
}

/** `rel` resolved against the directory `base`: `resolvePosix('a/b', '../c')` → `a/c`. An absolute `rel` is returned normalised. */
export function resolvePosix(base: string, rel: string): string {
  return rel.startsWith('/') ? normalisePosix(rel) : joinPosix(base, rel);
}

/**
 * The relative path from the directory `from` to `to`, both relative to the
 * same root or both absolute: `relativePosix('gold', 'tables/gold/x.dbml')` →
 * `../tables/gold/x.dbml`. The same path gives `.`.
 */
export function relativePosix(from: string, to: string): string {
  const a = normalisePosix(from).split('/').filter((s) => s !== '' && s !== '.');
  const b = normalisePosix(to).split('/').filter((s) => s !== '' && s !== '.');
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const up = a.slice(common).map(() => '..');
  const rest = [...up, ...b.slice(common)];
  return rest.length === 0 ? '.' : rest.join('/');
}

/**
 * Whether `child` is `parent` or inside it, after normalising both (so
 * `a/../b` is not inside `a`). Paths are compared exactly, by segment.
 */
export function isInsidePosix(parent: string, child: string): boolean {
  const p = normalisePosix(parent);
  const c = normalisePosix(child);
  if (p === '.') return !(c === '..' || c.startsWith('../') || c.startsWith('/'));
  if (p === c) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}
