/**
 * `doctor`'s `erd.dbmlProblems` (native DBML storage, §7.1): every problem
 * in the project's `.dbml` files, each with a fixed
 * severity. Errors are what breaks a file for ERD Studio or for every other
 * DBML tool (doctor raises `fix-dbml-file`, `resolve-merge-conflicts` or
 * `resolve-format-conflicts` for them); warnings never raise a next step, so
 * an assistant's "run doctor until clean" loop ends.
 *
 * Built from the bundled parser's multi-file compile (every diagram with its
 * imports, each relationships file and each table file on its own, under
 * core's virtual root; run file by file through `compileDbmlFilesSeparately`,
 * which reports exactly what one whole-project compile does), the readers'
 * own problems, the library attachment (orphaned and duplicate Refs), the
 * relationships index (which files each diagram should import) and ERD
 * Studio's own checks of the layer-first tree (files outside its folders, a
 * layer missing from layers.json, a table name declared twice, a project
 * still in the 1.9 pre-release's tree).
 * Where a line is missing or wrong, the message carries the exact line to
 * write. Reads only; never throws for a file it cannot read.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  DBML_DIAGRAM_QUOTE_HINT_CODES,
  DBML_QUOTE_HINT,
  DBML_TABLE_QUOTE_HINT_CODES,
  DIAGRAMS_DIR,
  LOGICAL_MODELS_DIR,
  NON_SUBJECT_AREA_DIRS,
  RELATIONSHIPS_DIR,
  SEMANTIC_README_NAME,
  TABLES_DIR,
  findConflictMarkers,
  isDbmlLayerName,
  isReservedLayerName,
  parseTableText,
} from '@erd-studio/core';
import type { DbmlFileOutline, ProjectStorage, Relationship, SemanticFileClass } from '@erd-studio/core';
import { erdLayoutEntrySpan, outlineDbmlFile, parseSubjectAreaDbml, parseTableDbml, readErdLayoutDbml, usePathBetween } from '@erd-studio/core/dbml';
import { listMisnamedTableFiles } from '../services/dbmlConversionFiles';
import { compileDbmlFilesSeparately } from '../services/dbmlFileCompile';
import { relationshipsIndexOf } from '../services/dbmlLibraryWrites';
import { relationshipsImportsFor } from '../services/dbmlRelationshipsIndex';
import type { RelationshipsIndex } from '../services/dbmlRelationshipsIndex';
import { unimportedRelationshipsMessage } from '../services/domainService';
import { detectLegacyDbmlTree, legacyDbmlTreeMessage } from '../services/legacyDbmlTree';
import { tablesDirIsLayer } from '../services/logicalModelService';
import { listSemanticFiles } from '../services/semanticFiles';
import type { CliContext } from './context';
import { unreadableHint } from './diff';

/** One problem in a DBML file. */
export interface DbmlProblemEntry {
  /** Project-relative, forward slashes: the file, or the folder for a project-wide check. */
  file: string;
  /** 1-based, when the problem is at a line. */
  line?: number;
  /** 1-based, when the parser said. */
  column?: number;
  /** The parser's numeric code, or ERD Studio's own name (`missingUse`, `duplicateTableName`, …). */
  code: number | string;
  severity: 'error' | 'warning';
  message: string;
  /** The file holds git conflict markers: show the user, never pick a side (routed to `resolve-merge-conflicts`). */
  mergeConflict?: true;
}

/** Codes routed to their own next step, never to `fix-dbml-file`. */
export const FORMAT_CONFLICT_CODE = 'formatConflict';
/** A project still in the 1.9 pre-release's tree (§1.8): one error, routed to `reconvert-dbml-project`. */
export const LEGACY_DBML_TREE_CODE = 'legacyDbmlTree';

/** The severity of each of ERD Studio's own checks (§7.1's table); a parser diagnostic is always an error. */
const SEVERITY: Readonly<Record<string, 'error' | 'warning'>> = {
  unquotedValue: 'warning',
  metaJson: 'warning',
  mergeConflict: 'error',
  inlineRefInTableFile: 'error',
  useInTableFile: 'error',
  refInTableFile: 'error',
  duplicateEnum: 'warning',
  duplicateRef: 'error',
  missingUse: 'warning',
  missingRelationshipsUse: 'warning',
  // A diagram imports a relationships file holding no relationship between its tables (§2.4).
  extraRelationshipsUse: 'warning',
  orphanedRef: 'warning',
  danglingRef: 'warning',
  unreadableRef: 'warning',
  usePathMismatch: 'warning',
  nameCaseDrift: 'warning',
  pathWithSpace: 'warning',
  [FORMAT_CONFLICT_CODE]: 'error',
  // §1.8: the 1.9 pre-release's tree, once per project; it silences every per-file check of its files.
  [LEGACY_DBML_TREE_CODE]: 'error',
  missingLayersConfig: 'warning',
  // §1.1: a .dbml where the tree has no place for it (with a hint for its shape).
  dbmlOutsideKnownFolders: 'warning',
  // §1.1: a layer folder holding tables or relationships that layers.json does not list.
  dbmlLayerNotConfigured: 'warning',
  // §1.1: a file of no kind ERD Studio knows, in a DBML or mixed project.
  unexpectedFileInDbmlFolder: 'warning',
  // §1.1: two table files of one name (two layers, or two schema folders).
  duplicateTableName: 'error',
  // §1.3: a Table, Enum or other element in a relationships file.
  relationshipsFileHoldsOther: 'warning',
  // §1.2: the table reader's schema checks.
  schemaFolderMismatch: 'warning',
  unqualifiedTable: 'warning',
  schemaProperty: 'warning',
  dbmlDiagramInYamlProject: 'warning',
  declaredInDiagram: 'warning',
  declaresOwnTables: 'warning',
  yamlTableInDbmlDiagram: 'warning',
  diagramWarning: 'warning',
  // D25: a Metadata block in a diagram or relationships file that sets a table's properties from outside its file.
  foreignMetadata: 'warning',
  // D26: a diagram member with no .dbml table file (erd_unlinked_tables).
  unlinkedTable: 'warning',
  // D27: a pending relationship (`// erd-studio pending: Ref …`).
  pendingRelationship: 'warning',
  // D25: a Metadata block naming a table or column the file does not declare.
  'structure:metadataTarget': 'warning',
  // §1.6: a diagram's erd_layout (positions).
  layoutBadLine: 'warning',
  layoutDuplicateKey: 'warning',
  layoutBadValue: 'error',
  layoutMergeConflict: 'error',
};

/** D25's table-read code: a Metadata block whose target the file does not declare. */
const METADATA_TARGET_CODE = 'structure:metadataTarget';

