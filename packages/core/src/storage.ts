/**
 * Where things live in a semantic dir, for every storage ERD Studio reads:
 * the single file classifier ({@link classifySemanticFile}), the order a
 * table name is looked up in ({@link tableFileCandidates}), the paths that
 * belong together (a table's relationships file, a diagram's layout file),
 * and the posix path helpers core needs because it may not import `node:path`.
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
