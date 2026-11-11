/**
 * SubjectAreaService — reads semantic domain JSON files from disk.
 *
 * Domain files live at {dbt_project}/.erd-studio/{layer}/{domain}.json
 * Each file is a UnifiedSubjectArea containing logical stage data.
 *
 * Physical domains are not stored on disk — they are derived at runtime
 * by projecting a logical domain's model list through the dbt manifest
 * via buildPhysicalSubjectArea().
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SubjectAreaFileError,
  SubjectAreaValidationError,
  NON_SUBJECT_AREA_DIRS,
  DIAGRAMS_DIR,
  buildUnifiedSubjectArea,
  classifySemanticFile,
  dbmlNotADiagramMessage,
  diagramPathOf,
  isDbmlLayerName,
  compositeGroupProblem,
  detectSubjectAreaFormat,
  getRawSubjectAreaTableNames,
  groupKey,
  linkKey,
  parseSubjectAreaJson,
  subjectAreaStorageOf,
  tableNameOf,
  toLogicalStage,
  validateSubjectAreaDocument,
} from '@erd-studio/core';
import { subjectAreaMembersDbml } from '@erd-studio/core/dbml';
import { readDbmlDiagram, rememberedDbmlMembers } from './dbmlDiagramReadings';
import { DiagramMemberTable } from './diagramMemberTable';
import type { DbmlSubjectAreaReading, DbtKeyIndex, DiagramNamedTable, LoaderWarningCode, SubjectAreaFormat } from '@erd-studio/core';
import type { SubjectAreaSummary, SemanticSubjectArea, SemanticTable, UnifiedSubjectArea } from '../types/semantic';
import type { DisplaySubjectArea, DisplayTable, DisplayColumn, DisplayRelationship, PhysicalColumnSource } from '../types/display';
import type { CompositeForeignKey, ManifestData, ManifestModelInfo } from '../types/manifest';
import type { CatalogData, CatalogColumn } from '../types/catalog';
import type { YmlData } from '../types/ymlData';
import type { Cardinality } from '../types/semantic';
import type { LayerService } from './layerService';
import type { TableFileEntry, TableLibraryService } from './logicalModelService';
import { normaliseName } from './nameUtils';
import type { TableId } from '../types/tableId';
import { sameName } from '../types/naming';
import { catalogNodeFor, resolveColumnType } from './columnTypes';
import { log } from './logger';

// The pure domain parsing lives in @erd-studio/core; these are re-exported so
// existing imports of this module keep working.
export { SubjectAreaFileError, NON_SUBJECT_AREA_DIRS } from '@erd-studio/core';
export type { SubjectAreaFileErrorReason } from '@erd-studio/core';

/**
 * Minimal relationship test shape accepted by derivePhysicalRelationships().
 * Both ManifestRelationshipTest and YmlRelationshipTest satisfy this interface.
 */
interface RelationshipTest {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

const DEFAULT_SEMANTIC_DIR = '.erd-studio';

/**
 * Does `fsPath` have the shape of a domain file — `{layer}/{domain}.json`
 * (the parent segment is a layer rather than one of the reserved
 * directories, and neither segment is hidden) or a DBML diagram
 * `{layer}/diagrams/{domain}.dbml` (core's `diagramPathOf`: a DBML layer
 * name, the `diagrams` folder and `.dbml` spelled exactly)?
 *
 * Shape only: it says nothing about whether the layer is configured or the
 * file parses. Callers that know the semantic root should prefer
 * `classifySemanticPath()`, which also proves the path is *under* it; this one
 * exists for the custom editor, which is handed a document whose path the
 * selector has already placed.
 */
export function isSubjectAreaFilePath(fsPath: string): boolean {
  const file = path.basename(fsPath);
  const dir = path.basename(path.dirname(fsPath));
  if (file.endsWith('.dbml')) return diagramPathOf(fsPath) !== undefined;
  return (
    file.endsWith('.json') &&
    !file.startsWith('.') &&
    !dir.startsWith('.') &&
    !NON_SUBJECT_AREA_DIRS.has(dir)
  );
}

/**
 * Core's `dbmlNotADiagramMessage` for `fsPath` (§1.8), shared by the editor's
 * not-a-diagram page and `readDbmlSubjectArea`. Core finds the semantic dir by
 * its default names, so a file inside one with another name (a custom
 * `erdStudio.semanticDir`) is named relative to `semanticRoot`, and a 1.9
 * pre-release shape is still told; any other path is named as given.
 */
export function notADiagramMessage(fsPath: string, semanticRoot: string | undefined): string {
  if (semanticRoot === undefined) return dbmlNotADiagramMessage(fsPath);
  const rel = path.relative(semanticRoot, fsPath);
  const inside = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  const defaultName = ['.erd-studio', 'erd-studio'].includes(path.basename(semanticRoot));
  return dbmlNotADiagramMessage(inside && !defaultName ? rel.split(path.sep).join('/') : fsPath);
}

/**
 * The tables a diagram file names, from its raw text, for the callers that
 * only count or find usage (§5.2): a JSON file's `logical.models` in any
 * format (`getRawSubjectAreaTableNames`), a DBML diagram's table `use` lines
 * (`subjectAreaMembersDbml`, from the AST). Null when the text does not
 * parse. The only raw membership reader, shared by the trees, the commands,
 * the CLI and the MCP server.
 */
export function subjectAreaTableNames(text: string, filePath: string): string[] | null {
  if (subjectAreaStorageOf(filePath) === 'dbml') {
    // A diagram just read (or just dragged) has its members remembered: no parse.
    return rememberedDbmlMembers(text, filePath) ?? subjectAreaMembersDbml(text, filePath);
  }
  try {
    return getRawSubjectAreaTableNames(JSON.parse(text.replace(/^\uFEFF/, '')) as unknown);
  } catch {
    return null;
  }
}

/**
 * Physical column sources, most authoritative first.
 *
 * The warehouse catalog observed what was built; a schema .yml `data_type:` is
 * the author's assertion; the manifest is a compiled copy of that assertion; a
 * bare source file proves only that the model exists. Used to pick the one
 * source a model's `provenance.types` names.
 */
const SOURCE_AUTHORITY: readonly PhysicalColumnSource[] = ['catalog', 'yml', 'manifest', 'file'];

/**
 * Rewrite the `domain` slug in the raw text of a domain file.
 *
 * Operates on the parsed JSON document rather than SubjectAreaService's resolved
 * UnifiedSubjectArea so that v5 model name references, `stubColumns`, and any
 * unknown keys survive byte-for-byte (apart from re-indentation). Used by the
 * Rename Domain command.
 */
export function renameSubjectAreaInRaw(rawText: string, newSlug: string): string {
  const parsed = JSON.parse(rawText) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Diagram file does not contain a JSON object');
  }
  const doc = parsed as Record<string, unknown>;
  // A v6 file names its subject area `subjectArea` (#162, #182); writing
  // `domain` beside it would make a file no version reads.
  doc[detectSubjectAreaFormat(doc) === 'v6' ? 'subjectArea' : 'domain'] = newSlug;
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * What a DBML diagram itself says about its tables (§2.3 display parity):
 * each member's `use` path (semantic-relative, by lower-case name) and the
 * relationships files it imports. The canvas draws only these, as core does.
 */
interface DbmlDiagramView {
  /** Each member's `use` path, by lower-case reference (core's `uses[].ref`: its name, or `<schema>.<name>` for a shared name). */
  memberPaths: ReadonlyMap<string, string>;
  /** The members whose reference is not their name (two members share it): lower-case reference -> name. */
  tableNames: ReadonlyMap<string, string>;
  /** The table folders its `use` lines name, relative to the semantic dir, byte-sorted (core's `useTableDirs`). */
  useTableDirs: readonly string[];
  imports: ReadonlySet<string>;
  /**
   * Its `erd_unlinked_tables` members (D26) the next edit keeps there, lower-case: one whose
   * table has a .dbml file now gains a `use` line on that edit, so it counts as a member.
   */
  unlinked: ReadonlySet<string>;
  /** Filled while reading: the files holding a relationship between two members that the diagram does not import. */
  drift: Set<string>;
  /** Filled while reading: each DBML member's layer, from the file it was read from (by lower-case reference). */
  memberLayers?: Map<string, string>;
  /** The library's table files by resolved path (and lower-cased), and by lower-case name in index order, listed once per diagram read on first use. */
  listing?: { byPath: Map<string, TableFileEntry>; byLowerPath: Map<string, TableFileEntry>; byName: Map<string, TableFileEntry[]> };
  /** The diagram's members (the diagram boundary): each reference with the table file its `use` line reads. */
  members: DiagramMemberTable;
  /**
   * Filled while reading: the table file each DBML member was read from (by
   * lower-case reference), null for one drawn missing. A member's error is
   * that file's, never the library's first file of its name.
   */
  memberFiles: Map<string, string | null>;
  /** Each member's `use` path, resolved and lower-cased, → the lower-case references that name it; built on first use. */
  membersByPath?: Map<string, string[]>;
}

/**
 * A DBML member's relationships, told apart by identity: `ref` is what the
 * diagram calls it, `owner` the table file it was read from (its identity:
 * the library's holders are asked by it), and `diagramRefOf` turns a library
 * reference (a relationship's other end) into the diagram's.
 */
interface MemberRelationshipScope {
  ref: string;
  owner?: TableId;
  /** The diagram reference a relationship end is drawn under; undefined for an end that names no one table (a bare name two schema folders share). */
  diagramRefOf: (libraryRef: string) => string | undefined;
}

/** `view`'s listing of the library's table files, made on first use: one listing per diagram read. */
function listingOf(library: TableLibraryService, view: DbmlDiagramView): NonNullable<DbmlDiagramView['listing']> {
  if (!view.listing) {
    const byPath = new Map<string, TableFileEntry>();
    const byLowerPath = new Map<string, TableFileEntry>();
    const byName = new Map<string, TableFileEntry[]>();
    for (const entry of library.listTableFiles()) {
      const resolved = path.resolve(entry.filePath);
      byPath.set(resolved, entry);
      byLowerPath.set(resolved.toLowerCase(), entry);
      const key = entry.name.trim().toLowerCase();
      const named = byName.get(key);
      if (named) named.push(entry);
      else byName.set(key, [entry]);
    }
    view.listing = { byPath, byLowerPath, byName };
  }
  return view.listing;
}

/**
 * What the log and `doctor` say of a relationships file that holds a Ref
 * between two of a diagram's tables while the diagram does not import it
 * (`doctor` adds the line to write; the canvas has its own note with a
 * button, `relationshipsNotImportedMessage`). It promises no automatic fix:
 * moving a table saves only positions and leaves the imports as they are.
 */
export function unimportedRelationshipsMessage(file: string): string {
  return `${file} holds a relationship between tables of this diagram, but the diagram does not import it, `
    + 'so neither ERD Studio nor other DBML tools draw it.';
}

export class SubjectAreaService {
  private tableLibraryService: TableLibraryService | null = null;
  /** The last read of each DBML diagram: the relationships files it should import but does not (path → files). */
  private readonly importDrift = new Map<string, string[]>();
  /** The last read of each DBML diagram: each member's layer, from the file it was read from (path → lower-case name → layer). */
  private readonly memberLayers = new Map<string, ReadonlyMap<string, string>>();
  /** The last successful read of each diagram: the fixed codes of the warnings it gave (path → codes; telemetry only). */
  private readonly warningCodes = new Map<string, ReadonlySet<LoaderWarningCode>>();
  /** Each DBML diagram read's members' table files, by the UnifiedSubjectArea the read returned (lower-case reference -> file, null for one drawn missing). */
  private readonly memberFilesByRead = new WeakMap<UnifiedSubjectArea, ReadonlyMap<string, string | null>>();
  /** The last read of each DBML diagram: the table file each member was read from (path → lower-case reference → file, null for one drawn missing). */
  private readonly lastMemberFiles = new Map<string, ReadonlyMap<string, string | null>>();