/** A `.dbml` file of the project, classified. */
interface ProjectFile {
  /** Posix, relative to the semantic dir. */
  rel: string;
  abs: string;
  text: string;
  kind: 'table' | 'relationships' | 'diagram' | 'other';
  cls: SemanticFileClass;
}

function readText(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/**
 * Every `.dbml` file under the semantic dir, as `listSemanticFiles` lists and
 * classifies them (the one walk Convert uses too), less the files `skip`
 * names (a 1.9 tree's, reported once as a whole).
 */
function projectFiles(semanticRoot: string, listing: ReadonlyArray<{ rel: string; cls: SemanticFileClass }>, skip: ReadonlySet<string>): ProjectFile[] {
  const out: ProjectFile[] = [];
  for (const { rel, cls } of listing) {
    if (!/\.dbml$/i.test(rel) || skip.has(rel)) continue;
    const abs = path.join(semanticRoot, ...rel.split('/'));
    const text = readText(abs);
    if (text === null) continue;
    const kind = cls.kind === 'table' ? (cls.storage === 'dbml' ? 'table' : 'other')
      : cls.kind === 'relationships' || cls.kind === 'diagram' ? cls.kind : 'other';
    out.push({ rel, abs, text, kind, cls });
  }
  return out;
}

/** The root files a DBML project may hold besides the model (`README.md` and `layers.json` classify as theirs). */
const ALLOWED_ROOT_FILES: ReadonlySet<string> = new Set(['modelling-approach.md']);

/**
 * Where a `.dbml` the tree has no place for belongs (§1.1): the hint
 * `dbmlOutsideKnownFolders` gives, by the shape of its path. The fixed names
 * are compared exactly, as the classifier compares them.
 */
export function outsideKnownFoldersHint(rel: string): string {
  const segments = rel.split('/');
  const file = segments[segments.length - 1];
  if (!file.endsWith('.dbml')) return `rename it to ${file.replace(/\.dbml$/i, '.dbml')}: the extension is lower-case`;
  if (segments.length === 1) return `a diagram belongs at <layer>/${DIAGRAMS_DIR}/${file}, a table at <layer>/${TABLES_DIR}/<schema>/${file}`;
  const top = segments[0];
  if (!isDbmlLayerName(top)) {
    const lower = top.toLowerCase();
    if (lower !== top && isDbmlLayerName(lower)) return `layer folders are lower-case ids; rename ${top}/ to ${lower}/ and set its label in layers.json`;
    if (top === LOGICAL_MODELS_DIR) return `the folder ${LOGICAL_MODELS_DIR}/ holds YAML tables only; a DBML table belongs at <layer>/${TABLES_DIR}/<schema>/${file}`;
    if (isReservedLayerName(top) || NON_SUBJECT_AREA_DIRS.has(lower)) {
      return `the folder ${top}/ cannot be a layer: ERD Studio reserves the name ${lower}. A diagram belongs at <layer>/${DIAGRAMS_DIR}/${file}, a table at <layer>/${TABLES_DIR}/<schema>/${file}`;
    }
    return `the folder ${top}/ is not a valid layer name: a layer folder is a lower-case id (a letter, then letters, digits, - or _)`;
  }
  if (segments.length === 2) return `a diagram belongs at ${top}/${DIAGRAMS_DIR}/${file}`;
  const second = segments[1];
  const fixed = [DIAGRAMS_DIR, TABLES_DIR, RELATIONSHIPS_DIR].find((name) => name !== second && name === second.toLowerCase());
  if (fixed !== undefined) return `rename the folder to ${fixed} (lower-case)`;
  if (second === RELATIONSHIPS_DIR) return `relationships files are flat in ${top}/${RELATIONSHIPS_DIR}/`;
  if (second === DIAGRAMS_DIR) return `diagrams are flat in ${top}/${DIAGRAMS_DIR}/`;
  if (second === TABLES_DIR) {
    return segments.length === 3
      ? `a table belongs in a schema folder: ${top}/${TABLES_DIR}/<schema>/${file}`
      : `a table belongs at ${top}/${TABLES_DIR}/<schema>/${file}, one schema folder deep`;
  }
  return `a diagram belongs at ${top}/${DIAGRAMS_DIR}/${file}, a relationships file at ${top}/${RELATIONSHIPS_DIR}/${file}, a table at ${top}/${TABLES_DIR}/<schema>/${file}`;
}

/**
 * `dbmlOutsideKnownFolders`' message for `rel` (relative to the semantic dir).
 * Every hint starts with a word, never a folder name, so capitalising it never
 * misspells a folder (case matters in the tree, §1.1).
 */
function outsideKnownFoldersMessage(rel: string): string {
  const hint = outsideKnownFoldersHint(rel);
  return `ERD Studio does not read this file: it is outside the folders of a DBML project. ${hint[0].toUpperCase()}${hint.slice(1)}.`;
}

const stemOf = (rel: string): string => path.posix.basename(rel).replace(/\.dbml$/i, '');

/**
 * The first line of git conflict markers in `f` that is not inside a
 * diagram's `erd_layout` (§1.6): the value's span is blanked (its line
 * breaks kept) before the search, since markers there only mean positions
 * differ, and the reader reports them (`layoutMergeConflict`). A diagram
 * that does not parse is searched whole.
 */
function conflictOutsideLayout(f: ProjectFile): number | null {
  const line = findConflictMarkers(f.text);
  if (line === null || f.kind !== 'diagram') return line;
  const span = erdLayoutEntrySpan(f.text);
  if (span === null || span.end <= span.start) return line;
  const blanked = f.text.slice(0, span.start) + f.text.slice(span.start, span.end).replace(/[^\r\n]/g, '') + f.text.slice(span.end);
  return findConflictMarkers(blanked);
}

/**
 * Every DBML problem of the project, in file order (project-wide checks
 * first). `storage` is the project's storage (`projectStorageOf`).
 */
export function collectDbmlProblems(ctx: CliContext, storage: ProjectStorage): DbmlProblemEntry[] {
  const semanticRoot = path.join(ctx.root, ctx.semanticDir);
  if (!fs.existsSync(semanticRoot)) return [];
  const projectRel = (rel: string): string => `${ctx.semanticDir.replace(/\\/g, '/').replace(/\/+$/, '')}/${rel}`;
  const problems: DbmlProblemEntry[] = [];
  const seen = new Set<string>();
  const push = (p: Omit<DbmlProblemEntry, 'severity'> & { severity?: DbmlProblemEntry['severity'] }): void => {
    const severity = p.severity ?? (typeof p.code === 'number' ? 'error' : SEVERITY[p.code] ?? 'warning');
    const key = `${p.file}\u0000${p.line ?? ''}\u0000${p.code}\u0000${p.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ ...p, severity });
  };
  const lib = ctx.tableLibraryService;
  const listing = listSemanticFiles(semanticRoot, { tablesDirIsLayer: tablesDirIsLayer(semanticRoot) });
  // A 1.9 pre-release tree (§1.8): one error for the project, and nothing about each of its files.
  const legacy = detectLegacyDbmlTree(semanticRoot);
  const legacyFiles = new Set(legacy?.files ?? []);
  const files = projectFiles(semanticRoot, listing, legacyFiles);
  const dbmlFiles = files.filter((f) => f.rel.toLowerCase().endsWith('.dbml'));
  const library = files.filter((f) => f.kind === 'table' || f.kind === 'relationships');

  // ── Project-wide checks ────────────────────────────────────────────────
  if (legacy) {
    push({ file: ctx.semanticDir, code: LEGACY_DBML_TREE_CODE, message: legacyDbmlTreeMessage(legacy) });
  }
  if (dbmlFiles.length > 0) {
    const spaced = /\s/.test(path.resolve(semanticRoot)) || dbmlFiles.some((f) => /\s/.test(f.rel));
    if (spaced) {
      push({
        file: ctx.semanticDir, code: 'pathWithSpace',
        message: 'A folder or file name in this project\'s path has a space. DBML 10.x drops imported tables when a folder in the path has a space; '
          + '9.1 and 11+ do not. ERD Studio is not affected.',
      });
    }
  }
  if (library.length > 0 && !fs.existsSync(path.join(semanticRoot, 'layers.json'))) {
    push({
      file: ctx.semanticDir, code: 'missingLayersConfig',
      message: `This project has a DBML table library but no ${ctx.semanticDir}/layers.json, so ERD Studio uses its built-in silver and gold layers. `
        + 'Write the file with one entry per layer folder, as the schema skill\'s "Layout" shows.',
    });
  }
  for (const conflict of formatConflicts(ctx)) push(conflict);
  for (const stray of treeShapeProblems(ctx, listing, legacyFiles, storage, projectRel)) push(stray);

  // ── Conflict markers: the user's to resolve; nothing else is said about the file ──
  const conflicted = new Set<string>();
  for (const f of files) {
    if (f.kind === 'other') continue;
    const line = conflictOutsideLayout(f);
    if (line === null) continue;
    conflicted.add(f.rel);
    push({
      file: projectRel(f.rel), line, code: 'mergeConflict', mergeConflict: true,
      message: 'unresolved git merge conflict: git left two versions here. Show the user the file and line and ask which side to keep '
        + "(don't pick a side or run git commands yourself)."
        + (f.kind === 'relationships' ? ' In a relationships file, keeping both sides\' Ref lines and both sides\' use lines is usually right; doctor then reports a Ref that appears twice.' : ''),
    });
  }

  // ── The parser, as every other DBML tool reads the project ──────────────
  const sources: Record<string, string> = {};
  for (const f of dbmlFiles) sources[f.rel] = f.text;
  const entries = dbmlFiles.filter((f) => f.kind !== 'other').map((f) => f.rel);
  let diagnostics: Record<string, Array<{ code: number; message: string; line: number; column: number }>> = {};
  try {
    // The whole-project compile's diagnostics, file by file: @dbml/parse 11
    // resolves each Ref against every file of one multi-file layout, which
    // took most of doctor's time on a large library (9 s at 1,100 tables);
    // this is the same answer in linear time (Convert's self-check uses it too).
    diagnostics = compileDbmlFilesSeparately(sources, entries);
  } catch {
    diagnostics = {};
  }
  const kindOf = new Map(files.map((f) => [f.rel, f.kind]));
  // In the project's file order, whatever order the compile keyed its result in.
  const entrySet = new Set(entries);
  const diagnosed = [...entries, ...Object.keys(diagnostics).filter((rel) => !entrySet.has(rel))];
  for (const rel of diagnosed) {
    const list = diagnostics[rel] ?? [];
    if (conflicted.has(rel)) continue;
    const kind = kindOf.get(rel);
    for (const d of list) {
      const hint = (kind === 'table' && DBML_TABLE_QUOTE_HINT_CODES.has(String(d.code)))
        || (kind === 'diagram' && DBML_DIAGRAM_QUOTE_HINT_CODES.has(String(d.code)))
        ? ` ${DBML_QUOTE_HINT}` : '';
      // Paths in parser messages are under the compile's virtual root: show them relative to the semantic dir.
      const message = d.message.split('/erd-studio/').join('');
      push({ file: projectRel(rel), line: d.line, column: d.column, code: d.code, message: `${message}${hint && !/[.!?]$/.test(message) ? '.' : ''}${hint}` });
    }
  }

  // ── Table files ──────────────────────────────────────────────────────────
  /** Each table file that reads (relative to the semantic dir) → its table's name and declared reference. */
  const declaredAt = new Map<string, { name: string; reference: string }>();
  const metadataTargetFiles = new Set<string>();
  const enumHomes = new Map<string, Array<{ rel: string; line: number; name: string }>>();
  const outlines = new Map<string, DbmlFileOutline>();
  const outline = (f: ProjectFile): DbmlFileOutline => {
    let o = outlines.get(f.rel);
    if (!o) {
      try {
        o = outlineDbmlFile(f.text, f.rel);
      } catch {
        o = { parses: false, uses: [], enums: [], metadata: [] };
      }
      outlines.set(f.rel, o);
    }
    return o;
  };
  for (const f of files) {
    if (f.kind !== 'table' || conflicted.has(f.rel)) continue;
    const stem = stemOf(f.rel);
    let reading: ReturnType<typeof parseTableDbml> | null = null;
    try {
      // The schema folder, so the reader's §1.2 checks run (schemaFolderMismatch, unqualifiedTable, schemaProperty).
      reading = parseTableDbml(f.text, stem, f.cls.schema !== undefined ? { schemaFolder: f.cls.schema } : {});
    } catch {
      reading = null;
    }
    if (reading && reading.ok) {
      declaredAt.set(f.rel, { name: reading.table.name, reference: reading.declaredReference });
      for (const p of reading.problems) {
        const code = p.code ?? 'tableWarning';
        push({ file: projectRel(f.rel), ...(p.line !== undefined ? { line: p.line } : {}), ...(p.column !== undefined ? { column: p.column } : {}), code, message: p.message });
      }
      if (reading.declaredName !== stem && reading.declaredName.toLowerCase() === stem.toLowerCase()) {
        push({
          file: projectRel(f.rel), code: 'nameCaseDrift',
          message: `The file is named ${stem}.dbml but declares Table ${reading.declaredName}. It reads everywhere, but rename the file to match `
            + `(git mv ${f.rel} ${path.posix.join(path.posix.dirname(f.rel), `${reading.declaredName}.dbml`)}).`,
        });
      }
    } else if (reading && !reading.ok) {
      const err = reading.error;
      const code = String(err.code ?? err.kind);
      if (code === METADATA_TARGET_CODE) {
        // D25: a warning, with the reader's own precise text (it already says to rename or remove the block);
        // the parser's raw [4000] for the same block is dropped below.
        metadataTargetFiles.add(projectRel(f.rel));
        push({
          file: projectRel(f.rel), ...(err.line !== undefined ? { line: err.line } : {}), code,
          message: /[.!?]$/.test(err.message) ? err.message : `${err.message}.`,
        });
      } else if (!/^\d+$/.test(code)) {
        // A parser error is already reported by the compile above, with its line. Any other reason the
        // table does not read (an empty file, two Tables, a name that is not its file's) is an error:
        // ERD Studio cannot read the table.
        push({
          file: projectRel(f.rel), ...(err.line !== undefined ? { line: err.line } : {}), code, severity: 'error',
          message: `${err.message} (${unreadableHint({ kind: err.kind, line: err.line, code: err.code })})`,
        });
      }
    }
    for (const e of outline(f).enums) {
      const key = e.name.toLowerCase();
      enumHomes.set(key, [...(enumHomes.get(key) ?? []), { rel: f.rel, line: e.line, name: e.name }]);
    }
  }
  for (const homes of enumHomes.values()) {
    if (homes.length < 2) continue;
    for (const h of homes) {
      push({
        file: projectRel(h.rel), line: h.line, code: 'duplicateEnum',
        message: `Enum ${h.name} is also declared in ${homes.filter((o) => o !== h).map((o) => o.rel).join(', ')}. ERD Studio's selective use lines `
          + '(use { table x } from …) never import Enums, but a hand-written use * of both files fails with [3003]: rename one Enum, or use selective lines.',
      });
    }
  }

  // ── Relationships files and the library attachment ─────────────────────
  let snapshot: ReturnType<typeof lib.dbmlSnapshot> | null = null;
  try {
    snapshot = lib.dbmlSnapshot();
  } catch {
    snapshot = null;
  }
  const tableOf = (name: string): { name: string; reference: string; path: string; storage: 'yaml' | 'dbml'; columns: string[] } | undefined => {
    if (!snapshot) return undefined;
    const lower = name.toLowerCase();
    const direct = snapshot.tables.get(lower);
    if (direct) return direct;
    for (const t of snapshot.tables.values()) if (t.dbmlAlias !== undefined && t.dbmlAlias.toLowerCase() === lower) return t;
    return undefined;
  };
  /**
   * A diagram member's table: by name, else the YAML file the loader probes for it (its file stem), which
   * may hold another name (a `name:` that differs from the filename, left as YAML by Convert).
   */
  const memberTableOf = (name: string): ReturnType<typeof tableOf> => {
    const byName = tableOf(name);
    if (byName || !snapshot) return byName;
    const lower = name.toLowerCase();
    for (const t of snapshot.tables.values()) {
      if (t.storage === 'yaml' && t.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, '').toLowerCase() === lower) return t;
    }
    return undefined;
  };
  /**
   * Why a member's YAML file is not a table, or undefined when it is one (or does not read: its own error
   * says why). An empty file, or one with no name: key (a dbt schema file, say), is never read as a table,
   * so the member is drawn as missing — as Convert's plan says of the file.
   */
  const notATable = (t: { path: string; storage: 'yaml' | 'dbml' }): string | undefined => {
    if (t.storage !== 'yaml' || !snapshot) return undefined;
    const text = snapshot.readText(t.path);
    if (text === null) return undefined;
    if (text.split(/\r?\n/).every((line) => /^\s*(#.*)?$/.test(line))) return 'is empty';
    try {
      return parseTableText(text, t.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, '')) === null ? 'has no name: key' : undefined;
    } catch {
      return undefined;
    }
  };
  /** A member's table file that ERD Studio never lists because it is named `.yaml` or `.YML` (Convert leaves it, saying so). */
  const misnamed = listMisnamedTableFiles(semanticRoot);
  const misnamedOf = (name: string): { path: string; file: string; stem: string; caseOnly: boolean } | undefined => {
    const lower = name.toLowerCase();
    const m = misnamed.find((x) => x.name.toLowerCase() === lower || x.path.replace(/^.*\//, '').replace(/\.ya?ml$/i, '').toLowerCase() === lower);
    if (!m) return undefined;
    const file = m.path.replace(/^.*\//, '');
    const stem = file.replace(/\.ya?ml$/i, '');
    // The name to give it: its table's (what the loader probes and a DBML table file must have), its own stem when they agree.
    return { path: m.path, file, stem: stem.toLowerCase() === m.name.toLowerCase() ? stem : m.name, caseOnly: file.toLowerCase().endsWith('.yml') };
  };
  /** How a member's YAML table is named in a message: its own name, or the member with the name its file holds. */
  const yamlTableLabel = (name: string, t: { name: string; path: string }): string =>
    t.name.toLowerCase() === name.toLowerCase() ? `${t.name} is still a YAML table (${t.path})` : `${name} is still a YAML table (${t.path}, which holds the table ${t.name})`;
  // Whether a table's file reads (a file that reads with a repeated YAML key counts: it loads).
  const readsCleanly = (t: { name: string }): boolean => {
    try {
      const err = lib.getTableFileError(t.name);
      return !err || err.readable === true;
    } catch {
      return false;
    }
  };
  /**
   * A pending relationship (D27): drawn by ERD Studio, a comment to every other DBML tool. Says what it
   * waits for, or that both ends are ready and the next write (or Convert) makes it a live Ref.
   */
  const pushPending = (rel: string, ref: { line: number; relationships: Relationship[] }): void => {
    const head = ref.relationships[0];
    if (!head) return;
    const cols = (cs: string[]): string => (cs.length === 1 ? cs[0] : `(${cs.join(', ')})`);
    const link = `${head.fromModel}.${cols(ref.relationships.map((r) => r.fromColumn))} → ${head.toModel}.${cols(ref.relationships.map((r) => r.toColumn))}`;
    const waits = [
      ...[head.fromModel, head.toModel].filter((n, i, all) => all.indexOf(n) === i).flatMap((name) => {
        const t = memberTableOf(name);
        const wrongName = t ? undefined : misnamedOf(name);
        if (wrongName) return [`${name}'s file ${wrongName.path} is not named .yml, so ERD Studio does not read it as a table yet`];
        if (!t) return [`${name} has no table file`];
        const notTable = notATable(t);
        if (notTable) return [`${name}'s file ${t.path} ${notTable}, so it is not a table yet`];
        if (t.storage === 'yaml') return [yamlTableLabel(name, t)];
        return [];
      }),
      ...ref.relationships.flatMap((r) => [[head.fromModel, r.fromColumn], [head.toModel, r.toColumn]] as const)
        .filter(([table, column]) => {
          const t = tableOf(table);
          return t !== undefined && t.storage === 'dbml' && !t.columns.some((c) => c.toLowerCase() === column.toLowerCase());
        })
        .map(([table, column]) => `${tableOf(table)!.name} has no column ${column}`),
    ];
    // "Add from dbt" only helps a table with no file; a YAML one is finished by Convert.
    const how = [
      ...(waits.some((w) => w.endsWith('has no table file')) ? ['Add from dbt makes a missing table'] : []),
      ...(waits.some((w) => w.endsWith('so it is not a table yet')) ? ['write the table in that file, then run Convert Project to DBML'] : []),
      ...(waits.some((w) => w.endsWith('does not read it as a table yet')) ? ['rename that file to .yml, then run Convert Project to DBML'] : []),
      ...(waits.some((w) => w.includes('is still a YAML table')) ? ['Convert Project to DBML converts a YAML table once its file is fixed'] : []),
    ];
    push({
      file: projectRel(rel), line: ref.line, code: 'pendingRelationship',
      message: waits.length > 0
        ? `The pending relationship ${link} is drawn by ERD Studio, but other DBML tools see only a comment: ${[...new Set(waits)].join('; ')}. `
          + `It becomes a live Ref once both ends have table files with those columns${how.length > 0 ? ` (${how.join('; ')})` : ''}. Keep the line as it is.`
        : `The pending relationship ${link} can be a live Ref now: both ends have table files. Run ERD Studio: Convert Project to DBML to make it one.`,
    });
  };
  /**
   * Relationships file (project-relative) → the tables (lower case) its `missingUse` warnings name, and
   * the schema qualifiers (lower case) its Refs write for them: with no table of that schema imported,
   * the parser says the schema does not exist rather than the table.
   */
  const missingUseTables = new Map<string, { tables: Set<string>; schemas: Set<string> }>();
  for (const f of files) {
    if (f.kind !== 'relationships' || conflicted.has(f.rel)) continue;
    const reading = lib.readRelationshipsFile(f.abs);
    if (!reading) continue;
    for (const p of reading.problems) {
      if (p.mergeConflict) continue;
      // The reader's own copy of a parser diagnostic the compile above already reported at that line.
      if (typeof p.code === 'number' && (diagnostics[f.rel] ?? []).some((d) => d.code === p.code && d.line === p.line)) continue;
      push({ file: projectRel(f.rel), ...(p.line !== undefined ? { line: p.line } : {}), code: p.code ?? 'unreadableRef', message: p.message });
    }
    for (const other of reading.otherElements ?? []) {
      push({
        file: projectRel(f.rel), line: other.line, code: 'relationshipsFileHoldsOther',
        message: `${f.rel} line ${other.line} holds a ${other.kind}; relationships files hold only Refs and use lines, and every diagram importing this file `
          + 'gets it too in other DBML tools. Move it into its own file.',
      });
    }
    if (!reading.readable) continue;
    const o = outline(f);
    // A use line imports a table only as the table declares itself, exactly (other DBML tools match the specifier by case).
    const covered = (table: { reference: string; path: string }): boolean => o.uses.some((u) =>
      u.wildcard ? u.resolved === table.path : (u.specifiers ?? []).includes(table.reference));
    const missing = new Map<string, { line: number; text: string }>();
    const missingSchemas = new Set<string>();
    for (const ref of reading.refs) {
      const ends = [[ref.owner, ref.ownerQualifier], [ref.target, ref.targetQualifier]] as const;
      for (const [end, qualifier] of ends) {
        const t = tableOf(end);
        if (!t || t.storage !== 'dbml' || covered(t)) continue;
        if (qualifier !== undefined) missingSchemas.add(qualifier.replace(/^"(.*)"$/, '$1').toLowerCase());
        if (missing.has(t.name.toLowerCase())) continue;
        missing.set(t.name.toLowerCase(), { line: ref.line, text: `use { table ${t.reference} } from '${usePathBetween(f.rel, t.path)}'` });
      }
      const owner = tableOf(ref.owner);
      const target = tableOf(ref.target);
      // A table whose file does not read has no columns to check: that file's own problem is the one to fix.
      if ((owner && !readsCleanly(owner)) || (target && !readsCleanly(target))) continue;
      if (owner && target) {
        const gone = ref.relationships.flatMap((r) => [
          ...(owner.columns.some((c) => c.toLowerCase() === r.fromColumn.toLowerCase()) ? [] : [`${owner.name}.${r.fromColumn}`]),
          ...(target.columns.some((c) => c.toLowerCase() === r.toColumn.toLowerCase()) ? [] : [`${target.name}.${r.toColumn}`]),
        ]);
        if (gone.length > 0) {
          push({
            file: projectRel(f.rel), line: ref.line, code: 'danglingRef',
            // The loader still emits it and the canvas draws every line whose two tables it shows.
            message: `This Ref names ${gone.join(', ')}, which ${gone.length === 1 ? 'is' : 'are'} not a column of ${gone.length === 1 ? 'its' : 'their'} table. `
              + 'ERD Studio still draws the line between the two tables, but it points at a column the table does not have, and other DBML tools reject the file. '
              + 'Fix the column name, or delete the Ref.',
          });
        }
      } else if (owner && !target) {
        push({
          file: projectRel(f.rel), line: ref.line, code: 'danglingRef',
          message: `This Ref points at ${ref.target}, which has no table file; it is not drawn. Add the table, or delete the Ref.`,
        });
      }
    }
    for (const ref of reading.pending ?? []) pushPending(f.rel, ref);
    if (missing.size > 0) missingUseTables.set(projectRel(f.rel), { tables: new Set(missing.keys()), schemas: missingSchemas });
    for (const m of missing.values()) {
      push({
        file: projectRel(f.rel), line: m.line, code: 'missingUse',
        message: `This Ref names a table the file does not import. Add the line: ${m.text} (ERD Studio reads the Ref anyway and adds the line on its next write to it; other DBML tools fail without it).`,
      });
    }
  }
  let attachment: ReturnType<typeof lib.libraryAttachment>;
  try {
    attachment = lib.libraryAttachment();
  } catch {
    attachment = undefined;
  }
  const libraryRel = (p: string): string => p.replace(/\\/g, '/');
  for (const o of attachment?.orphaned ?? []) {
    const owner = tableOf(o.owner);
    // A DBML owner is orphaned only while its table file does not read: that file's own problem says what to fix.
    if (owner && (owner.storage !== 'yaml' || !readsCleanly(owner))) continue;
    push({
      file: projectRel(libraryRel(o.path)), line: o.line, code: 'orphanedRef',
      message: owner
        ? `This Ref's foreign-key end is ${o.owner}, a YAML table, which keeps its relationships in its own file; it is not drawn from here. Move it into ${owner.path}, or convert the project to DBML.`
        : `This Ref's foreign-key end is ${o.owner}, which has no table file; it is not drawn. Add the table, or delete the Ref.`,
    });
  }
  for (const d of attachment?.duplicates ?? []) {
    push({
      file: projectRel(libraryRel(d.dropped.path)), line: d.dropped.line, code: 'duplicateRef',
      message: `The relationship ${d.link} is also stored at ${libraryRel(d.kept.path)} line ${d.kept.line}. Every DBML tool fails a project with the same Ref twice ([5001]); delete one of them.`,
    });
  }

  // ── Metadata blocks outside a table's own file (D25) ─────────────────────
  // ERD Studio reads and edits a table's properties only in its table file;
  // another DBML tool applies such a block over them, so the two disagree.
  /**
   * `file\0line` of every block reported here, or skipped because the file
   * declares its target Table itself, so a diagram's reader note on it is not repeated.
   */
  const foreignMetadataLines = new Set<string>();
  for (const f of files) {
    if ((f.kind !== 'diagram' && f.kind !== 'relationships') || conflicted.has(f.rel)) continue;
    const o = outline(f);
    const ownTables = new Set((o.tables ?? []).map((n) => n.toLowerCase()));
    for (const m of o.metadata ?? []) {
      foreignMetadataLines.add(`${f.rel}\0${m.line}`);
      // A block on a Table this file declares is inside that table's file (a
      // single-file DBML, reported as declaresOwnTables / declaredInDiagram).
      if (ownTables.has(m.table.toLowerCase())) continue;
      const t = tableOf(m.table);
      const target = `${t?.name ?? m.table}${m.column !== undefined ? `.${m.column}` : ''}`;
      const ignored = 'ERD Studio reads and edits a table\'s properties only in its table file, so the canvas does not show these values, while other DBML tools apply them. ';
      const message = !t
        ? snapshot
          ? `This Metadata block sets properties of ${target}, which has no table file; it is not read. Add the table, or remove the block.`
          : `This Metadata block sets properties of ${target} from outside its table file. ${ignored}Move them into its table file as inline settings, and remove the block.`
        : t.storage === 'yaml'
          ? `This Metadata block sets properties of ${target} from outside its table file (${t.path}). ${ignored}`
            + `${t.name} is a YAML table: set them in ${t.path} (or convert the project to DBML and set them in its table file as inline settings), and remove the block.`
          : `This Metadata block sets properties of ${target} from outside its table file (${t.path}). ${ignored}`
            + `Move them into ${t.path} as inline settings, and remove the block.`;
      push({ file: projectRel(f.rel), line: m.line, code: 'foreignMetadata', message });
    }
  }

  // ── Diagrams ────────────────────────────────────────────────────────────
  /** `file\0line` of every use line reported as usePathMismatch. */
  const usePathLines = new Set<string>();
  // The relationships files each diagram should import (§2.4): the one rule the editor and Convert use.
  let index: RelationshipsIndex | null = null;
  try {
    index = snapshot ? relationshipsIndexOf(snapshot) : null;
  } catch {
    index = null;
  }
  const listedKinds = new Map(listing.map((e) => [e.rel, e.cls.kind]));
  // The stray .dbml files treeShapeProblems reports on themselves (dbmlOutsideKnownFolders).
  const reportedStray = new Set(storage === 'yaml' ? [] : files.filter((f) => f.cls.kind === 'other').map((f) => f.rel));
  for (const f of files) {
    if (f.kind !== 'diagram' || conflicted.has(f.rel)) continue;
    if (storage === 'yaml') {
      push({
        file: projectRel(f.rel), code: 'dbmlDiagramInYamlProject',
        message: 'This project stores its tables as YAML, so this DBML diagram cannot hold them: a DBML diagram lists only DBML tables. '
          + 'Convert the project to DBML (ERD Studio: Convert Project to DBML), or use a .json diagram.',
      });
    }
    let reading: ReturnType<typeof parseSubjectAreaDbml> | null = null;
    try {
      reading = parseSubjectAreaDbml(f.text, f.rel);
    } catch {
      reading = null; // a load error: the compile above names it
    }
    if (!reading) {
      // An erd_layout that is not a string fails the compile in every parser; say what to write instead.
      for (const p of readErdLayoutDbml(f.text)?.problemsAt ?? []) {
        if (p.code !== 'layoutBadValue') continue;
        push({ file: projectRel(f.rel), ...(p.line !== undefined ? { line: p.line } : {}), code: p.code, message: p.message });
      }
      continue;
    }
    if (reading.holdsOwnTables) {
      push({
        file: projectRel(f.rel), code: 'declaresOwnTables',
        message: 'This file declares its own Tables and imports none from the table library: it is a single-file DBML, not an ERD Studio diagram. '
          + 'Run ERD Studio: Import DBML… on it.',
      });
    }
    // erd_layout (§1.6): its own codes; a conflict there is the user's to resolve (resolve-merge-conflicts).
    const layoutWarnings = new Set<string>();
    for (const p of reading.layoutProblems ?? []) {
      layoutWarnings.add(p.line !== undefined ? `Line ${p.line}: ${p.message}` : p.message);
      push({
        file: projectRel(f.rel), ...(p.line !== undefined ? { line: p.line } : {}), code: String(p.code),
        message: p.code === 'layoutMergeConflict'
          ? `unresolved git merge conflict in erd_layout: only positions differ: keep either side; the diagram still opens, but ERD Studio won't save positions until it is resolved. Show the user the file and line (don't pick a side or run git commands yourself).`
          : p.message,
        ...(p.mergeConflict ? { mergeConflict: true as const } : {}),
      });
    }
    for (const w of reading.warnings) {
      if (layoutWarnings.has(w)) continue;
      const lineMatch = /^Line (\d+): /.exec(w);
      const line = lineMatch ? Number(lineMatch[1]) : undefined;
      if (/\(usePathMismatch\)/.test(w) || /looks like a single-file DBML/.test(w) || /\[\d+\]$/.test(w)) continue;
      const code = /is declared in the diagram file/.test(w) ? 'declaredInDiagram' : 'diagramWarning';
      if (code === 'declaredInDiagram' && reading.holdsOwnTables) continue;
      // A Metadata block is reported once, as foreignMetadata above (or not at all, on a Table the file declares).
      if (line !== undefined && /a Metadata block/.test(w) && foreignMetadataLines.has(`${f.rel}\0${line}`)) continue;
      push({ file: projectRel(f.rel), ...(line !== undefined ? { line } : {}), code, message: w.replace(/^Line \d+: /, '') });
    }
    // Members: each use line must point at the file its name resolves to, and import the table as it declares itself.
    for (const use of reading.uses ?? []) {
      // A use line naming a table file that reads, under that table's name: right (a name in two layers is duplicateTableName's).
      const at = declaredAt.get(use.resolved);
      if (at && at.name.toLowerCase() === use.name.toLowerCase()) {
        const o = outline(f).uses.find((u) => u.line === use.line);
        if (!o || o.wildcard || (o.specifiers ?? []).includes(at.reference)) continue;
        usePathLines.add(`${projectRel(f.rel)}\u0000${use.line}`);
        push({
          file: projectRel(f.rel), line: use.line, code: 'usePathMismatch',
          message: `This use line imports ${at.name} under another spelling than its file declares (Table ${at.reference}). ERD Studio reads the table by name and rewrites the line on its next edit; `
            + `other DBML tools need it as: use { table ${at.reference} } from '${usePathBetween(f.rel, use.resolved)}'`,
        });
        continue;
      }
      const t = tableOf(use.name);
      if (!t) continue;
      if (t.storage === 'yaml') {
        push({
          file: projectRel(f.rel), line: use.line, code: 'yamlTableInDbmlDiagram',
          message: `${t.name} is a YAML table (${t.path}); a DBML diagram can list only DBML tables. Convert the project to DBML (ERD Studio: Convert Project to DBML).`,
        });
        continue;
      }
      const o = outline(f).uses.find((u) => u.line === use.line);
      const specifierOk = !o || o.wildcard || (o.specifiers ?? []).includes(t.reference);
      if (use.resolved !== t.path || !specifierOk) {
        usePathLines.add(`${projectRel(f.rel)}\u0000${use.line}`);
        push({
          file: projectRel(f.rel), line: use.line, code: 'usePathMismatch',
          message: `This use line does not point at ${t.path}, the file of ${t.name}. ERD Studio reads the table by name and rewrites the line on its next edit; `
            + `other DBML tools need it as: use { table ${t.reference} } from '${usePathBetween(f.rel, t.path)}'`,
        });
      }
    }
    // Members with no .dbml table file to use (D26), and the diagram's own pending relationships (D27).
    for (const name of reading.unlinked ?? []) {
      const t = memberTableOf(name);
      const notTable = t ? notATable(t) : undefined;
      const wrongName = t ? undefined : misnamedOf(name);
      push({
        file: projectRel(f.rel), code: 'unlinkedTable',
        message: wrongName
          ? `${name} is on this diagram, but its table file ${wrongName.path} is named ${wrongName.file}, and ERD Studio reads a table file only when its name ends in .yml`
            + (wrongName.caseOnly ? ', in lower case, so only a file system that ignores case finds this one' : `, so it draws ${name} as missing`)
            + ` (its name is in the Project's erd_unlinked_tables). Rename it to ${wrongName.stem}.yml, then run ERD Studio: Convert Project to DBML.`
          : !t
          ? `${name} is on this diagram but has no table file, so it is drawn as missing (its name is in the Project's erd_unlinked_tables). Add it (Add from dbt), or remove it from the diagram.`
          : notTable
            ? `${name} is on this diagram, but its file ${t.path} ${notTable}, so ERD Studio does not read it as a table and draws ${name} as missing (its name is in the Project's erd_unlinked_tables). `
              + `Write the table in that file, then run ERD Studio: Convert Project to DBML; or delete the file and remove ${name} from the diagram.`
          : t.storage === 'yaml'
            ? `${yamlTableLabel(name, t).replace(' is still a YAML table', ' is on this diagram but is still a YAML table')}, so the diagram names it in erd_unlinked_tables instead of a use line. Fix that file if needed, then run ERD Studio: Convert Project to DBML.`
            : `${t.name} has a table file now (${t.path}), but the diagram still names it in erd_unlinked_tables. ERD Studio moves it to a use line on its next edit of this diagram, or run ERD Studio: Convert Project to DBML.`,
      });
    }
    for (const pending of reading.pending ?? []) pushPending(f.rel, pending);
    // Its relationships imports, pair-based (§2.4): a file holding a live Ref between two of its `use` members,
    // or a pending line (D27) between two of the tables it draws (unlinked ones too), and no other. An unlinked
    // member whose table has a .dbml file now counts as a `use` member: the next edit gives it a line (D26).
    if (index) {
      const unlinked = (reading.unlinked ?? []).filter((n) => tableOf(n)?.storage !== 'dbml');
      const linked = reading.members.filter((m) => !unlinked.some((u) => u.toLowerCase() === m.toLowerCase()));
      const want = relationshipsImportsFor({ members: linked, unlinked }, index, { current: reading.relationshipsUses });
      const imported = new Set(reading.relationshipsUses);
      for (const file of want) {
        if (imported.has(file)) continue;
        push({
          file: projectRel(f.rel), code: 'missingRelationshipsUse',
          message: `${unimportedRelationshipsMessage(file)} Add the line: use * from '${usePathBetween(f.rel, file)}'`,
        });
      }
      const wanted = new Set(want);
      for (const file of reading.relationshipsUses) {
        if (wanted.has(file) || !index.files.includes(file) || index.unreadable.has(file)) continue;
        const line = outline(f).uses.find((u) => u.wildcard && u.resolved === file)?.line;
        push({
          file: projectRel(f.rel), ...(line !== undefined ? { line } : {}), code: 'extraRelationshipsUse',
          message: `This diagram imports ${file}, which holds no relationship between its tables, so other DBML tools import whatever else it holds for nothing. `
            + 'ERD Studio removes the line on its next edit of this diagram; or delete it.',
        });
      }
    }
    // A use * that is neither a member nor a relationships import (§1.4 otherUses): reported on the
    // diagram's line, unless the walk above already reports the target file itself (a stray .dbml).
    for (const target of reading.otherUses) {
      if (reportedStray.has(target)) continue;
      const line = outline(f).uses.find((u) => u.wildcard && u.resolved === target)?.line;
      const where = target.startsWith('../')
        ? `which is outside ${ctx.semanticDir}`
        : !listedKinds.has(target)
          ? 'which does not exist'
          : `which is not a relationships file (<layer>/${RELATIONSHIPS_DIR}/<name>.dbml)`;
      push({
        file: projectRel(f.rel), ...(line !== undefined ? { line } : {}), code: 'dbmlOutsideKnownFolders',
        message: `This diagram imports ${target} with use *, ${where}: ERD Studio keeps the line but reads nothing from it, while other DBML tools import all of it.`,
      });
    }
  }
  // The parser's own diagnostics for what ERD Studio's checks above already report with the line to write:
  // a Metadata block's missing target (D25's warning), a use line that misses its file (usePathMismatch) and
  // a Ref naming a table the file does not import (missingUse). Each is a warning (§7.1): ERD Studio reads the
  // file anyway and rewrites the line on its next write, so it is reported once, at that severity.
  return problems.filter((p) => {
    if (typeof p.code !== 'number') return true;
    if (p.code === 4000 && metadataTargetFiles.has(p.file) && /metadata target/i.test(p.message)) return false;
    if ((p.code === 4000 || p.code === 4001) && p.line !== undefined && usePathLines.has(`${p.file}\u0000${p.line}`)) return false;
    const missingHere = missingUseTables.get(p.file);
    if (p.code === 4000 && missingHere) {
      const named = /Table (?:or schema )?'([^']+)' does not exist/i.exec(p.message);
      if (named && missingHere.tables.has(named[1].toLowerCase())) return false;
      const schema = /^Schema '([^']+)' does not exist/i.exec(p.message);
      if (schema && missingHere.schemas.has(schema[1].toLowerCase())) return false;
    }
    return true;
  });
}

/**
 * Tables and diagrams that exist in both formats (`x.yml` and `x.dbml`,
 * `gold/x.json` and `gold/x.dbml`): an error, routed to
 * `resolve-format-conflicts` (§7.1).
 */
function formatConflicts(ctx: CliContext): DbmlProblemEntry[] {
  const out: DbmlProblemEntry[] = [];
  const rel = (abs: string): string => path.relative(ctx.root, abs).split(path.sep).join('/');
  const entries = ctx.tableLibraryService.listTableFiles();
  const byName = new Map<string, typeof entries>();
  for (const e of entries) byName.set(e.name.toLowerCase(), [...(byName.get(e.name.toLowerCase()) ?? []), e]);
  for (const list of byName.values()) {
    if (!list.some((e) => e.storage === 'dbml') || !list.some((e) => e.storage === 'yaml')) continue;
    const files = list.map((e) => rel(e.filePath));
    out.push({
      file: files[0], code: FORMAT_CONFLICT_CODE, severity: 'error',
      message: `${list[0].name} exists as both YAML and DBML (${files.join(', ')}); only ${files[0]} is read. Show the user both files and ask which to keep; don't delete either yourself.`,
    });
  }
  const diagrams = ctx.subjectAreaService.listSubjectAreas(ctx.root, ctx.semanticDir);
  const byStem = new Map<string, typeof diagrams>();
  for (const d of diagrams) {
    const key = `${d.layer}/${path.basename(d.filePath).replace(/\.(json|dbml)$/i, '')}`.toLowerCase();
    byStem.set(key, [...(byStem.get(key) ?? []), d]);
  }
  for (const list of byStem.values()) {
    if (!list.some((d) => d.storage === 'dbml') || !list.some((d) => (d.storage ?? 'json') === 'json')) continue;
    const files = list.map((d) => rel(d.filePath));
    out.push({
      file: files[0], code: FORMAT_CONFLICT_CODE, severity: 'error',
      message: `The diagram ${list[0].domain} exists as both JSON and DBML (${files.join(', ')}). Show the user both files and ask which to keep; don't delete either yourself.`,
    });
  }
  return out;
}