  constructor(private readonly layerService: LayerService) {}

  /**
   * Set the TableLibraryService for resolving v5 model references.
   * Called after construction since SubjectAreaService may be instantiated before
   * TableLibraryService is available (circular dependency avoidance).
   */
  setTableLibraryService(service: TableLibraryService): void {
    this.tableLibraryService = service;
  }

  /**
   * Discover every diagram under .erd-studio/ — `{layer}/*.json` and the
   * layer's DBML diagrams `{layer}/diagrams/*.dbml` (through the single
   * classifier, `classifySemanticFile`) — grouped by configured layer.
   * Returns lightweight summaries (no full parse). A stem found in both
   * formats in one layer is listed twice, each marked `conflict`.
   *
   * Directory structure:
   *   .erd-studio/{layer}/*.json
   *   .erd-studio/{layer}/diagrams/*.dbml
   */
  listSubjectAreas(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): SubjectAreaSummary[] {
    const basePath = path.join(projectPath, semanticDir);

    if (!fs.existsSync(basePath)) {
      return [];
    }

    const summaries: SubjectAreaSummary[] = [];
    const layers = this.layerService.getAllLayers();

    for (const layerConfig of layers) {
      const layer = layerConfig.id;
      const layerDir = path.join(basePath, layer);
      if (!fs.existsSync(layerDir)) {
        continue;
      }

      let entries: string[];
      try {
        entries = fs.readdirSync(layerDir);
      } catch (err) {
        log.warn(
          `[DomainService] Unable to read directory ${layerDir}: ` +
          `${err instanceof Error ? err.message : String(err)}`
        );
        continue;
      }

      const inLayer: SubjectAreaSummary[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) {
          continue;
        }
        inLayer.push({ domain: path.basename(entry, '.json'), layer, filePath: path.join(layerDir, entry), storage: 'json' });
      }
      // The layer's DBML diagrams, listed only when `diagrams/` is there (the layer's own listing says so).
      if (isDbmlLayerName(layer) && entries.includes(DIAGRAMS_DIR)) {
        const diagramsDir = path.join(layerDir, DIAGRAMS_DIR);
        let diagrams: string[] = [];
        try {
          diagrams = fs.readdirSync(diagramsDir);
        } catch {
          // Not a folder, or not readable: no DBML diagrams here.
        }
        for (const entry of diagrams) {
          const kind = classifySemanticFile(`${layer}/${DIAGRAMS_DIR}/${entry}`, { tablesDirIsLayer: false });
          if (kind.kind !== 'diagram' || kind.storage !== 'dbml' || kind.name === undefined) continue;
          inLayer.push({ domain: kind.name, layer, filePath: path.join(diagramsDir, entry), storage: 'dbml' });
        }
      }
      for (const summary of inLayer) {
        if (inLayer.some((other) => other !== summary && other.domain === summary.domain)) summary.conflict = true;
        summaries.push(summary);
      }
    }

    return summaries;
  }

  /**
   * How many relationships the project's domain files hold between them
   * (`logical.relationships` entries, read raw). Zero means no domain keeps
   * its own, which is what makes the model library the default home for new
   * ones (#126, `usesLibraryRelationships`). A file that does not parse (a
   * merge conflict) but whose text shows a non-empty `"relationships": [`
   * counts as one, so a broken file cannot switch the project's mode.
   */
  countSubjectAreaFileRelationships(projectPath: string, semanticDir = DEFAULT_SEMANTIC_DIR): number {
    let count = 0;
    for (const summary of this.listSubjectAreas(projectPath, semanticDir)) {
      // A DBML diagram holds no relationships (D5): they live in the library.
      if (summary.storage === 'dbml') continue;
      let text: string;
      try {
        text = fs.readFileSync(summary.filePath, 'utf-8');
      } catch {
        continue; // Nothing we could keep in step with.
      }
      try {
        const raw = JSON.parse(text) as { logical?: { relationships?: unknown } } | null;
        const relationships = raw?.logical?.relationships;
        if (Array.isArray(relationships)) count += relationships.length;
      } catch {
        if (/"relationships"\s*:\s*\[\s*[^\s\]]/.test(text)) count += 1;
      }
    }
    return count;
  }

  /**
   * Read and parse a domain JSON file, returning a UnifiedSubjectArea.
   *
   * Every failure before validation is raised as a `SubjectAreaFileError` so
   * callers can tell a file that is momentarily unreadable (empty or truncated
   * because something is writing it right now) from one that is genuinely
   * wrong. See `SubjectAreaFileError` for why that distinction is load-bearing.
   *
   * `dbtKeyIndex` is dbt's key evidence (#133 L1): with it, a link stored
   * twice with no key flagged is drawn from the copy dbt's tests orient. The
   * canvas and the diff pass it; callers that only list or count need not.
   */
  getSubjectArea(filePath: string, options: { dbtKeyIndex?: DbtKeyIndex } = {}): UnifiedSubjectArea {
    // One check of the library index for the whole read, not one per table looked up.
    const library = this.tableLibraryService;
    return library ? library.withIndexSnapshot(() => this.readSubjectArea(filePath, options)) : this.readSubjectArea(filePath, options);
  }

  /**
   * The fixed codes of the warnings the last successful read of the diagram
   * `filePath` gave (2.0 B14: `modelNotFound`, `foreignDbml`, …), never their
   * text; empty when there were none or it was never read.
   */
  loaderWarningCodes(filePath: string): ReadonlySet<LoaderWarningCode> {
    return this.warningCodes.get(path.resolve(filePath)) ?? new Set();
  }

  private readSubjectArea(filePath: string, options: { dbtKeyIndex?: DbtKeyIndex }): UnifiedSubjectArea {
    const codes = new Set<LoaderWarningCode>();
    const unified = this.readSubjectAreaCoded(filePath, options, codes);
    this.warningCodes.set(path.resolve(filePath), codes);
    return unified;
  }

  private readSubjectAreaCoded(filePath: string, options: { dbtKeyIndex?: DbtKeyIndex }, codes: Set<LoaderWarningCode>): UnifiedSubjectArea {
    if (!fs.existsSync(filePath)) {
      throw new SubjectAreaFileError('missing', filePath, `Diagram file not found: ${filePath}`);
    }

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new SubjectAreaFileError('unreadable', filePath, `Failed to read diagram file: ${message}`);
    }

    if (subjectAreaStorageOf(filePath) === 'dbml') {
      const reading = this.readDbmlSubjectArea(filePath, raw);
      reading.warnings.forEach((_w, i) => codes.add(reading.warningCodes?.[i] ?? 'other'));
      const { obj, format } = validateSubjectAreaDocument(reading.obj, filePath);
      const view: DbmlDiagramView = {
        memberPaths: new Map((reading.uses ?? []).map((u) => [(u.ref ?? u.name).toLowerCase(), u.resolved])),
        tableNames: new Map((reading.uses ?? []).filter((u) => u.ref !== undefined && u.ref !== u.name).map((u) => [u.ref!.toLowerCase(), u.name])),
        useTableDirs: reading.useTableDirs ?? [],
        imports: new Set(reading.relationshipsUses),
        unlinked: new Set((reading.unlinked ?? [])
          .filter((n) => this.tableLibraryService?.tableStorage(n) !== 'dbml')
          .map((n) => n.toLowerCase())),
        drift: new Set(),
        memberLayers: new Map(),
        members: DiagramMemberTable.fromUses(reading.uses ?? [], reading.unlinked ?? []),
        memberFiles: new Map(),
      };
      const unified = this.buildUnified(obj, format, filePath, path.basename(filePath, '.dbml'), { ...options, dbml: view, codes });
      // A member named `<schema>.<name>` keeps its own name beside it, a placeholder for a missing one too (as core's loader names it).
      if (view.tableNames.size > 0) {
        unified.logical.models = unified.logical.models.map((m) => {
          const tableName = view.tableNames.get(m.name.toLowerCase());
          if (tableName === undefined || tableNameOf(m) !== undefined) return m;
          const { name, ...rest } = m;
          return { name, tableName, ...rest } as DiagramNamedTable;
        });
      }
      this.memberLayers.set(path.resolve(filePath), view.memberLayers!);
      this.memberFilesByRead.set(unified, view.memberFiles);
      this.lastMemberFiles.set(path.resolve(filePath), view.memberFiles);
      const drift = [...view.drift].sort();
      this.importDrift.set(path.resolve(filePath), drift);
      for (const file of drift) log.warn(`[DomainService] ${filePath}: ${unimportedRelationshipsMessage(file)}`);
      // D8: the diagram's own version, on the Unified shape only.
      unified.schemaVersion = reading.schemaVersion;
      return unified;
    }

    // Empty / invalid JSON (SubjectAreaFileError), then validation and repair
    // (SubjectAreaValidationError, warnings) — shared with every other host.
    const { obj, format } = validateSubjectAreaDocument(parseSubjectAreaJson(raw, filePath), filePath);
    return this.buildUnified(obj, format, filePath, path.basename(filePath, '.json'), { ...options, codes });
  }

  /**
   * How many tables a diagram file shows — the length of its logical
   * stage's `models` — without resolving a single table, for the Subject
   * Areas tree's count: a JSON file validated as `getSubjectArea` validates
   * it (name strings in v5 / v6, named objects in v4), a DBML diagram's
   * members from its `use` lines (`subjectAreaMembersDbml`, no compile of
   * the library). Throws when the file cannot be read, is not valid JSON or
   * does not validate, or (DBML) has a syntax error.
   */
  countSubjectAreaTables(filePath: string): number {
    return this.countSubjectAreaTablesInText(fs.readFileSync(filePath, 'utf-8'), filePath);
  }

  /** {@link countSubjectAreaTables} over a diagram's text (an open document's). */
  countSubjectAreaTablesInText(raw: string, filePath: string): number {
    if (subjectAreaStorageOf(filePath) === 'dbml') {
      // A diagram just read (or just dragged) has its members remembered: no parse.
      const members = rememberedDbmlMembers(raw, filePath) ?? subjectAreaMembersDbml(raw, filePath);
      if (members === null) throw new SubjectAreaValidationError(`${filePath} has a DBML syntax error`);
      return members.length;
    }
    const { obj, format } = validateSubjectAreaDocument(parseSubjectAreaJson(raw, filePath), filePath);
    const logical = obj.logical;
    if (!logical || typeof logical !== 'object' || Array.isArray(logical)) return 0;
    const models = (logical as { models?: unknown }).models;
    if (!Array.isArray(models)) return 0;
    // As `parseStageData` reads them: one table per name (a missing one is a placeholder), or per named inline table.
    return format === 'v5' || format === 'v6'
      ? models.filter((m) => typeof m === 'string').length
      : models.filter((m) => !!m && typeof m === 'object' && typeof (m as { name?: unknown }).name === 'string').length;
  }

  /**
   * Read a `.dbml` diagram (§5.5), positions from its `erd_layout`,
   * through core's `parseSubjectAreaDbml` (which throws `SubjectAreaFileError`
   * / `SubjectAreaValidationError`). A table or relationships file passed as
   * a diagram is refused with core's not-a-diagram message. Each member that
   * resolves to a `.yml` is drawn with a warning (D20).
   */
  readDbmlSubjectArea(filePath: string, text?: string): DbmlSubjectAreaReading {
    // A diagram is `<layer>/diagrams/<name>.dbml`: its semantic dir is three levels up.
    const segments = filePath.split(/[\\/]/).filter((s) => s !== '');
    if (classifySemanticFile(segments.slice(-3).join('/'), { tablesDirIsLayer: false }).kind !== 'diagram' || !filePath.endsWith('.dbml')) {
      const semanticRoot = this.tableLibraryService ? path.dirname(this.tableLibraryService.getTablesDir()) : undefined;
      throw new SubjectAreaValidationError(notADiagramMessage(filePath, semanticRoot), 'notADiagram');
    }
    const raw = text ?? fs.readFileSync(filePath, 'utf-8');
    const reading = readDbmlDiagram(raw, filePath);
    for (const warning of reading.warnings) log.warn(`[DomainService] ${filePath}: ${warning}`);
    // Only a library that holds a YAML table can resolve a member to one (by its name, never `<schema>.<name>`).
    if (this.tableLibraryService?.hasYamlTableFiles()) {
      const names = reading.uses ? [...reading.uses.map((u) => u.name), ...(reading.unlinked ?? [])] : reading.members;
      for (const name of new Set(names)) {
        if (this.tableLibraryService.tableStorage(name) === 'yaml') {
          log.warn(
            `[DomainService] Table "${name}" is a YAML table (${this.tableLibraryService.tableLibraryFile(name)}); the DBML diagram shows it, ` +
            'but run ERD Studio: Convert Project to DBML before editing its relationships (fix the file first if Convert leaves it as it is)',
          );
        }
      }
    }
    return reading;
  }

  /**
   * The relationships files the last read of the DBML diagram `filePath`
   * found holding a relationship between two of its tables that it does
   * not import (so neither the canvas nor other DBML tools draw it), sorted;
   * empty when there are none or it was never read.
   */
  relationshipsImportDrift(filePath: string): string[] {
    return [...(this.importDrift.get(path.resolve(filePath)) ?? [])];
  }

  /**
   * Each table of the DBML diagram `filePath`, as its last read found it: the
   * layer of the file the table was read from (the diagram's `use` path
   * first, as core reads it), by lower-case name. Undefined when it was never
   * read or is not a DBML diagram.
   */
  dbmlMemberLayers(filePath: string): ReadonlyMap<string, string> | undefined {
    return this.memberLayers.get(path.resolve(filePath));
  }

  /**
   * Each member of the DBML diagram `filePath`, as its last read found it: the
   * table file it was read from (its `use` path, the stale-path fallback of
   * owner decision B, or, for a member with no `use` line, the library's file
   * of its name), by lower-case reference; null for one drawn missing.
   * Undefined when it was never read or is not a DBML diagram.
   */
  dbmlMemberFiles(filePath: string): ReadonlyMap<string, string | null> | undefined {
    return this.lastMemberFiles.get(path.resolve(filePath));
  }

  /** `buildUnifiedSubjectArea` with this host's library and layers. */
  private buildUnified(
    obj: Record<string, unknown>,
    format: SubjectAreaFormat,
    filePath: string,
    domainNameFallback: string,
    options: { dbtKeyIndex?: DbtKeyIndex; dbml?: DbmlDiagramView; codes?: Set<LoaderWarningCode> },
  ): UnifiedSubjectArea {
    // The diagram's own tables are read with only the relationships they own
    // worked out (`readingTables`), not an attach over the whole library.
    const library = this.tableLibraryService;
    const names = tableNamesOf(obj).map((ref) => bareNameOf(ref, options.dbml));
    return library
      ? library.readingTables(names, () => this.buildUnifiedNow(obj, format, filePath, domainNameFallback, options))
      : this.buildUnifiedNow(obj, format, filePath, domainNameFallback, options);
  }

  private buildUnifiedNow(
    obj: Record<string, unknown>,
    format: SubjectAreaFormat,
    filePath: string,
    domainNameFallback: string,
    options: { dbtKeyIndex?: DbtKeyIndex; dbml?: DbmlDiagramView; codes?: Set<LoaderWarningCode> },
  ): UnifiedSubjectArea {
    const view = options.dbml;
    const library = this.tableLibraryService;
    const members = new Set(tableNamesOf(obj).map((n) => n.toLowerCase()));
    // Where two schema folders share a name, a member's relationships come from
    // the library under its library reference and are drawn under the diagram's;
    // while none do, every reference is the table's name.
    const scope = library && view && library.hasSharedNames?.() === true ? this.diagramScope(library, view) : undefined;
    return buildUnifiedSubjectArea(obj, format, {
      filePath,
      domainNameFallback,
      // A DBML diagram's layer is the folder above `diagrams/`.
      parentDirName: diagramPathOf(filePath)?.layer ?? path.basename(path.dirname(filePath)),
      layers: this.layerService,
      getModel: library
        ? (name) => {
          if (!view) return this.legacyNamed(library, library.getTable(name));
          const model = scope ? scope.read(name) : this.dbmlMember(library, name, view);
          const tableName = model ? tableNameOf(model) : undefined;
          if (!model || tableName === undefined) return model ? this.importedRelationshipsOnly(library, model, view, members, scope?.of(name)) : null;
          // The library knows the table by its name: its relationships are worked out under that name.
          const { tableName: _ref, ...own } = model as DiagramNamedTable;
          const named: DiagramNamedTable = { ...this.importedRelationshipsOnly(library, { ...own, name: tableName }, view, members, scope?.of(name)), name: model.name, tableName };
          return named;
        }
        : undefined,
      getModelError: this.tableLibraryService
        ? (name) => {
          // A member's error is the error of the file it was read from: for one of two members
          // of one name (or any member, told apart by identity), never the library's first file of its name.
          const read = view && (scope || bareNameOf(name, view) !== name) ? view.memberFiles.get(name.toLowerCase()) : undefined;
          const error = read === undefined
            ? this.tableLibraryService!.getTableFileError(bareNameOf(name, view))
            : read === null ? null : this.tableLibraryService!.getTableFileErrorAt(read, bareNameOf(name, view));
          return error
            ? {
              kind: error.kind,
              ...(error.line !== undefined ? { line: error.line } : {}),
              ...(error.mergeConflict ? { mergeConflict: true as const } : {}),
              // A DBML table's error carries its code (and a Metadata block's target), as core's loader does.
              ...(error.kind.startsWith('dbml') && error.code !== undefined && !error.mergeConflict ? { code: error.code } : {}),
              ...(error.kind.startsWith('dbml') && error.target !== undefined ? { target: error.target } : {}),
            }
            : null;
        }
        : undefined,
      warn: (message, code) => {
        options.codes?.add(code ?? 'other');
        log.warn(`[DomainService] ${message}`);
      },
      ...(options.dbtKeyIndex ? { dbtKeyIndex: options.dbtKeyIndex } : {}),
    });
  }

  /**
   * A DBML diagram's member as core's loader reads it (§2.3): the table in
   * the file its `use` line resolves to when that is a listed table file
   * other than the one the library picks by name (a name in two layers),
   * else the table by name. A member with no `use` line (D26,
   * `erd_unlinked_tables`) is looked for only where core looks, since core
   * cannot list folders: `<dir>/<name>.dbml` in each table folder the
   * diagram's `use` lines name, then a YAML table by name. A `.dbml` table
   * anywhere else is drawn missing, as core draws it, until the next edit
   * gives it a `use` line. A member whose `use` line names no listed file
   * is looked for as core's finder looks ({@link staleMemberFile}). The file
   * it was read from is remembered in `view.memberFiles`.
   */
  private dbmlMember(library: TableLibraryService, ref: string, view: DbmlDiagramView): SemanticTable | null {
    // Two members of one name are named `<schema>.<name>` (core's reference): each is read by its
    // name from its own `use` path, and handed on under its reference with its name beside it.
    const name = bareNameOf(ref, view);
    // The layer of the file the member is read from, for the canvas's badge (core reads it the
    // same way): a file that cannot be read is still in its layer, and drawn there with its error.
    const readFrom = (file: string | null, table: SemanticTable | null): SemanticTable | null => {
      view.memberFiles.set(ref.toLowerCase(), file);
      if (file !== null && view.memberLayers) {
        const entry = listingOf(library, view).byPath.get(path.resolve(file));
        if (entry?.layer !== undefined) view.memberLayers.set(ref.toLowerCase(), entry.layer);
      }
      if (!table || name === ref) return table;
      const named: DiagramNamedTable = { ...table, name: ref, tableName: table.name };
      return named;
    };
    const usePath = view.memberPaths.get(ref.toLowerCase());
    if (usePath === undefined) {
      const listed = listingOf(library, view).byLowerPath;
      for (const dir of view.useTableDirs) {
        if (dir.startsWith('../')) continue;
        const file = listed.get(path.resolve(library.semanticAbsolute(`${dir}/${name}.dbml`)).toLowerCase())?.filePath;
        if (file === undefined) continue;
        const byName = library.findTableFile(name);
        return readFrom(file, byName !== null && path.resolve(byName) === path.resolve(file) ? library.getTable(name) : library.getTableAt(file, name));
      }
      if (library.tableStorage(name) === 'dbml') return readFrom(null, null);
      let file: string | null;
      try {
        file = library.findTableFile(name);
      } catch {
        file = null;
      }
      return readFrom(file, library.getTable(name));
    }
    if (!usePath.startsWith('../')) {
      const file = library.semanticAbsolute(usePath);
      const byName = library.findTableFile(name);
      if (byName !== null && path.resolve(byName) !== path.resolve(file)
        && listingOf(library, view).byPath.has(path.resolve(file))) {
        return readFrom(file, library.getTableAt(file, name));
      }
    }
    const byName = library.findTableFile(name);
    const found = this.staleMemberFile(library, ref, name, usePath, view, byName);
    if (found === null) return readFrom(null, null);
    return readFrom(found, byName !== null && path.resolve(found) === path.resolve(byName) ? library.getTable(name) : library.getTableAt(found, name));
  }

  /**
   * The file a member is read from when its `use` line names no listed table
   * file (or the file the library picks by name: the usual case), by owner
   * decision B (D-6), as core's `dbmlTableFinder` answers with the line's
   * schema as its hint: a file of the name in the line's schema folder (its
   * layer's first), else, in another schema folder, only the one table of
   * that name in the listing (a table moved to another schema), never one
   * of several (it would be another table that happens to share the name).
   * A file another member's `use` line points at is that member's: a member
   * whose own file is gone is drawn missing (null), as core draws it, never
   * as its namesake in another schema folder. A YAML table keeps the
   * library's answer by name.
   */
  private staleMemberFile(library: TableLibraryService, ref: string, name: string, usePath: string, view: DbmlDiagramView, byName: string | null): string | null {
    if (byName === null) return null;
    let found: string | null = byName;
    // The usual case, the library's file of the name is the member's own: nothing to look for.
    const own = path.resolve(byName).toLowerCase() === path.resolve(library.semanticAbsolute(usePath)).toLowerCase();
    if (!own && path.extname(byName).toLowerCase() === '.dbml') {
      const named = (listingOf(library, view).byName.get(name.trim().toLowerCase()) ?? []).filter((e) => e.storage === 'dbml');
      const use = view.members.resolve(ref);
      const hint = use?.id;
      const schema = (hint?.schema ?? use?.qualifier ?? '').toLowerCase();
      const sameSchema = schema === '' ? [] : named.filter((e) => e.folder.toLowerCase() === schema);
      if (sameSchema.length > 0) {
        const sameLayer = sameSchema.filter((e) => e.layer === hint?.layer);
        found = (sameLayer[0] ?? sameSchema[0]).filePath;
      } else if (schema !== '' && new Set(named.map((e) => e.folder.toLowerCase())).size > 1) {
        found = null;
      }
      if (found !== null && path.resolve(found) !== path.resolve(library.semanticAbsolute(usePath))) {
        log.warn(`[DomainService] Table "${name}" is not at its use line's path (${usePath}); it was read from ${library.libraryRelativePath(found)}`);
      } else if (found === null) {
        log.warn(`[DomainService] Table "${name}" is not at its use line's path (${usePath}), and more than one other schema folder has a table of that name: it is drawn missing until the line is fixed`);
      }
    }
    // The member's own file (the usual case) is no other member's: only another file is looked up.
    if (found === null || own) return found;
    if (!view.membersByPath) {
      view.membersByPath = new Map();
      for (const [other, use] of view.memberPaths) {
        if (use.startsWith('../')) continue;
        const key = path.resolve(library.semanticAbsolute(use)).toLowerCase();
        view.membersByPath.set(key, [...(view.membersByPath.get(key) ?? []), other]);
      }
    }
    if ((view.membersByPath.get(path.resolve(found).toLowerCase()) ?? []).some((other) => other !== ref.toLowerCase())) return null;
    return found;
  }

  /**
   * How a DBML diagram's members are read when the library tells tables
   * apart by identity (two schema folders share a name): each member read once, before
   * any relationship is drawn (`read`), so every member's file is known; and
   * for each, the library reference its relationships are owned under and
   * the diagram reference each relationship's other end is drawn under
   * (`of`). An end whose table is not on the diagram keeps its library
   * reference, which names no member.
   */
  private diagramScope(library: TableLibraryService, view: DbmlDiagramView): {
    read: (ref: string) => SemanticTable | null;
    of: (ref: string) => MemberRelationshipScope;
  } {
    const read = new Map<string, SemanticTable | null>();
    let byFile: Map<string, string> | undefined;
    const readAll = (): Map<string, string> => {
      if (byFile) return byFile;
      byFile = new Map();
      for (const ref of view.members.refs()) {
        if (!read.has(ref.toLowerCase())) read.set(ref.toLowerCase(), this.dbmlMember(library, ref, view));
      }
      for (const [ref, file] of view.memberFiles) {
        const key = file === null ? undefined : path.resolve(file).toLowerCase();
        if (key !== undefined && !byFile.has(key)) byFile.set(key, view.members.resolve(ref)?.ref ?? ref);
      }
      return byFile;
    };
    const diagramRefOf = (libraryRef: string): string | undefined => {
      const found = library.resolveLibraryRef(libraryRef);
      // An end the attach could not resolve (an unqualified Ref end two schema folders share, rule 2(e))
      // is reported, never drawn: it would land on whichever member happens to bear the bare name.
      if (found.kind === 'ambiguous') return undefined;
      if (found.kind !== 'found') return libraryRef;
      return readAll().get(path.resolve(found.entry.filePath).toLowerCase()) ?? libraryRef;
    };
    return {
      read: (ref) => {
        readAll();
        const key = ref.toLowerCase();
        if (!read.has(key)) read.set(key, this.dbmlMember(library, ref, view));
        return read.get(key) ?? null;
      },
      of: (ref) => {
        const file = view.memberFiles.get(ref.toLowerCase());
        const entry = file === null || file === undefined ? undefined : library.tableEntryAt(file);
        return { ref, owner: entry?.id, diagramRefOf };
      },
    };
  }

  /**
   * A table a JSON diagram lists (by name alone, D-9's read half): told
   * apart by identity, the library names a relationship's other end by its
   * library reference (`<schema>.<name>` where two schema folders share its
   * name); the end is drawn under its bare name only when that name is what
   * the diagram reads (the library's first file of it), so a relationship
   * of the other table of that name never lands on this one.
   */
  private legacyNamed(library: TableLibraryService, model: SemanticTable | null): SemanticTable | null {
    if (!model || library.hasSharedNames?.() !== true || !(model.relationships ?? []).length) return model;
    let changed = false;
    const relationships = model.relationships!.map((rel) => {
      const found = library.resolveLibraryRef(rel.toModel);
      if (found.kind !== 'found' || sameName(found.entry.name, rel.toModel)) return rel;
      const byName = library.findTableFile(found.entry.name);
      if (byName === null || path.resolve(byName) !== path.resolve(found.entry.filePath)) return rel;
      changed = true;
      return { ...rel, toModel: found.entry.name };
    });
    return changed ? { ...model, relationships } : model;
  }

  /**
   * `model` with only the relationships held in a file the DBML diagram
   * imports, as core draws it (§2.3): a relationship no imported file holds
   * a copy of is left out of the display (never out of the library, which
   * edits read). Each file the shared import rule (`relationshipsImportsFor`)
   * wants for it is recorded as drift for the canvas warning, since the next
   * edit imports those: a live Ref between two `use` members (an unlinked
   * one whose table has a .dbml file counts: that edit gives it a line), or
   * a pending line (D27) between two tables the diagram draws (unlinked ones
   * too). A
   * YAML table's own relationships (held in no relationships file) are kept.
   *
   * With `scope` (the library tells tables apart by identity), the holders
   * are asked by the member's identity, and each kept relationship's other
   * end is drawn under its diagram reference.
   */
  private importedRelationshipsOnly(
    library: TableLibraryService,
    model: SemanticTable,
    view: DbmlDiagramView,
    members: ReadonlySet<string>,
    scope?: MemberRelationshipScope,
  ): SemanticTable {
    const relationships = model.relationships ?? [];
    if (relationships.length === 0) return model;
    const ownerRef = scope?.ref ?? model.name;
    const kept = relationships.filter((rel) => {
      const holders = library.relationshipHolders(scope?.owner ?? model.name, rel);
      if (holders.length === 0 || holders.some((h) => view.imports.has(h.path))) return true;
      const owner = ownerRef.toLowerCase();
      const target = (scope ? scope.diagramRefOf(rel.toModel) : rel.toModel)?.toLowerCase();
      if (target !== undefined && members.has(owner) && members.has(target)) {
        const linked = !view.unlinked.has(owner) && !view.unlinked.has(target);
        for (const h of holders) if (h.pending || linked) view.drift.add(h.path);
      }
      return false;
    });
    const drawn = scope
      ? kept.flatMap((rel) => {
        const toModel = scope.diagramRefOf(rel.toModel);
        if (toModel === undefined) return [];
        return [toModel === rel.toModel ? rel : { ...rel, toModel }];
      })
      : kept;
    if (drawn.length === relationships.length && drawn.every((rel, i) => rel === relationships[i])) return model;
    const { relationships: _all, ...rest } = model;
    return drawn.length > 0 ? { ...rest, relationships: drawn } : rest;
  }

  /**
   * Extract the logical stage from a UnifiedSubjectArea, returning a SemanticSubjectArea.
   *
   * Physical stage is not supported here — use buildPhysicalSubjectArea() instead.
   */
  getSubjectAreaStage(filePath: string, options: { dbtKeyIndex?: DbtKeyIndex } = {}): SemanticSubjectArea {
    return SubjectAreaService.toLogicalStage(this.getSubjectArea(filePath, options));
  }

  /**
   * Project an already-read `UnifiedSubjectArea` onto its logical stage.
   *
   * Pure, and separate from `getSubjectAreaStage` so a caller holding a
   * `UnifiedSubjectArea` does not have to read the file a second time — a second
   * read is a second chance to catch the file mid-replacement.
   */
  static toLogicalStage(unified: UnifiedSubjectArea): SemanticSubjectArea {
    return toLogicalStage(unified);
  }

  /**
   * Build a physical DisplaySubjectArea by projecting a unified domain's logical
   * stage through what exists in the dbt project.
   *
   * Physical domains are not stored on disk — they are derived at runtime.
   * A model EXISTS in the project when ANY of these holds: a `.sql`, `.py` or
   * `.csv` source file sits under a configured model / seed / snapshot path AND
   * dbt has not disabled the model; a dbt schema `.yml` declares it; the
   * compiled manifest carries a node for it; `target/catalog.json` carries a
   * relation for it. Existence deliberately does not require a compiled
   * manifest — greying out every node because `dbt compile` has not been run
   * recently says nothing true about the project.
   *
   * A yml-only model counts as existing even though it is not unambiguously
   * part of the project (dbt warns about a schema patch with no matching node,
   * and `ref()` on it fails to compile). Hiding a documented model is the worse
   * error, and it is the one users report as a bug.
   *
   * A model found in NO source is still EMITTED, with `existsInProject: false`,
   * a `missingReason` and no columns, so it ghosts on the canvas instead of
   * silently vanishing. Phantoms never join `physicalModelNames`, so no
   * relationship is ever derived for one.
   *
   * COLUMNS come from two KINDS of source. The DECLARED list is the yml when
   * present, otherwise the manifest, per model — one source, because the
   * manifest's column list is a compiled copy of the same yml patch, so where
   * they disagree the manifest is merely stale. The OBSERVED list is the
   * catalog, an independent look at the warehouse relation, so where it
   * disagrees that is information. When a catalog node resolves, the rendered
   * list is their UNION in catalog order with declared-only columns appended;
   * with no catalog it is the declared list alone, exactly as before.
   *
   * The union is deliberate and asymmetric. `dbt docs generate` runs far less
   * often than `dbt run`, so letting the catalog replace the list would hide a
   * column added to the SQL and the yml an hour ago and propose a sync plan
   * that DELETES it. The union's opposite cost — a yml documenting a column the
   * warehouse does not have renders a phantom column — is milder: the user
   * authored it, and a column that is shown is inspectable, while one that is
   * dropped is invisible.
   *
   * DATA TYPE is an n-source fallthrough: catalog, then the declared
   * `data_type:`, then the manifest's copy of it, then ''. DESCRIPTION runs the
   * other way — yml, then manifest, then (seeds and snapshots only) their
   * `seeds:` / `snapshots:` documentation, then the catalog comment — because
   * `persist_docs` writes the dbt description INTO the warehouse comment, so a
   * catalog comment is usually a stale echo of the yml.
   *
   * A column present in both sources keeps the DECLARED spelling for display.
   * Snowflake reports UPPERCASE column keys; letting them win would SHOUT every
   * label on the canvas and change every React key for no correctness gain,
   * since comparison keys on `normaliseName` either way.
   *
   * A model known only by its source file renders with zero columns: seeding it
   * with the logical columns would fabricate a shape nothing has verified, and
   * would make the discrepancy report call every one of them 'matched'.
   *
   * Relationship tests are the union of yml and manifest tests (deduped), and
   * cardinality uses uniqueness tests merged from both sources.
   *
   * Model and column name matching is case-insensitive (dbt identifiers are
   * case-insensitive on most warehouses); the logical spelling is kept for
   * display so positions and discrepancy keys stay stable.
   *
   * Uses the global viewConfig for positions so layout is consistent across all stages.
   */
  /**
   * How the physical stage finds each of `unified`'s tables in dbt: by its
   * own name, then by its warehouse relation (schema + alias), as always.
   * A table whose name two schema folders share (two members of one diagram,
   * or two tables of the library told apart by identity) is found by its
   * relation first, then by its name only when that dbt model's schema
   * agrees with the table's (its schema folder or the schema its file
   * declares): one dbt model called `addresse` is never both tables. Such a
   * table carries its `schemas`; `dbtName` is undefined when it found none.
   * The rule {@link dbtTestsOnTables} applies to an added table's dbt tests.
   */
  private dbtMatcher(
    unified: UnifiedSubjectArea,
    ymlData: YmlData,
    manifest: ManifestData | undefined,
  ): (model: SemanticTable) => { byName?: ManifestModelInfo; byRelation?: ManifestModelInfo; dbtName?: string; tableName?: string; schemas?: string[] } {
    const ymlIndex = indexByNormalisedName(ymlData.models);
    const manifestIndex = manifest ? indexByNormalisedName(manifest.models) : undefined;
    // Second-chance index by warehouse relation: (schema, alias ?? name). Only
    // consulted when the model NAME found nothing, and only as a pair — an
    // alias alone would join silver.date to gold.date. See relationKey().
    const manifestByRelation = manifest
      ? indexByRelation([...manifest.models.values()], m => relationKey(m.schema, m.alias ?? m.name))
      : undefined;
    const library = this.tableLibraryService;
    const files = this.memberFilesByRead.get(unified);
    const isShared = this.sharedNameRule();
    return (model) => {
      const tableName = tableNameOf(model);
      const bare = tableName ?? model.name;
      if (!isShared(model)) {
        const byName = manifest?.models.get(model.name) ?? manifestIndex?.get(normaliseName(model.name));
        const knownByName = !!byName || !!ymlData.models.get(model.name)
          || !!ymlIndex.get(normaliseName(model.name)) || !!ymlData.sourceFiles?.get(normaliseName(model.name));
        const byRelation = !knownByName
          ? manifestByRelation?.get(relationKey(model.schema, model.alias ?? model.name))
          : undefined;
        return { byName, byRelation, dbtName: byRelation?.name ?? model.name };
      }
      // The table's schemas: the one its file declares and its schema folder (the file it was read from).
      const file = files?.get(model.name.toLowerCase());
      const folder = file ? library?.tableEntryAt(file)?.id?.schema : undefined;
      const schemas = [...new Set([model.schema, folder].filter((s): s is string => !!s))];
      const agrees = (dbtSchemas: Array<string | undefined>): boolean =>
        dbtSchemas.some((s) => !!s && schemas.some((t) => normaliseName(t) === normaliseName(s)));
      const byRelation = onlyOne(schemas.map((s) => manifestByRelation?.get(relationKey(s, model.alias ?? bare))));
      if (byRelation) return { byRelation, dbtName: byRelation.name, tableName, schemas };
      const named = manifest?.models.get(bare) ?? manifestIndex?.get(normaliseName(bare));
      if (named) return agrees([named.configSchema, named.schema]) ? { byName: named, dbtName: bare, tableName, schemas } : { tableName, schemas };
      // No compiled node: a schema yml that configures the model's schema may still say which table it is.
      const yml = ymlData.models.get(bare) ?? ymlIndex.get(normaliseName(bare));
      return yml && agrees([yml.configSchema]) ? { dbtName: bare, tableName, schemas } : { tableName, schemas };
    };
  }

  /**
   * The dbt model each table of `unified` that the physical stage finds by
   * schema (a name two schema folders share) was found as, by lower-case
   * reference: null for one it found none for. Tables found by their own
   * name are not listed: their dbt model is their name. For the selectors and
   * the sync plan, so they name the model the comparison matched.
   */
  dbtModelNamesOf(unified: UnifiedSubjectArea, ymlData: YmlData, manifest?: ManifestData): Map<string, string | null> {
    const out = new Map<string, string | null>();
    // Nothing is indexed for a diagram with no such table (every diagram of a project with no shared name).
    const isShared = this.sharedNameRule();
    if (!unified.logical.models.some(isShared)) return out;
    const match = this.dbtMatcher(unified, ymlData, manifest);
    for (const model of unified.logical.models) {
      const found = match(model);
      if (found.schemas) out.set(model.name.toLowerCase(), found.dbtName ?? null);
    }
    return out;
  }

  /** Whether a table's name is shared by two schema folders: two members of its diagram, or two tables of the library. */
  private sharedNameRule(): (model: SemanticTable) => boolean {
    const library = this.tableLibraryService;
    return (model) => tableNameOf(model) !== undefined || library?.isAmbiguousName?.(model.name) === true;
  }

  /**
   * Each table of a DBML diagram's read `unified` by its identity (the file it
   * was read from), by lower-case reference; empty for a JSON diagram and a
   * table drawn missing. For the sync plan's library lookups, which must name
   * a table's own file where a name is shared.
   */
  tableIdsOf(unified: UnifiedSubjectArea): Map<string, TableId> {
    const out = new Map<string, TableId>();
    const library = this.tableLibraryService;
    for (const [ref, file] of this.memberFilesByRead.get(unified) ?? []) {
      const id = file ? library?.tableEntryAt(file)?.id : undefined;
      if (id) out.set(ref, id);
    }
    return out;
  }

  buildPhysicalSubjectArea(
    unifiedDomain: UnifiedSubjectArea,
    ymlData: YmlData,
    manifest?: ManifestData,
    catalog?: CatalogData,
  ): DisplaySubjectArea {
    const logicalStage = unifiedDomain.logical;
    const physicalModelNames = new Set<string>();

    const ymlIndex = indexByNormalisedName(ymlData.models);
    const catalogByRelation = catalog
      ? indexByRelation([...catalog.byUniqueId.values()].filter(n => n.resourceType === 'model'), n => relationKey(n.schema, n.relationName))
      : undefined;
    const match = this.dbtMatcher(unifiedDomain, ymlData, manifest);
    // dbt model name (normalised) → logical name, for models resolved through
    // the relation index (or, for a name two schema folders share, any model
    // found under another name), so their relationship tests land on the
    // right node.
    const resolvedViaRelation = new Map<string, string>();
    // The names of tables two schema folders share that are NOT the dbt model
    // of that name (another schema's): that model's tests must not land on them.
    const notTheirDbtModel = new Set<string>();

    const models: DisplayTable[] = logicalStage.models.map(model => {
        const { byName, byRelation, dbtName, tableName, schemas } = match(model);
        if (byRelation) {
          resolvedViaRelation.set(normaliseName(byRelation.name), model.name);
        } else if (dbtName !== undefined && normaliseName(dbtName) !== normaliseName(model.name)) {
          resolvedViaRelation.set(normaliseName(dbtName), model.name);
        }
        if (schemas && (dbtName === undefined || normaliseName(dbtName) !== normaliseName(model.name))) {
          notTheirDbtModel.add(normaliseName(model.name));
        }
        // Everything below is looked up by the dbt model's own name, which is
        // the logical name unless the relation index resolved it. A table two
        // schema folders share that matched no dbt model looks up nothing.
        const key = dbtName === undefined ? undefined : normaliseName(dbtName);
        const ymlModel = dbtName === undefined ? undefined : ymlData.models.get(dbtName) ?? ymlIndex.get(key!);
        const manifestModel = byName ?? byRelation;
        // `sourceFiles` is keyed by an already-normalised stem — look it up with
        // normaliseName(), never through indexByNormalisedName().
        const sourceFile = key === undefined ? undefined : ymlData.sourceFiles?.get(key);
        // A disabled model's .sql is on disk but `ref()` to it fails, so the bare
        // file must not upgrade it to "exists". The veto applies to THAT branch
        // only: a disabled model still declared in a yml keeps what the yml says,
        // because that is a different question.
        const disabled = key === undefined ? false : manifest?.disabledModels.has(key) ?? false;
        // unique_id first, then the short-name index (catalogNodeFor — the
        // same lookup Import from dbt seeds types through); the relation index
        // only when no manifest resolved the model. A table two schema folders share
        // never takes the short-name index's node (owner decision H): with no
        // manifest node to say which, only its own relation finds its columns.
        const relation = model.alias ?? tableName ?? model.name;
        const catalogNode = (key === undefined || (schemas !== undefined && !manifestModel) ? undefined : catalogNodeFor(catalog, manifestModel, key))
          ?? (manifestModel ? undefined : onlyOne((schemas ?? [model.schema]).map((s) => catalogByRelation?.get(relationKey(s, relation)))));
        // Seed / snapshot documentation: DESCRIPTIONS ONLY. It never decides
        // existence, adds a column or pulls in an edge — those stay the job of
        // the model sources above, exactly as before seeds were documented.
        const ymlDoc = key === undefined ? undefined : ymlData.resourceDocs?.get(key);
        const manifestDoc = key === undefined ? undefined : manifest?.resourceDocs?.get(key);
        const docColumnDescriptions = new Map<string, string>();
        for (const dc of [...(manifestDoc?.columns ?? []), ...(ymlDoc?.columns ?? [])]) {
          // yml second so it overwrites the manifest's compiled copy.
          if (dc.description) { docColumnDescriptions.set(normaliseName(dc.name), dc.description); }
        }

        if (!ymlModel && !manifestModel && !catalogNode && !(sourceFile && !disabled)) {
          // Phantom: the design references a model the dbt project does not have.
          // Emitted (not dropped) so the canvas can say so, but kept out of
          // physicalModelNames so it pulls in no edges.
          return {
            name: model.name,
            ...(tableName !== undefined ? { tableName } : {}),
            schema: '',
            ...(model.alias ? { alias: model.alias } : {}),
            description: model.description || '',
            columns: [],
            rationale: model.rationale,
            // The design's own fields (team fields, business_rule), shown read-only beside rationale: display only, never persisted.
            ...(model.meta ? { meta: model.meta } : {}),
            grain: model.grain,
            modelRole: model.modelRole,
            existsInProject: false,
            missingReason: disabled ? ('disabled' as const) : ('absent' as const),
          };
        }
        physicalModelNames.add(model.name);

        // Columns come from yml when present, otherwise from the manifest. The
        // two are ONE 'declared' source with yml winning per model: the
        // manifest's column list is a compiled copy of the same yml patch, so
        // where they disagree the manifest is simply stale.
        const declaredSource: PhysicalColumnSource | undefined =
          ymlModel ? 'yml' : (manifestModel ? 'manifest' : undefined);
        const declaredColumns: { name: string; dataType: string | null; description: string }[] = ymlModel
          ? (ymlModel.columns ?? []).map(c => ({ name: c.name, dataType: c.dataType, description: c.description }))
          : (manifestModel?.columns ?? []).map(c => ({ name: c.name, dataType: c.data_type, description: c.description }));

        const manifestByCol = new Map(
          (manifestModel?.columns ?? []).map(mc => [normaliseName(mc.name), mc]),
        );
        const declaredByCol = new Map(
          declaredColumns.map(dc => [normaliseName(dc.name), dc]),
        );

        // The rendered list: catalog order first (the warehouse's own ordinal
        // positions), then any declared column the catalog has not seen. With no
        // catalog node it is the declared list, unchanged from before.
        type ColumnEntry = {
          key: string;
          declared?: { name: string; dataType: string | null; description: string };
          observed?: CatalogColumn;
        };
        const entries: ColumnEntry[] = [];
        const seenColumns = new Set<string>();
        if (catalogNode) {
          for (const cc of catalogNode.columns) {
            const ck = normaliseName(cc.name);
            if (seenColumns.has(ck)) { continue; }
            seenColumns.add(ck);
            entries.push({ key: ck, declared: declaredByCol.get(ck), observed: cc });
          }
        }
        for (const dc of declaredColumns) {
          const dk = normaliseName(dc.name);
          if (seenColumns.has(dk)) { continue; }
          seenColumns.add(dk);
          entries.push({ key: dk, declared: dc });
        }

        // Which sources actually supplied a data type, so provenance can name
        // the most authoritative one rather than guessing from the column list.
        const typeSources = new Set<PhysicalColumnSource>();

        const columns: DisplayColumn[] = entries.map(entry => {
          const manifestCol = manifestByCol.get(entry.key);

          // Ordered fallthrough — what the warehouse reports, then the declared
          // assertion, then the manifest's compiled copy of it, then ''.
          const { dataType, source: typeSource } = resolveColumnType(
            entry.observed?.dataType, entry.declared?.dataType, manifestCol?.data_type,
          );
          if (typeSource === 'declared') {
            if (declaredSource) { typeSources.add(declaredSource); }
          } else if (typeSource) {
            typeSources.add(typeSource);
          }

          return {
            // The declared spelling wins whenever there is one — see the
            // UPPERCASE note on this method.
            name: entry.declared?.name ?? entry.observed?.name ?? '',
            dataType,
            // The human's words beat the warehouse's echo of them: persist_docs
            // copies the dbt description into the relation comment.
            description: entry.declared?.description || manifestCol?.description
              || docColumnDescriptions.get(entry.key) || entry.observed?.comment || '',
            isPrimaryKey: false,
            isForeignKey: false,
            isNaturalKey: false,
          };
        });

        // Carry forward PK/FK/NK/SCD flags from logical domain columns
        const logicalColumns = model.columns ?? [];
        for (const dc of columns) {
          const dcKey = normaliseName(dc.name);
          const logicalCol = logicalColumns.find(c => normaliseName(c.name) === dcKey);
          if (logicalCol) {
            dc.isPrimaryKey = logicalCol.isPrimaryKey ?? false;
            dc.isForeignKey = logicalCol.isForeignKey ?? false;
            dc.isNaturalKey = logicalCol.isNaturalKey ?? false;
            if (logicalCol.scdType !== undefined) { dc.scdType = logicalCol.scdType; }
            if (logicalCol.additiveType !== undefined) { dc.additiveType = logicalCol.additiveType; }
            // The column's fields kept in meta, for the read-only Detail panel (never persisted).
            if (logicalCol.meta) { dc.meta = logicalCol.meta; }
          }
        }

        // Provenance: who contributed the column list, and who supplied the
        // types. `columns` is an array because a model's shape can come from
        // more than one source; a single label would lie about it.
        const columnSources: PhysicalColumnSource[] = [];
        if (catalogNode && catalogNode.columns.length > 0) { columnSources.push('catalog'); }
        if (declaredSource && declaredColumns.length > 0) { columnSources.push(declaredSource); }
        if (columnSources.length === 0) {
          // Nothing contributed a column: a declared or catalogued model with
          // none documented, or a model known only by the file that defines it.
          // Name whichever source resolved it, so the chip is never blank.
          columnSources.push(declaredSource ?? (catalogNode ? 'catalog' : 'file'));
        }
        const types = SOURCE_AUTHORITY.find(s => typeSources.has(s)) ?? columnSources[0];
        const alias = physicalAlias(model.alias, manifestModel, catalogNode);

        return {
          name: model.name,
          // Two members of one name: the diagram's reference is the name, the table's own name beside it.
          ...(tableName !== undefined ? { tableName } : {}),
          // MANIFEST FIRST, not catalog first. The two agree on the value and
          // disagree only on case — no adapter lowercases `metadata.schema`, so
          // Snowflake's catalog says ANALYTICS where the manifest carries the
          // lowercase `analytics` the user actually wrote. With neither source
          // the honest answer is '' and the node badge falls back to the layer.
          schema: manifestModel?.schema || catalogNode?.schema || '',
          // The name dbt actually builds the table as wins over the design's:
          // the physical stage shows what exists. A catalog relation named
          // after the model says "no alias", so it does not clear the logical one.
          ...(alias ? { alias } : {}),
          description: ymlModel?.description || manifestModel?.description
            || ymlDoc?.description || manifestDoc?.description
            || catalogNode?.comment || model.description || '',
          columns,
          rationale: model.rationale,
          // The design's own fields (team fields, business_rule), shown read-only beside rationale: display only, never persisted.
          ...(model.meta ? { meta: model.meta } : {}),
          grain: model.grain,
          modelRole: model.modelRole,
          existsInProject: true,
          provenance: { columns: columnSources, types },
        };
      });

    // Relationship tests: union of yml (primary) and manifest, deduped.
    // Uniqueness info is likewise merged from both sources.
    const mergedRelationshipTests = mergeRelationshipTests(
      ymlData.relationshipTests,
      manifest?.relationshipTests,
    );
    const mergedUniqueColumns = mergeUniqueMaps(
      ymlData.uniqueColumns,
      manifest?.uniqueColumns,
    );
    const mergedCompositeGroups = mergeCompositeGroups(
      ymlData.compositeUniqueGroups,
      manifest?.compositeUniqueGroups,
    );

    // Composite foreign keys dbt declares (#133 L2): constraints and
    // dbt_constraints tests, yml ∪ manifest.
    const mergedForeignKeys = mergeCompositeForeignKeys(ymlData.compositeForeignKeys, manifest?.compositeForeignKeys);
    // A test naming another schema's dbt model of a shared name names no table here ('' matches none).
    for (const name of notTheirDbtModel) {
      if (!resolvedViaRelation.has(name)) resolvedViaRelation.set(name, '');
    }

    const relationships = derivePhysicalRelationships(
      renameTestTables(mergedRelationshipTests, resolvedViaRelation),
      physicalModelNames,
      renameMapKeys(mergedUniqueColumns, resolvedViaRelation),
      renameMapKeys(mergedCompositeGroups, resolvedViaRelation),
      renameTestTables(mergedForeignKeys, resolvedViaRelation),
    );

    return {
      schemaVersion: unifiedDomain.schemaVersion,
      domain: unifiedDomain.domain,
      layer: unifiedDomain.layer,
      stage: 'physical',
      description: unifiedDomain.description,
      modelFolder: unifiedDomain.modelFolder,
      models,
      relationships,
      viewConfig: unifiedDomain.viewConfig,
      readOnly: true,
      positionDraggable: true,
      physicalSources: {
        yml: ymlData.models.size > 0,
        manifest: (manifest?.models.size ?? 0) > 0,
        catalog: (catalog?.byUniqueId.size ?? 0) > 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Physical relationship derivation (yml + manifest tests)
// ---------------------------------------------------------------------------

/**
 * Derive physical relationships from relationship tests (yml and/or manifest).
 * Accepts any object with the RelationshipTest shape (structural typing).
 *
 * Each relationship test becomes one edge. Cardinality is derived from
 * uniqueness tests:
 * - `unique` test on a column → that side is "one"
 * - `unique_combination_of_columns` → side is "one" if all columns in the
 *   composite group are covered by relationship tests between the same model pair
 * - No uniqueness test → that side defaults to "many"
 *
 * Results are scoped to only models present in the domain's physical model set,
 * preventing conformed dimensions from pulling in relationships to models
 * outside the current domain. Model and column names are matched
 * case-insensitively; emitted edges use the spelling from `physicalModelNames`
 * so they line up with the physical DisplayModels.
 *
 * A composite foreign key dbt declares (#133 L2) adds one edge per column
 * pair, sharing `compositeKey` (its name, else `fk_<toModel>`) when the pairs
 * form a valid composite. Its "to" side is unique by definition: each member
 * is many-to-one, or one-to-one when the from columns are a declared unique
 * combination. A pair a relationships test also declares is drawn once, as
 * the composite's member.
 */
export function derivePhysicalRelationships(
  relationshipTests: RelationshipTest[],
  physicalModelNames: Set<string>,
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
  compositeForeignKeys: readonly CompositeForeignKey[] = [],
): DisplayRelationship[] {
  // normalised name → display name (as used by the physical DisplayModels)
  const canonicalModelNames = new Map<string, string>();
  for (const name of physicalModelNames) {
    const key = normaliseName(name);
    if (!canonicalModelNames.has(key)) {
      canonicalModelNames.set(key, name);
    }
  }

  // Filter to relationships where both models are in this domain, rewriting
  // model names to the domain's spelling.
  const domainTests: RelationshipTest[] = [];
  for (const rel of relationshipTests) {
    const fromModel = canonicalModelNames.get(normaliseName(rel.fromModel));
    const toModel = canonicalModelNames.get(normaliseName(rel.toModel));
    if (fromModel && toModel) {
      domainTests.push({ ...rel, fromModel, toModel });
    }
  }

  // Uniqueness lookups keyed by normalised model / column name
  const normalisedUnique = new Map<string, Set<string>>();
  for (const [model, cols] of uniqueColumns) {
    const key = normaliseName(model);
    let set = normalisedUnique.get(key);
    if (!set) {
      set = new Set<string>();
      normalisedUnique.set(key, set);
    }
    for (const col of cols) { set.add(normaliseName(col)); }
  }
  const normalisedComposite = new Map<string, string[][]>();
  for (const [model, groups] of compositeUniqueGroups) {
    const key = normaliseName(model);
    const list = normalisedComposite.get(key) ?? [];
    for (const group of groups) { list.push(group.map(normaliseName)); }
    normalisedComposite.set(key, list);
  }

  // Group tests by (fromModel, toModel) pair for composite unique checks
  const pairKey = (from: string, to: string) => `${normaliseName(from)}\0${normaliseName(to)}`;
  const testsByPair = new Map<string, RelationshipTest[]>();
  for (const test of domainTests) {
    const key = pairKey(test.fromModel, test.toModel);
    let group = testsByPair.get(key);
    if (!group) {
      group = [];
      testsByPair.set(key, group);
    }
    group.push(test);
  }

  const composites: DisplayRelationship[] = [];
  for (const fk of compositeForeignKeys) {
    const fromModel = canonicalModelNames.get(normaliseName(fk.fromModel));
    const toModel = canonicalModelNames.get(normaliseName(fk.toModel));
    if (!fromModel || !toModel || fk.fromColumns.length !== fk.toColumns.length) continue;
    const fromSet = fk.fromColumns.map(normaliseName);
    const oneToOne = (normalisedComposite.get(normaliseName(fromModel)) ?? [])
      .some((group) => group.length === fromSet.length && fromSet.every((c) => group.includes(c)));
    const members: DisplayRelationship[] = fk.fromColumns.map((fromColumn, i) => ({
      fromModel, fromColumn, toModel, toColumn: fk.toColumns[i], cardinality: oneToOne ? 'one-to-one' : 'many-to-one',
    }));
    const compositeKey = fk.name ?? `fk_${toModel}`;
    composites.push(...(compositeGroupProblem(members) ? members : members.map((m) => ({ ...m, compositeKey }))));
  }
  const declared = new Set(composites.map(linkKey));

  return [
    ...domainTests.filter((rel) => !declared.has(linkKey(rel))).map(rel => ({
      fromModel: rel.fromModel,
      fromColumn: rel.fromColumn,
      toModel: rel.toModel,
      toColumn: rel.toColumn,
      cardinality: deriveCardinality(
        rel,
        testsByPair.get(pairKey(rel.fromModel, rel.toModel)) ?? [],
        normalisedUnique,
        normalisedComposite,
      ),
    })),
    ...composites,
  ];
}

/**
 * Composite foreign keys from the yml (primary) and the manifest, one per
 * composite (`groupKey`: the same members, whatever the name).
 */
export function mergeCompositeForeignKeys(
  primary: readonly CompositeForeignKey[] = [],
  secondary: readonly CompositeForeignKey[] = [],
): CompositeForeignKey[] {
  const seen = new Set<string>();
  const merged: CompositeForeignKey[] = [];
  for (const fk of [...primary, ...secondary]) {
    const key = groupKey(fk.fromColumns.map((fromColumn, i) => ({
      fromModel: fk.fromModel, fromColumn, toModel: fk.toModel, toColumn: fk.toColumns[i] ?? '', cardinality: 'many-to-one' as const,
    })));
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fk);
  }
  return merged;
}

/**
 * True if a relationship references the given (model, column) on either
 * endpoint, matched without case (#133 L4). Used to cascade-delete
 * relationships when a column is removed.
 */
export function relationshipReferencesColumn(
  rel: { fromModel?: unknown; fromColumn?: unknown; toModel?: unknown; toColumn?: unknown },
  modelName: string,
  columnName: string,
): boolean {
  const same = (a: unknown, b: string): boolean => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();
  return (
    (same(rel.fromModel, modelName) && same(rel.fromColumn, columnName)) ||
    (same(rel.toModel, modelName) && same(rel.toColumn, columnName))
  );
}

/**
 * Derive cardinality for a single relationship edge based on uniqueness tests.
 */
function deriveCardinality(
  rel: RelationshipTest,
  allTestsBetweenPair: RelationshipTest[],
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): Cardinality {
  const fromUnique = isColumnEffectivelyUnique(
    rel.fromModel, rel.fromColumn, 'from',
    allTestsBetweenPair, uniqueColumns, compositeUniqueGroups,
  );
  const toUnique = isColumnEffectivelyUnique(
    rel.toModel, rel.toColumn, 'to',
    allTestsBetweenPair, uniqueColumns, compositeUniqueGroups,
  );

  if (fromUnique && toUnique) { return 'one-to-one'; }
  if (!fromUnique && toUnique) { return 'many-to-one'; }
  if (fromUnique && !toUnique) { return 'one-to-many'; }
  return 'many-to-many';
}

/**
 * Check if a column is effectively unique for cardinality purposes.
 *
 * A column is "unique" if:
 * 1. It has a standalone `unique` test, OR
 * 2. It's part of a `unique_combination_of_columns` group where ALL columns
 *    in that group are covered by relationship tests between the same model pair
 *    (meaning the full composite key is present in the relationship edges).
 *
 * `uniqueColumns` / `compositeUniqueGroups` must already be keyed by
 * normalised (lower-cased) model and column names.
 */
function isColumnEffectivelyUnique(
  model: string,
  column: string,
  side: 'from' | 'to',
  allTestsBetweenPair: RelationshipTest[],
  uniqueColumns: Map<string, Set<string>>,
  compositeUniqueGroups: Map<string, string[][]>,
): boolean {
  const modelKey = normaliseName(model);
  const columnKey = normaliseName(column);

  // 1. Single-column unique test
  if (uniqueColumns.get(modelKey)?.has(columnKey)) {
    return true;
  }

  // 2. Composite unique — column must be in the group, and ALL columns in
  //    the group must be covered by relationship tests for this model pair
  const groups = compositeUniqueGroups.get(modelKey) ?? [];
  const pairColumns = new Set(
    allTestsBetweenPair.map(t => normaliseName(side === 'from' ? t.fromColumn : t.toColumn)),
  );

  for (const group of groups) {
    if (group.includes(columnKey) && group.every(col => pairColumns.has(col))) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Merge helpers — combine data from yml (primary) and manifest
// ---------------------------------------------------------------------------

/**
 * Key for a warehouse relation: normalised `schema.relation`, or '' when the
 * schema is unknown. Matching on the relation name alone is exactly what the
 * alias fallback must never do — `date` exists in silver AND gold — so a
 * model with no schema never takes this route.
 */
function relationKey(schema: string | undefined, relation: string | undefined): string {
  if (!schema || !relation) { return ''; }
  return `${normaliseName(schema)}.${normaliseName(relation)}`;
}

/**
 * Index entries by relation key. A key two entries share is AMBIGUOUS and is
 * left out entirely: a guess between them would render one model's columns
 * under another's name, and a missing model is the honest answer.
 */
function indexByRelation<T>(entries: T[], keyOf: (entry: T) => string): Map<string, T> {
  const index = new Map<string, T>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key || ambiguous.has(key)) { continue; }
    if (index.has(key)) {
      index.delete(key);
      ambiguous.add(key);
      continue;
    }
    index.set(key, entry);
  }
  return index;
}

/** The one distinct entry `found` holds (undefined entries ignored), or undefined when it holds none or several. */
function onlyOne<T>(found: Array<T | undefined>): T | undefined {
  const distinct = [...new Set(found.filter((f): f is T => f !== undefined))];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/** The physical model's alias: dbt's, then a catalog relation named otherwise, then the design's. */
function physicalAlias(
  logicalAlias: string | undefined,
  manifestModel: { name: string; alias?: string } | undefined,
  catalogNode: { name: string; relationName: string; version?: string } | undefined,
): string | undefined {
  if (manifestModel) { return manifestModel.alias ?? logicalAlias; }
  if (catalogNode?.relationName && catalogNode.version === undefined
    && normaliseName(catalogNode.relationName) !== normaliseName(catalogNode.name)) {
    return catalogNode.relationName;
  }
  return logicalAlias;
}

/** Rewrite relationship test endpoints named in `renames` (normalised dbt name → logical name). */
function renameTestTables<T extends { fromModel: string; toModel: string }>(tests: T[], renames: Map<string, string>): T[] {
  if (renames.size === 0) { return tests; }
  return tests.map(t => ({
    ...t,
    fromModel: renames.get(normaliseName(t.fromModel)) ?? t.fromModel,
    toModel: renames.get(normaliseName(t.toModel)) ?? t.toModel,
  }));
}

/** Re-key a per-model map with `renames` (normalised dbt name → logical name). */
function renameMapKeys<V>(map: Map<string, V>, renames: Map<string, string>): Map<string, V> {
  if (renames.size === 0) { return map; }
  const out = new Map<string, V>();
  for (const [model, value] of map) {
    out.set(renames.get(normaliseName(model)) ?? model, value);
  }
  return out;
}

/** Build a lookup keyed by normalised model name (first entry wins on collision). */
function indexByNormalisedName<T>(map: Map<string, T>): Map<string, T> {
  const index = new Map<string, T>();
  for (const [name, value] of map) {
    const key = normaliseName(name);
    if (!index.has(key)) {
      index.set(key, value);
    }
  }
  return index;
}

/**
 * Union relationship tests from yml (primary) and manifest, deduped by
 * (fromModel, fromColumn, toModel, toColumn) — case-insensitive.
 */
function mergeRelationshipTests(
  primary: RelationshipTest[],
  secondary?: RelationshipTest[],
): RelationshipTest[] {
  if (!secondary || secondary.length === 0) { return primary; }

  const seen = new Set<string>();
  const merged: RelationshipTest[] = [];
  for (const test of [...primary, ...secondary]) {
    const key = [test.fromModel, test.fromColumn, test.toModel, test.toColumn]
      .map(normaliseName)
      .join('\0');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(test);
    }
  }
  return merged;
}

/** Merge two unique-column maps: union of columns per model. */
export function mergeUniqueMaps(
  primary: Map<string, Set<string>>,
  secondary?: Map<string, Set<string>>,
): Map<string, Set<string>> {
  if (!secondary) { return primary; }

  const merged = new Map<string, Set<string>>();
  // Copy primary
  for (const [model, cols] of primary) {
    merged.set(model, new Set(cols));
  }
  // Union secondary
  for (const [model, cols] of secondary) {
    const existing = merged.get(model);
    if (existing) {
      for (const col of cols) { existing.add(col); }
    } else {
      merged.set(model, new Set(cols));
    }
  }
  return merged;
}

/** Merge two composite-unique-group maps: concatenate groups per model. */
export function mergeCompositeGroups(
  primary: Map<string, string[][]>,
  secondary?: Map<string, string[][]>,
): Map<string, string[][]> {
  if (!secondary) { return primary; }

  const merged = new Map<string, string[][]>();
  // Copy primary
  for (const [model, groups] of primary) {
    merged.set(model, [...groups]);
  }
  // Append secondary (dedupe by content)
  for (const [model, groups] of secondary) {
    const existing = merged.get(model) ?? [];
    for (const group of groups) {
      const key = [...group].sort().join('\0');
      const alreadyExists = existing.some(g => [...g].sort().join('\0') === key);
      if (!alreadyExists) {
        existing.push(group);
      }
    }
    merged.set(model, existing);
  }
  return merged;
}

/** A DBML member's name from its reference (`<schema>.<name>` for a name two members share); any other name is its own. */
function bareNameOf(ref: string, view: DbmlDiagramView | undefined): string {
  return view?.tableNames.get(ref.toLowerCase()) ?? ref;
}

/** The table names a validated diagram object's logical stage lists (v5 / v6 name strings; none for v4's inline tables). */
function tableNamesOf(obj: Record<string, unknown>): string[] {
  const logical = obj.logical;
  if (!logical || typeof logical !== 'object' || Array.isArray(logical)) return [];
  const models = (logical as { models?: unknown }).models;
  return Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [];
}