/** Code-unit order (`<`). */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The layer-first tree's own checks (§1.1), from the listing alone: in a
 * DBML or mixed project, a `.dbml` the tree has no place for
 * (`dbmlOutsideKnownFolders`, with a hint for its shape) and any other file
 * of no kind ERD Studio knows (`unexpectedFileInDbmlFolder`); a layer folder
 * holding tables or relationships that layers.json does not list
 * (`dbmlLayerNotConfigured`) and one table name in two table files
 * (`duplicateTableName`). The files of a 1.9 tree (`skip`) are left to its
 * one error.
 */
function treeShapeProblems(
  ctx: CliContext,
  listing: ReadonlyArray<{ rel: string; cls: SemanticFileClass }>,
  skip: ReadonlySet<string>,
  storage: ProjectStorage,
  projectRel: (rel: string) => string,
): Array<Omit<DbmlProblemEntry, 'severity'>> {
  const out: Array<Omit<DbmlProblemEntry, 'severity'>> = [];
  const shown = listing.filter((e) => !skip.has(e.rel));
  for (const { rel, cls } of shown) {
    // A YAML project's stray files are not doctor's business: it reads no .dbml there (the YAML/JSON guard).
    if (cls.kind !== 'other' || storage === 'yaml') continue;
    if (/\.dbml$/i.test(rel)) {
      out.push({ file: projectRel(rel), code: 'dbmlOutsideKnownFolders', message: outsideKnownFoldersMessage(rel) });
    } else if (!ALLOWED_ROOT_FILES.has(rel) && rel.toLowerCase() !== SEMANTIC_README_NAME.toLowerCase()) {
      // A root readme.md in another case is the project README (Convert writes no README.md beside it).

      out.push({
        file: projectRel(rel), code: 'unexpectedFileInDbmlFolder',
        message: `ERD Studio does not read or write this file. A DBML project's ${ctx.semanticDir} holds its tables, relationships files and diagrams, `
          + 'layers.json, templates/, README.md and modelling-approach.md; move the file out if it is not part of the model.',
      });
    }
  }
  const libraryLayers = [...new Set(shown
    .filter((e) => e.cls.layer !== undefined && ((e.cls.kind === 'table' && e.cls.storage === 'dbml') || e.cls.kind === 'relationships'))
    .map((e) => e.cls.layer!))].sort(byteOrder);
  if (libraryLayers.length > 0 && ctx.layerService.configFileExists()) {
    const configured = new Set(ctx.layerService.getValidLayerIds());
    for (const layer of libraryLayers) {
      if (configured.has(layer)) continue;
      out.push({
        file: projectRel(layer), code: 'dbmlLayerNotConfigured',
        message: `${layer}/ is not in layers.json, but its tables and relationships are part of the project. `
          + `Add the layer, or move the folder out of ${ctx.semanticDir} if it is a copy.`,
      });
    }
  }
  const byName = new Map<string, Array<{ rel: string; name: string }>>();
  for (const { rel, cls } of shown) {
    if (cls.kind !== 'table' || cls.storage !== 'dbml' || cls.name === undefined) continue;
    const key = cls.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), { rel, name: cls.name }]);
  }
  for (const copies of byName.values()) {
    for (const copy of copies.slice(1)) {
      out.push({
        file: projectRel(copy.rel), code: 'duplicateTableName',
        message: `${copies[0].name} is declared in ${copies[0].rel} and ${copy.rel}; give the tables unique names and keep the warehouse name in alias.`,
      });
    }
  }
  return out;
}
