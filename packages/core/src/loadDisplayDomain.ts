/**
 * Raw files -> DisplaySubjectArea in one call, for hosts that read a domain folder
 * through an async `readFile` (a git provider, an HTTP API, a zip) and render
 * it without the extension's editing extras.
 *
 * The folder layout is the extension's:
 *
 *   {semanticDir}/layers.json
 *   {semanticDir}/logical-models/{model}.yml           <- a flat library, or
 *   {semanticDir}/logical-models/{layer}/{model}.yml   <- grouped by layer
 *   {semanticDir}/tables/…                             <- the same, under v6's name
 *   {semanticDir}/{layer}/{domain}.json                <- domainPath
 *
 * A model file may sit at the top of `logical-models/` or one folder down;
 * the folder is organisational only and names are unique across the library.
 * With no directory listing to go on, a v5 or v6 model is found by probing,
 * in order: `logical-models/{model}.yml`, then the folder of every layer in
 * `layers.json` (and the domain's own), alphabetically, then the same under
 * `tables/` — the extension's order — and the first file that exists is
 * used. A flat v5 library therefore costs exactly one read per model, as
 * before; a v6 one costs one more per folder probed first. Folders not named
 * after a layer are invisible here: only hosts that can list directories (the
 * extension) see them, and only they report a name found in both libraries.
 *
 * A DBML diagram (`{semanticDir}/{layer}/diagrams/{diagram}.dbml`, read with
 * the `dbml` option) names its tables by its `use` lines instead: each is
 * read from the path its line resolves to, then from `{dir}/{name}.dbml` in
 * each `{layer}/tables/{schema}` folder its lines name, then by the YAML
 * probe above, then (only for a member with a `use` line, and only when the
 * host passes `findDbmlTable`) from the file the host finds by name; its
 * relationships come from the relationships files it imports
 * (`use * from '…/relationships/{file}.dbml'`), and from no other.
 *
 * With `readFieldsFile: true`, the project's field list is read too:
 *
 *   {semanticDir}/fields.yml                           <- optional, next to layers.json
 *
 * once, right after `layers.json` and before any model, and set as the
 * result's `fields`. A missing file is no list (the renderer's starting set),
 * as a missing `layers.json` is the default layers. A file longer than
 * `maxDomainChars` is not parsed (a warning, no list); `maxYamlNodes` and
 * `maxYamlChars` bound its YAML expansion. A file that is not YAML, or not a
 * map, gives a warning and no list; every other problem is a warning and the
 * list is used. A fields.yml never makes the load fail. Off by default, so a
 * host that does not ask reads exactly the files it always read.
 *
 * Everything the files say is validated and repaired by the same functions
 * the extension host uses. The limits in the options exist for hosts that
 * read files they do not control; all of them are off by default.
 */

import type { DisplaySubjectArea } from './types/display.js';
import type { SubjectAreaFormat, TableLoadError, NodePosition, SemanticTable, LoaderWarningCode } from './types/semantic.js';
import { tableNameOf, usesTableLibrary, type DiagramNamedTable } from './types/semantic.js';
import type { DbmlAttachTable, DbmlMemberUse, DbmlRelationshipsReading, DbmlStorageReader } from './types/dbmlStorage.js';
import type { LayerConfig } from './types/layer.js';
import {
  SubjectAreaFileError,
  SubjectAreaValidationError,
  buildUnifiedSubjectArea,
  classifyTableLoadError,
  parseSubjectAreaJson,
  resolveSubjectAreaLayer,
  toLogicalStage,
  validateSubjectAreaDocument,
  type LayerLookup,
} from './domain.js';
import { LAYERS_CONFIG_FILE, parseLayersText } from './layers.js';
import { FIELDS_FILE_NAME, parseFieldsText } from './fieldsFile.js';
import type { FieldList } from './fields.js';
import { YamlCharLimitError, YamlNodeLimitError, isSafeTableName, parseTableTextWithUsage } from './logicalModel.js';
import { dbmlNotADiagramMessage, dbmlTreePathOf, diagramPathOf, normalisePosix, tableFileCandidates, type DbmlTableHint } from './storage.js';
import { attachRelationships, contestedUsePaths, dbmlTableLookup, type DbmlAttachReading } from './dbmlAttach.js';
import { tableIdKey, tableIdOfPath } from './tableIdentity.js';
import { linkKey } from './relationships.js';
import { computeMissingPositions, toDisplaySubjectArea } from './displayDomain.js';
import { checkLimit } from './limits.js';

/**
 * Run `worker` over `items` with at most `limit` calls in flight, keeping the
 * results in input order. The first rejection rejects the whole call, and no
 * further items are started after it. `limit` must be a number of at least 1
 * (a fraction is rounded down; `Infinity` runs everything at once); anything
 * else rejects with a TypeError.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  checkLimit('mapWithLimit', 'limit', limit, { min: 1 });
  const results = new Array<R>(items.length);
  const lanes = Math.min(items.length, limit === Infinity ? items.length : Math.floor(limit));
  let next = 0;
  let failed = false;

  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/** A domain lists more models than the host allows. Thrown before any model file is read. */
export class TooManyTablesError extends Error {
  constructor(readonly count: number, readonly max: number) {
    super(`The subject area lists ${count} tables; at most ${max} are allowed`);
    this.name = 'TooManyTablesError';
  }
}

/** A file is larger than the host allows. */
export class FileTooLargeError extends Error {
  constructor(readonly path: string, readonly size: number, readonly max: number) {
    super(`${path} is ${size} characters long; at most ${max} are allowed`);
    this.name = 'FileTooLargeError';
  }
}

/**
 * Options for {@link loadDisplaySubjectArea}. Each numeric limit must be a number
 * of at least 0, or `Infinity` for none (`maxParallelReads`: a whole number of
 * at least 1, or `Infinity`); any other value, NaN included, makes
 * `loadDisplaySubjectArea` reject with a TypeError before it reads anything.
 */
export interface LoadDisplaySubjectAreaOptions {
  /**
   * Path of the domain file, `{semanticDir}/{layer}/{domain}.json`, or of a
   * DBML diagram, `{semanticDir}/{layer}/diagrams/{diagram}.dbml`; `/` or `\`
   * separated.
   */
  domainPath: string;
  /**
   * Read a file's text. Resolve `null` or `undefined` when it does not exist;
   * a rejection is passed through to the caller unchanged, except for the
   * one read that only asks whether a table file exists (a Ref end whose
   * qualifier names none of the one table of its name, while its `use` line
   * names another file): a rejection there says nothing, and the end is
   * drawn as it always was.
   */
  readFile(path: string): Promise<string | null | undefined>;
  /** The DisplaySubjectArea's `readOnly` flag. */
  readOnly: boolean;
  /** Most files read at once. Default 8. */
  maxParallelReads?: number;
  /**
   * Which v5 / v6 model names may be read. A rejected name is never read and
   * renders as a placeholder. Default: `isSafeTableName`.
   */
  modelNameFilter?: (name: string) => boolean;
  /** Most entries `logical.models` (v6: `logical.tables`) may have (counted before any filtering). Default unlimited. */
  maxModels?: number;
  /**
   * Most YAML nodes one model file may expand to; a file over it renders as a
   * placeholder. A model the domain lists more than once is charged once for
   * each time it is listed, as an alias's repeats are: the listings past the
   * budget render as placeholders. Default unlimited.
   */
  maxYamlNodes?: number;
  /**
   * Longest domain file and `layers.json`, in characters. A longer domain file
   * throws `FileTooLargeError`; a longer `layers.json` is not parsed, and the
   * default layers are used instead (with a warning). Default unlimited.
   */
  maxDomainChars?: number;
  /**
   * Longest model file, in characters, both as written and once its aliases
   * are expanded (the scalar text it parses to, counting each repeat). A model
   * over either renders as a placeholder. Like `maxYamlNodes`, the expanded
   * text is charged once for each time the domain lists the model. Default
   * unlimited.
   */
  maxYamlChars?: number;
  /**
   * Place models that have no position using only the positions of the
   * domain's own models, ignoring `viewConfig.positions` entries that name no
   * model. Those entries draw nothing, but the extension's placement checks
   * every entry for every cell it tries, so a file listing many of them makes
   * placement slow; with this set, its cost depends on the model count alone.
   * The entries are still kept in the result. Default: on when any of
   * `maxModels`, `maxYamlNodes`, `maxDomainChars` or `maxYamlChars` is finite
   * (a host reading files it does not control), off otherwise, so models are
   * placed exactly as the extension places them. Placement cost is bounded
   * only when this is on and `maxModels` is finite.
   */
  ignoreStrayPositions?: boolean;
  /**
   * Receives repair warnings. Default console.warn. The second argument
   * (2.0) is always passed: the warning's fixed {@link LoaderWarningCode},
   * for a host to count or log without the message (which may name tables
   * and paths). A host written for one argument ignores it.
   */
  warn?: (message: string, code?: LoaderWarningCode) => void;
  /**
   * The DBML readers, `dbmlStorageReader` from `@erd-studio/core/dbml`.
   * Required to read a `.dbml` diagram (without it one throws a
   * `SubjectAreaValidationError` saying so). A JSON diagram is loaded
   * exactly as without it: with no directory listing, core cannot find a
   * DBML table by name, so a JSON diagram in a project half converted to
   * DBML draws those tables as missing (the extension, which lists the
   * folders, draws them). `maxYamlChars` limits a `.dbml` table file as
   * written; `maxYamlNodes` does not apply to DBML.
   */
  dbml?: DbmlStorageReader;
  /**
   * Longest relationships file a DBML diagram imports
   * (`{layer}/relationships/{file}.dbml`), in characters. A longer one is not
   * read: its relationships are not drawn, with a warning. Default unlimited.
   */
  maxRelationshipsChars?: number;
  /**
   * Find a DBML diagram member's table file by name, for a member the probe
   * misses: one with a `use` line whose path, the table folders the
   * diagram's lines name and the YAML probe all hold no file (a table moved
   * to another schema folder or layer, or its file renamed in case; GitHub
   * paths are case-sensitive). Answer the file's path relative to the
   * semantic dir (`{layer}/tables/{schema}/{name}.dbml`), or null or
   * undefined for none; any other answer, a path already probed, and a file
   * of another name are ignored, and the member is drawn as missing. A
   * rejection is passed through, like `readFile`'s. The table is read from
   * that file (its layer and schema folder too), with a warning naming both
   * paths, as the extension draws it until the next edit fixes the line.
   * A member with no `use` line (`erd_unlinked_tables`) and a JSON diagram's
   * models are never looked up. `dbmlTableFinder(paths)` builds one from a
   * listing of the tree, in the extension's lookup order. Called at most
   * once per member, within `maxParallelReads`. Default none: such a member
   * draws as missing.
   *
   * The second argument says what the stale line named: its schema folder
   * (or its specifier's qualifier), its layer and its path. A finder should
   * answer a file in another schema folder only when it is the one table of
   * that name (`dbmlTableFinder` does): another is a different table that
   * shares the name. A file another member of the diagram is read from is
   * never taken.
   */
  findDbmlTable?: (name: string, hint?: DbmlTableHint) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * Read `{semanticDir}/fields.yml` (the project's field list) and set it as
   * the result's `fields`; see the module header. Default false: the file is
   * not read and the result has no `fields` (the starting set).
   */
  readFieldsFile?: boolean;
}

/** Split a domain path into its semantic-dir prefix (with trailing separator), parent dir and file name. */
function splitSubjectAreaPath(domainPath: string): { prefix: string; parentDirName: string; fileName: string } {
  const lastSep = (s: string, end: number): number =>
    Math.max(s.lastIndexOf('/', end), s.lastIndexOf('\\', end));
  const fileSep = lastSep(domainPath, domainPath.length);
  const fileName = domainPath.slice(fileSep + 1);
  if (fileSep < 0) {
    return { prefix: '', parentDirName: '', fileName };
  }
  const dirSep = fileSep === 0 ? -1 : lastSep(domainPath, fileSep - 1);
  return {
    prefix: domainPath.slice(0, dirSep + 1),
    parentDirName: domainPath.slice(dirSep + 1, fileSep),
    fileName,
  };
}

/**
 * Split a DBML diagram's path, `{semanticDir}/{layer}/diagrams/{name}.dbml`,
 * the same way: the prefix is three segments up, and the parent the layer
 * folder (never `diagrams`). Segments are counted as `diagramPathOf` counts
 * them, so a doubled separator is no segment.
 */
function splitDiagramPath(domainPath: string, layer: string): { prefix: string; parentDirName: string; fileName: string } {
  const isSeparator = (i: number): boolean => domainPath[i] === '/' || domainPath[i] === '\\';
  let end = domainPath.length;
  for (let i = 0; i < 3; i++) {
    while (end > 0 && isSeparator(end - 1)) end--;
    while (end > 0 && !isSeparator(end - 1)) end--;
  }
  const fileSep = Math.max(domainPath.lastIndexOf('/'), domainPath.lastIndexOf('\\'));
  return { prefix: domainPath.slice(0, end), parentDirName: layer, fileName: domainPath.slice(fileSep + 1) };
}

/**
 * Whether a path relative to the semantic dir stays inside it: posix only (a
 * `\` is a separator on a Windows host, so `a\..\..` would escape), no
 * leading `..`, not absolute.
 */
function isInsideSemanticDir(rel: string): boolean {
  return rel !== '' && !rel.includes('\\') && rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/');
}

/** Byte order, locale-free. */
function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The file name without `.json`, as `path.basename(file, '.json')` gives it. */
function stripJsonExtension(fileName: string): string {
  return fileName.endsWith('.json') && fileName !== '.json' ? fileName.slice(0, -'.json'.length) : fileName;
}

/** Whether `path` names a `.dbml` file (any case). */
function isDbmlPath(path: string): boolean {
  return path.toLowerCase().endsWith('.dbml');
}


/**
 * Read a domain, its layers and its logical models through `readFile`, and
 * build the DisplaySubjectArea of its logical stage.
 *
 * Bad input rejects with one of four classes: `SubjectAreaFileError` (missing,
 * empty or non-JSON domain file), `SubjectAreaValidationError` (not a loadable
 * domain, an unconfigured layer, or a malformed v4 inline model),
 * `TooManyTablesError` and `FileTooLargeError`. A model that is missing,
 * unreadable, unsafe, too large or over the node budget renders as a
 * placeholder instead. A `readFile` rejection, and anything the caller's
 * `warn` throws, is passed through unchanged.
 *
 * That contract holds for input within the limits. With the limits left
 * unlimited, input big enough to exhaust the JavaScript engine can instead
 * fail with the engine's own error: a domain that lists on the order of
 * 100,000 positions or more, and has a model with no position, overflows the
 * call stack (a RangeError) in the extension's placement code, which is kept
 * exactly as the extension runs it. Hosts that read files they do not
 * control should set every limit; with them set, stray positions are ignored
 * and a 1 MiB domain file cannot list that many.
 *
 * The result is a fresh object; `undefined` values are left in place (a JSON
 * round-trip drops them, as `postMessage` does).
 */
export async function loadDisplaySubjectArea(options: LoadDisplaySubjectAreaOptions): Promise<DisplaySubjectArea> {
  const {
    domainPath,
    readFile,
    readOnly,
    maxParallelReads = 8,
    modelNameFilter = isSafeTableName,
    maxModels = Infinity,
    maxYamlNodes = Infinity,
    maxDomainChars = Infinity,
    maxYamlChars = Infinity,
    maxRelationshipsChars = Infinity,
    dbml,
    findDbmlTable,
    readFieldsFile = false,
  } = options;
  const sink = options.warn ?? ((message: string) => console.warn(message));
  // Every warning carries its code; one passed only a message is `other`.
  const warn = (message: string, code: LoaderWarningCode = 'other'): void => sink(message, code);

  // 0. Limits that are not numbers would silently switch themselves off.
  checkLimit('loadDisplaySubjectArea', 'maxParallelReads', maxParallelReads, { min: 1, integer: true });
  checkLimit('loadDisplaySubjectArea', 'maxModels', maxModels);
  checkLimit('loadDisplaySubjectArea', 'maxYamlNodes', maxYamlNodes);
  checkLimit('loadDisplaySubjectArea', 'maxDomainChars', maxDomainChars);
  checkLimit('loadDisplaySubjectArea', 'maxYamlChars', maxYamlChars);
  checkLimit('loadDisplaySubjectArea', 'maxRelationshipsChars', maxRelationshipsChars);
  if (findDbmlTable !== undefined && typeof findDbmlTable !== 'function') {
    throw new TypeError('loadDisplaySubjectArea: findDbmlTable must be a function');
  }
  const ignoreStrayPositions =
    options.ignoreStrayPositions ??
    [maxModels, maxYamlNodes, maxDomainChars, maxYamlChars, maxRelationshipsChars].some((limit) => limit !== Infinity);

  // 0b. A `.dbml` that is not `{layer}/diagrams/{name}.dbml` is no diagram
  // (a table or relationships file, a 1.9 pre-release file, anything else):
  // refused by its path alone, before anything is read (§1.8).
  const isDbml = isDbmlPath(domainPath);
  const diagram = isDbml ? diagramPathOf(domainPath) : undefined;
  if (isDbml) {
    if (!diagram) {
      throw new SubjectAreaValidationError(dbmlNotADiagramMessage(domainPath), 'notADiagram');
    }
    if (!dbml) {
      throw new SubjectAreaValidationError(
        `${domainPath} is a DBML diagram; pass dbml: dbmlStorageReader from '@erd-studio/core/dbml' to read it.`,
      );
    }
  }

  const { prefix, parentDirName, fileName } = diagram
    ? splitDiagramPath(domainPath, diagram.layer)
    : splitSubjectAreaPath(domainPath);
  const layersPath = `${prefix}${LAYERS_CONFIG_FILE}`;
  const readLayersText = async (): Promise<string | null | undefined> => {
    const text = await readFile(layersPath);
    if (text !== null && text !== undefined && text.length > maxDomainChars) {
      warn(`${layersPath} is ${text.length} characters long; at most ${maxDomainChars} are read. Using the default layers`, 'layersFile');
      return null;
    }
    return text;
  };
  const readFieldList = async (fieldsPath: string): Promise<FieldList | undefined> => {
    const text = await readFile(fieldsPath);
    if (text === null || text === undefined) return undefined;
    if (text.length > maxDomainChars) {
      warn(`${fieldsPath} is ${text.length} characters long; at most ${maxDomainChars} are read. Using the starting set of fields`, 'fieldsFile');
      return undefined;
    }
    const { list, problems } = parseFieldsText(text, { maxNodes: maxYamlNodes, maxChars: maxYamlChars });
    for (const problem of problems) {
      warn(`${fieldsPath}${problem.line !== undefined ? ` (line ${problem.line})` : ''}: ${problem.message}`, 'fieldsFile');
    }
    // A file that cannot be read as a field list is no list: the renderer's starting set.
    return problems.some((p) => p.code === 'fieldsYamlInvalid') ? undefined : list;
  };

  // 1-3. The domain file itself.
  const domainText = await readFile(domainPath);
  if (domainText === null || domainText === undefined) {
    throw new SubjectAreaFileError('missing', domainPath, `Subject area file not found: ${domainPath}`);
  }
  if (domainText.length > maxDomainChars) {
    throw new FileTooLargeError(domainPath, domainText.length, maxDomainChars);
  }
  let reading: ReturnType<DbmlStorageReader['parseSubjectArea']> | undefined;
  let document: unknown;
  if (isDbml && dbml) {
    reading = dbml.parseSubjectArea(domainText, domainPath);
    const codes = reading.warningCodes;
    reading.warnings.forEach((message, i) => warn(`${domainPath}: ${message}`, codes?.[i] ?? 'other'));
    document = reading.obj;
  } else {
    document = parseSubjectAreaJson(domainText, domainPath);
  }
  const { obj, format } = validateSubjectAreaDocument(document, domainPath);

  // 4-5. Layers, from the semantic dir the domain sits in.
  const layers = parseLayersText(await readLayersText(), (message) => warn(message, 'layersFile'));
  const layerLookup: LayerLookup = {
    hasLayer: (id) => layers.some((l) => l.id === id),
    getValidLayerIds: () => layers.map((l) => l.id),
  };
  const domainLayer = resolveSubjectAreaLayer(obj.layer, domainPath, parentDirName, layerLookup);

  // 5b. The field list, when asked for: right after layers.json, before any model.
  const fields = readFieldsFile ? await readFieldList(`${prefix}${FIELDS_FILE_NAME}`) : undefined;

  // 6. The model cap, on the raw list, before anything is read.
  const logical = obj.logical;
  const rawModels =
    logical && typeof logical === 'object' && !Array.isArray(logical) &&
    Array.isArray((logical as Record<string, unknown>).models)
      ? ((logical as Record<string, unknown>).models as unknown[])
      : undefined;
  if (rawModels && rawModels.length > maxModels) {
    throw new TooManyTablesError(rawModels.length, maxModels);
  }

  // 7. v5 model files: each unique, allowed name read and parsed once. A DBML
  // diagram's member is named by its reference (`uses[].ref`): its name, or
  // `<schema>.<name>` when two members share the name, each read from its own file.
  const parsed = new Map<string, ParsedTable>();
  // A DBML diagram's members: the layer of the file each was read from, by lower-case reference (§2.3).
  let tableLayers: Map<string, string> | undefined;
  // A DBML diagram's members whose reference is not their name: reference -> name.
  const tableNames = new Map<string, string>();
  if (usesTableLibrary(format) && rawModels) {
    // Each member's use line (the first, for a member listed twice), by reference.
    const memberUses = new Map<string, DbmlMemberUse>();
    for (const use of reading?.uses ?? []) {
      const ref = use.ref ?? use.name;
      if (!memberUses.has(ref)) memberUses.set(ref, use);
      if (ref !== use.name) tableNames.set(ref, use.name);
    }
    const bareName = (ref: string): string => tableNames.get(ref) ?? ref;
    const names = [...new Set(rawModels.filter((m): m is string => typeof m === 'string'))]
      .filter((name) => modelNameFilter(bareName(name)));
    // Alphabetical, like the extension's TableLibraryService, so a name that
    // (wrongly) exists in two folders resolves to the same file in both hosts.
    // (`''`, the top of the library, is always probed first.)
    const folders = [...new Set([domainLayer, ...layers.map((l) => l.id)])]
      .filter((f) => f !== '')
      .sort((a, b) => a.localeCompare(b));
    // A DBML diagram's member: the path its `use` line resolves to, then the
    // same name in each table folder its lines name (a table moved within
    // them), each relative to the semantic dir and never outside it. A file
    // another member's line points at is that member's, never this one's:
    // a table whose file is gone is drawn missing, not as its namesake.
    const ownPaths = new Map<string, string>();
    for (const [ref, use] of memberUses) {
      const path = normalisePosix(use.resolved).toLowerCase();
      if (!ownPaths.has(path)) ownPaths.set(path, ref);
    }
    const anotherMembers = (path: string, ref: string): boolean => {
      const owner = ownPaths.get(normalisePosix(path).toLowerCase());
      return owner !== undefined && owner !== ref;
    };
    const dbmlCandidates = (ref: string): string[] => {
      if (!reading) return [];
      const resolved = memberUses.get(ref)?.resolved;
      const paths = [
        ...(resolved !== undefined ? [resolved] : []),
        ...[...reading.useTableDirs].sort(byteOrder).map((dir) => `${dir}/${bareName(ref)}.dbml`),
      ];
      return [...new Set(paths)].filter((path) => isInsideSemanticDir(path) && (path === resolved || !anotherMembers(path, ref)));
    };
    // The YAML probe is a lookup by name: of members that share a name, only the first is offered it.
    const yamlProbed = new Set<string>();
    const offeredYaml = new Set(names.filter((ref) => {
      const key = bareName(ref).toLowerCase();
      if (yamlProbed.has(key)) return false;
      yamlProbed.add(key);
      return true;
    }));
    // A DBML member found as a `.dbml` file: its path relative to the semantic dir, by reference.
    const dbmlFound = new Map<string, string>();
    // Whether each `.dbml` table path read so far exists (relative to the semantic dir).
    const tableFileExists = new Map<string, boolean>();
    // Each such member's layer: the layer folder of the file it was read from.
    tableLayers = new Map<string, string>();
    // A stale use line's table in the other table folders the lines name (owner decision B, as the
    // host's finder answers): a file of the name in the line's own schema folder (its layer's first);
    // else, in another schema folder, only when one schema folder holds the name. A file another
    // member's line points at counts as holding it (that member's table, never read for this one),
    // and is never this member's. Undefined when it is drawn missing (the host's finder, if any, is
    // still asked: an answer that is another member's file or one of these folders' is ignored).
    const staleFallback = async (ref: string, name: string, use: DbmlMemberUse, schema: string, dirs: readonly string[]): Promise<{ rel: string; text: string } | undefined> => {
      const paths = [...new Set([...dirs].sort(byteOrder).map((dir) => `${dir}/${name}.dbml`))]
        .filter((path) => isInsideSemanticDir(path) && path !== use.resolved);
      const schemaOf = (path: string): string => (dbmlTreePathOf(path)?.schema ?? '').toLowerCase();
      const layerOf = (path: string): string | undefined => dbmlTreePathOf(path)?.layer;
      const probe = async (path: string): Promise<string | undefined> => {
        const text = await readFile(`${prefix}${path}`);
        tableFileExists.set(normalisePosix(path), text !== null && text !== undefined);
        return text === null || text === undefined ? undefined : text;
      };
      const own = paths.filter((path) => schemaOf(path) === schema);
      for (const path of [...own.filter((p) => layerOf(p) === use.layer), ...own.filter((p) => layerOf(p) !== use.layer)]) {
        if (anotherMembers(path, ref)) return undefined;
        const text = await probe(path);
        if (text !== undefined) return { rel: path, text };
      }
      let first: { rel: string; text?: string } | undefined;
      for (const path of paths.filter((p) => schemaOf(p) !== schema)) {
        if (first !== undefined && schemaOf(path) === schemaOf(first.rel)) continue;
        const text = anotherMembers(path, ref) ? undefined : await probe(path);
        if (text === undefined && !anotherMembers(path, ref)) continue;
        if (first !== undefined) {
          warn(`Table "${name}" is not at its use line's path (${use.resolved}), and more than one other schema folder has a table of that name: it is drawn missing until the line is fixed`);
          return undefined;
        }
        first = { rel: path, ...(text !== undefined ? { text } : {}) };
      }
      return first?.text === undefined ? undefined : { rel: first.rel, text: first.text };
    };
    await mapWithLimit(names, maxParallelReads, async (ref) => {
      const name = bareName(ref);
      const use = memberUses.get(ref);
      // One lane probes one candidate at a time, so maxParallelReads holds.
      const dbmlPaths = dbmlCandidates(ref);
      // `logical-models/` then `tables/` (#162), each top level first: YAML only.
      const yamlPaths = offeredYaml.has(ref) ? tableFileCandidates(prefix, name, folders) : [];
      let text: string | null | undefined;
      // The `.dbml` file it was read from (relative to the semantic dir), else the YAML file's path.
      let dbmlRel: string | undefined;
      let yamlPath: string | undefined;
      // A stale use line that says its schema folder is looked for by owner decision B.
      const schema = (use?.schema ?? use?.qualifier ?? '').toLowerCase();
      if (use !== undefined && reading && schema !== '' && dbmlPaths[0] === use.resolved) {
        text = await readFile(`${prefix}${use.resolved}`);
        tableFileExists.set(normalisePosix(use.resolved), text !== null && text !== undefined);
        if (text !== null && text !== undefined) {
          dbmlRel = use.resolved;
        } else {
          const found = await staleFallback(ref, name, use, schema, reading.useTableDirs);
          if (found !== undefined) ({ rel: dbmlRel, text } = found);
        }
      } else {
        for (let i = 0; (text === null || text === undefined) && i < dbmlPaths.length; i++) {
          text = await readFile(`${prefix}${dbmlPaths[i]}`);
          tableFileExists.set(normalisePosix(dbmlPaths[i]), text !== null && text !== undefined);
          if (text !== null && text !== undefined) dbmlRel = dbmlPaths[i];
        }
      }
      for (let i = 0; (text === null || text === undefined) && i < yamlPaths.length; i++) {
        text = await readFile(yamlPaths[i]);
        if (text !== null && text !== undefined) yamlPath = yamlPaths[i];
      }
      let foundRel: string | undefined;
      if ((text === null || text === undefined) && findDbmlTable && use !== undefined) {
        // A member whose use line is stale: the file the host finds by name, if any, told what the line said.
        const schema = use.schema ?? use.qualifier;
        const hint: DbmlTableHint = {
          ...(schema !== undefined ? { schema } : {}),
          ...(use.layer !== undefined ? { layer: use.layer } : {}),
          stalePath: use.resolved,
        };
        const rel = await findDbmlTable(name, hint);
        const tree = typeof rel === 'string' ? dbmlTreePathOf(rel) : undefined;
        const normalised = tree?.kind === 'table' ? normalisePosix(rel as string) : undefined;
        if (normalised !== undefined && tree!.name.trim().toLowerCase() === name.trim().toLowerCase()
          && !dbmlPaths.includes(normalised) && !anotherMembers(normalised, ref)) {
          text = await readFile(`${prefix}${normalised}`);
          if (text !== null && text !== undefined) {
            foundRel = normalised;
            warn(`Table "${name}" is not at its use line's path (${use.resolved}); it was read from ${normalised}. The next ERD Studio edit fixes the line`);
          }
        }
      }
      if (text === null || text === undefined) {
        parsed.set(ref, NO_TABLE);
        return;
      }
      const path = foundRel !== undefined ? `${prefix}${foundRel}` : dbmlRel !== undefined ? `${prefix}${dbmlRel}` : yamlPath!;
      if (dbml && (foundRel !== undefined || dbmlRel !== undefined)) {
        const rel = (foundRel ?? dbmlRel)!;
        if (foundRel === undefined && use !== undefined && rel !== use.resolved) {
          // Found by name in another folder the lines name: say so, as for a file the host finds.
          warn(`Table "${name}" is not at its use line's path (${use.resolved}); it was read from ${rel}. The next ERD Studio edit fixes the line`);
        }
        dbmlFound.set(ref, rel);
        // Its schema folder, the schema of an unqualified Table (§1.2), and its layer.
        const tree = dbmlTreePathOf(rel);
        const schemaFolder = tree?.schema;
        if (tree) tableLayers?.set(ref.toLowerCase(), tree.layer);
        parsed.set(ref, named(parseDbmlTable(name, text, dbml, maxYamlChars, warn, schemaFolder), ref, tableNames.has(ref)));
        return;
      }
      // The YAML table's own warnings (a parse error, say) follow the mixed-state one.
      const parseWarnings: Array<[string, LoaderWarningCode | undefined]> = [];
      const table = parseTable(name, text, maxYamlChars, maxYamlNodes, (m, code) => parseWarnings.push([m, code]));
      // An empty file, or one with no name:, is no table: it is drawn as missing, and says so below.
      if (reading && (table.model !== null || table.loadError !== undefined)) {
        warn(`Table "${name}" is a YAML table (${path}); the DBML diagram shows it, but run ERD Studio: Convert Project to DBML before editing its relationships (fix the file first if Convert leaves it as it is)`, 'yamlTableInDbml');
      }
      for (const [m, code] of parseWarnings) warn(m, code);
      parsed.set(ref, named(table, ref, tableNames.has(ref)));
    });

    // 7a. An older version kept one bare `erd_layout` line for two members of
    // one name, and the reader gave it to the first. When that one's file is
    // gone and the other's was read, the place is the other's (the table the
    // line was written for), unless that one has its own line.
    const positions = (obj.viewConfig as { positions?: Record<string, NodePosition> } | undefined)?.positions;
    for (const ref of reading?.layoutSharedBare ?? []) {
      const place = positions?.[ref];
      if (!positions || !place || parsed.get(ref)?.model || parsed.get(ref)?.loadError) continue;
      const heir = names.find((other) => other !== ref && bareName(other).toLowerCase() === bareName(ref).toLowerCase()
        && parsed.get(other)?.model && !Object.prototype.hasOwnProperty.call(positions, other));
      if (heir === undefined) continue;
      delete positions[ref];
      Object.defineProperty(positions, heir, { value: place, enumerable: true, writable: true, configurable: true });
    }

    // 7b. A DBML diagram's relationships: the relationships files it imports,
    // and no other (another DBML tool draws no more), attached to the members
    // read (§1.4, §2.3).
    if (dbml && reading) {
      const relPaths = reading.relationshipsUses.filter(isInsideSemanticDir).sort(byteOrder);
      const readings = (await mapWithLimit(relPaths, maxParallelReads, async (rel): Promise<DbmlAttachReading | undefined> => {
        const path = `${prefix}${rel}`;
        const text = await readFile(path);
        if (text === null || text === undefined) {
          warn(`${domainPath}: imports ${rel}, which does not exist; its relationships are not drawn`, 'relationshipsFileMissing');
          return undefined;
        }
        if (text.length > maxRelationshipsChars) {
          warn(`${path} is larger than the limit; its relationships are not drawn (${text.length} characters; at most ${maxRelationshipsChars} are read)`);
          return undefined;
        }
        const relReading: DbmlRelationshipsReading = dbml.readRelationships(text);
        for (const problem of relReading.problems) warn(`${path}: ${problem.message}`);
        return { path, reading: relReading, semanticPath: rel };
      })).filter((r): r is DbmlAttachReading => r !== undefined);
      if (readings.length > 0) {
        const entries: DbmlAttachTable[] = [];
        for (const [ref, entry] of parsed) {
          if (!entry.model) continue;
          const rel = dbmlFound.get(ref);
          const schema = rel !== undefined ? dbmlTreePathOf(rel)?.schema : undefined;
          const tableName = tableNameOf(entry.model);
          entries.push({
            // Matched by its own name; ends name it by its reference.
            table: tableName !== undefined ? { ...entry.model, name: tableName } : entry.model,
            storage: rel !== undefined ? 'dbml' : 'yaml',
            ...(entry.dbmlAlias !== undefined ? { dbmlAlias: entry.dbmlAlias } : {}),
            ...(tableName !== undefined ? { ref } : {}),
            ...(rel !== undefined ? { path: rel } : {}),
            ...(schema !== undefined ? { schema } : {}),
          });
        }
        // A Ref end whose qualifier names none of the one member of its name, while its own use line
        // names another file: one read of that file says whether the end means a table elsewhere. One
        // with no use line of its own: a read of its name in each table folder the diagram's and the
        // relationships file's lines name, and in the qualifier's own folder, says whether another table
        // has the name (then the qualifier says neither is the member's). Only such an end costs a read
        // (none in a project whose qualifiers match); a read that fails says nothing.
        // A path a member was already looked for at is known (a stale use line's own path, say).
        const tableDirs = reading.useTableDirs;
        const probes = contestedUsePaths(readings, entries, { tableDirs }).filter((rel) => isInsideSemanticDir(rel) && !tableFileExists.has(rel));
        // A probed file's text, so a Ref end two use lines spell alike can be told apart by its columns.
        const probedText = new Map<string, string>();
        await mapWithLimit(probes, maxParallelReads, async (rel) => {
          try {
            const text = await readFile(`${prefix}${rel}`);
            tableFileExists.set(rel, text !== null && text !== undefined);
            if (typeof text === 'string') probedText.set(rel, text);
          } catch {
            // Unknown: the end stays on the one table of its name, as it always drew.
          }
        });
        // A contested path that is gone (the table moved): the host's finder, asked as for a stale member
        // line, says where the table of that name and schema now is. When that is not the one table of
        // its name on this diagram (or nowhere one table says), the end means a table elsewhere, as the
        // extension, which lists the library, reads it. A finder that cannot tell changes nothing.
        const elsewhere = new Set<string>();
        if (findDbmlTable) {
          const gone = probes.filter((rel) => tableFileExists.get(rel) === false);
          await mapWithLimit(gone, maxParallelReads, async (rel) => {
            const tree = dbmlTreePathOf(rel);
            if (tree?.kind !== 'table' || tree.name === undefined) return;
            let found: string | null | undefined;
            try {
              found = await findDbmlTable(tree.name, {
                ...(tree.schema !== undefined ? { schema: tree.schema } : {}),
                ...(tree.layer !== undefined ? { layer: tree.layer } : {}),
                stalePath: rel,
              });
            } catch {
              return;
            }
            if (found === undefined) return;
            const lowerName = tree.name.trim().toLowerCase();
            const own = entries.filter((e) => e.path !== undefined && e.table.name.toLowerCase() === lowerName).map((e) => normalisePosix(e.path!).toLowerCase());
            // The same schema folder and name in another layer is the same table (a duplicate), not another one.
            const ownIds = own.map((p) => tableIdOfPath(p)).filter((id) => id !== undefined).map((id) => tableIdKey(id!));
            const foundId = found === null ? undefined : tableIdOfPath(normalisePosix(found));
            if (found === null || (!own.includes(normalisePosix(found).toLowerCase()) && (foundId === undefined || !ownIds.includes(tableIdKey(foundId))))) elsewhere.add(rel);
          });
        }
        // Only the members were read, so a Ref whose owner is off this
        // diagram (or did not read) is no orphan here (§2.4: `partial`).
        // A probed table's columns (rule 0 of the lookup): read once, only when an end asks.
        const probedColumns = new Map<string, readonly string[] | undefined>();
        const columnsAt = (rel: string): readonly string[] | undefined => {
          const key = normalisePosix(rel);
          if (probedColumns.has(key)) return probedColumns.get(key);
          const text = probedText.get(key);
          let columns: readonly string[] | undefined;
          if (text !== undefined && dbml && text.length <= maxYamlChars) {
            try {
              const tree = dbmlTreePathOf(key);
              const stem = tree?.name ?? key.slice(key.lastIndexOf('/') + 1).replace(/\.dbml$/i, '');
              const read = dbml.parseTable(text, stem, tree?.schema !== undefined ? { schemaFolder: tree.schema } : undefined);
              columns = read.ok ? (read.table.columns ?? []).map((c) => c.name) : undefined;
            } catch {
              columns = undefined;
            }
          }
          probedColumns.set(key, columns);
          return columns;
        };
        const lookup = dbmlTableLookup(entries, { tableDirs, exists: (rel) => tableFileExists.get(normalisePosix(rel)) === true || elsewhere.has(normalisePosix(rel)), columnsAt });
        const attached = attachRelationships(readings, lookup, { partial: true });
        for (const message of attached.warnings) warn(message);
        // A Ref whose other end names a table that more than one schema folder has, with nothing to say which,
        // is reported and not drawn: its bare name would land on whichever member bears it here.
        const ambiguousAt = new Set((attached.unresolved ?? []).filter((u) => u.kind === 'ambiguous').map((u) => `${u.path}\u0000${u.line}`));
        for (const [ref, entry] of parsed) {
          if (!entry.model || !dbmlFound.has(ref)) continue;
          // A member's relationships are keyed by what ends call it: its reference, or (as before identities) its name.
          const owner = tableNameOf(entry.model) !== undefined ? ref : entry.model.name;
          let relationships = attached.byOwner.get(owner.toLowerCase());
          if (relationships && ambiguousAt.size > 0) {
            relationships = relationships.filter((rel) => {
              const at = attached.locations?.get(linkKey({ ...rel, fromModel: owner }));
              return at === undefined || !ambiguousAt.has(`${at.path}\u0000${at.line}`);
            });
          }
          if (relationships && relationships.length > 0) entry.model.relationships = relationships;
        }
      }
    }
  }

  // 8-10 build what the file describes. The inline models of a v4 domain
  // reach them as written, and a malformed one (`columns` that is not a list,
  // a column that is null) throws a TypeError partway through, exactly as it
  // does in the extension. Here that is reported as the invalid domain it is.
  // A TypeError thrown by the caller's `warn` is passed through as it is.
  const callerErrors = new WeakSet<object>();
  const callerWarn = (message: string, code?: LoaderWarningCode): void => {
    try {
      warn(message, code);
    } catch (err) {
      if (err !== null && typeof err === 'object') {
        callerErrors.add(err);
      }
      throw err;
    }
  };
  try {
    return buildDisplaySubjectArea(obj, format, {
      domainPath,
      fileName,
      parentDirName,
      layers,
      layerLookup,
      parsed,
      readOnly,
      ignoreStrayPositions,
      warn: callerWarn,
      ...(reading ? { schemaVersion: reading.schemaVersion, domainNameFallback: fileName.slice(0, -'.dbml'.length) } : {}),
      ...(tableLayers && tableLayers.size > 0 ? { tableLayers } : {}),
      ...(tableNames.size > 0 ? { tableNames } : {}),
      ...(fields ? { fields } : {}),
    });
  } catch (err) {
    if (err instanceof TypeError && !callerErrors.has(err)) {
      const invalid = new SubjectAreaValidationError(`${domainPath} is not a loadable subject area: ${err.message}`);
      // As `new Error(message, { cause })` sets it (that form needs ES2022 lib typings).
      Object.defineProperty(invalid, 'cause', { value: err, writable: true, configurable: true });
      throw invalid;
    }
    throw err;
  }
}

/** Steps 8-10 of {@link loadDisplaySubjectArea}: the parsed files -> the DisplaySubjectArea. */
function buildDisplaySubjectArea(
  obj: Record<string, unknown>,
  format: SubjectAreaFormat,
  ctx: {
    domainPath: string;
    fileName: string;
    parentDirName: string;
    layers: LayerConfig[];
    layerLookup: LayerLookup;
    parsed: ReadonlyMap<string, ParsedTable>;
    readOnly: boolean;
    ignoreStrayPositions: boolean;
    warn: (message: string, code?: LoaderWarningCode) => void;
    /** A DBML diagram's own version (D8), applied to the Unified and Display `schemaVersion` only. */
    schemaVersion?: number;
    /** The name when the file names none (a DBML diagram's stem). */
    domainNameFallback?: string;
    /** A DBML diagram's members: the layer of the file each was read from, by lower-case reference. */
    tableLayers?: ReadonlyMap<string, string>;
    /** A DBML diagram's members whose reference is not their name (`<schema>.<name>`): reference -> name. */
    tableNames?: ReadonlyMap<string, string>;
    /** The project's field list (`readFieldsFile`), when its fields.yml was read. */
    fields?: FieldList;
  },
): DisplaySubjectArea {
  const { domainPath, fileName, parentDirName, layers, layerLookup, parsed, readOnly, ignoreStrayPositions, warn } = ctx;

  // 8. The UnifiedSubjectArea, each occurrence of a model its own copy (sharing
  // the parsed strings, which are immutable, so repeats cost no text). Each
  // copy is charged to the file's budgets, so listing one model many times
  // cannot expand the result past what the budgets allow one file.
  const listed = new Map<string, number>();
  const unified = buildUnifiedSubjectArea(obj, format, {
    filePath: domainPath,
    domainNameFallback: ctx.domainNameFallback ?? stripJsonExtension(fileName),
    parentDirName,
    layers: layerLookup,
    getModel: (name) => {
      const entry = parsed.get(name);
      if (!entry?.model) {
        return null;
      }
      const occurrence = (listed.get(name) ?? 0) + 1;
      listed.set(name, occurrence);
      if (occurrence > entry.copies) {
        if (occurrence === entry.copies + 1) {
          warn(`Model "${name}" is listed more times than its file's budget allows; only the first ${entry.copies} are read`);
        }
        return null;
      }
      return copyPlain(entry.model);
    },
    getModelError: (name) => parsed.get(name)?.loadError ?? null,
    warn,
  });
  if (ctx.schemaVersion !== undefined) unified.schemaVersion = ctx.schemaVersion;

  // 9. Positions for models that have none.
  const computed = computeMissingPositions(
    ignoreStrayPositions
      ? { ...unified, viewConfig: { positions: tablePositions(unified.viewConfig.positions, unified.logical.models) } }
      : unified,
  );
  if (computed) {
    unified.viewConfig.positions = { ...(unified.viewConfig.positions ?? {}), ...computed };
  }

  // 10. The logical stage, as the canvas renders it: each DBML table with
  // the layer it was read from, and every layer, so a table from another
  // layer is drawn in that layer's colour.
  const display = toDisplaySubjectArea(toLogicalStage(unified), {
    viewConfig: unified.viewConfig,
    stubColumns: unified.stubColumns,
    layerConfig: layers.find((l) => l.id === unified.layer),
    readOnly,
    ...(ctx.fields ? { fields: ctx.fields } : {}),
  });
  const layerOf = (name: string): string | undefined => ctx.tableLayers?.get(name.toLowerCase());
  // A member named `<schema>.<name>` keeps its own name beside it, a placeholder for a missing one too.
  const withName = (m: DisplaySubjectArea['models'][number]): DisplaySubjectArea['models'][number] => {
    const tableName = ctx.tableNames?.get(m.name);
    if (tableName === undefined || m.tableName !== undefined) return m;
    const { name, ...rest } = m;
    return { name, tableName, ...rest };
  };
  const named = ctx.tableNames ? { ...display, models: display.models.map(withName) } : display;
  if (!named.models.some((m) => layerOf(m.name) !== undefined)) return named;
  return {
    ...named,
    layerConfigs: ctx.layers.map((l) => ({ ...l })),
    models: named.models.map((m) => {
      const layer = layerOf(m.name);
      return layer !== undefined ? { ...m, layer } : m;
    }),
  };
}

/** The entries of `positions` that name one of `models`. */
function tablePositions(
  positions: Record<string, NodePosition> | undefined,
  models: ReadonlyArray<{ name: string }>,
): Record<string, NodePosition> | undefined {
  if (!positions) {
    return positions;
  }
  const kept: Record<string, NodePosition> = {};
  for (const { name } of models) {
    if (Object.prototype.hasOwnProperty.call(positions, name)) {
      kept[name] = positions[name];
    }
  }
  return kept;
}

/**
 * A deep copy of plain JSON-shaped data (objects, arrays, primitives), as
 * `structuredClone` would make it, except that strings are shared rather than
 * copied. A parsed model's strings can be long, and repeated through aliases.
 * Every key is copied as an own property: a `meta` key may be any text,
 * `__proto__` included (see `setMetaEntry`), and plain assignment would drop
 * that one (or, for a map value, make it the copy's prototype).
 */
function copyPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(copyPlain) as T;
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(copy, key, { value: copyPlain(item), enumerable: true, writable: true, configurable: true });
    }
    return copy as T;
  }
  return value;
}

/** A parsed model file, and how many times the domain may list it within the file's budgets. */
interface ParsedTable {
  /** The model, or null (a placeholder) when the file is absent, too large or unusable. */
  model: SemanticTable | null;
  /** How many listings of the model get a copy; the rest are placeholders. */
  copies: number;
  /** Set when the file exists but fails to parse (never for a budget refusal). */
  loadError?: TableLoadError;
  /** A `.dbml` table's DBML alias (`Table fct_order as FO`), which Ref ends may use. */
  dbmlAlias?: string;
}

const NO_TABLE: ParsedTable = { model: null, copies: 0 };

/**
 * `table` as the diagram names it: unchanged when `ref` is the name it was
 * read under; else (a member named `<schema>.<name>` because another member
 * shares its name) named `ref`, with its own name kept as `tableName`, which
 * the canvas labels it by and dbt knows it by.
 */
function named(table: ParsedTable, ref: string, sharesName: boolean): ParsedTable {
  if (!table.model || !sharesName) return table;
  const model: DiagramNamedTable = { ...table.model, name: ref, tableName: table.model.name };
  return { ...table, model };
}

/** Parse one model file's text, charging it to the budgets. */
function parseTable(
  name: string,
  text: string | null | undefined,
  maxChars: number,
  maxNodes: number,
  warn: (message: string, code?: LoaderWarningCode) => void,
): ParsedTable {
  if (text === null || text === undefined) {
    return NO_TABLE;
  }
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`, 'modelUnreadable');
    return NO_TABLE;
  }
  try {
    const { model, nodes, chars } = parseTableTextWithUsage(text, name, { maxNodes, maxChars, duplicateKeys: 'last' });
    // A budget that was not counted (unlimited) or not used allows any number of copies.
    const fits = (max: number, used: number): number => (used > 0 ? Math.floor(max / used) : Infinity);
    return { model, copies: Math.min(fits(maxNodes, nodes), fits(maxChars, chars)) };
  } catch (err) {
    warn(`Failed to read model "${name}": ${err instanceof Error ? err.message : String(err)}`, 'modelUnreadable');
    if (err instanceof YamlNodeLimitError || err instanceof YamlCharLimitError) {
      return NO_TABLE;
    }
    const { kind, line, mergeConflict } = classifyTableLoadError(err);
    return { ...NO_TABLE, loadError: { kind, ...(line !== undefined ? { line } : {}), ...(mergeConflict ? { mergeConflict } : {}) } };
  }
}

/** Parse one `.dbml` table file's text (`schemaFolder`: its `{layer}/tables/{schema}` folder), charging it (as written) to the character budget. */
function parseDbmlTable(
  name: string,
  text: string,
  dbml: DbmlStorageReader,
  maxChars: number,
  warn: (message: string, code?: LoaderWarningCode) => void,
  schemaFolder: string | undefined,
): ParsedTable {
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`, 'modelUnreadable');
    return NO_TABLE;
  }
  const reading = dbml.parseTable(text, name, schemaFolder !== undefined ? { schemaFolder } : undefined);
  if (!reading.ok) {
    warn(`Failed to read model "${name}": ${reading.error.message}`, 'modelUnreadable');
    const { kind, line, mergeConflict, code, target } = reading.error;
    return {
      ...NO_TABLE,
      loadError: {
        kind,
        ...(line !== undefined ? { line } : {}),
        ...(mergeConflict ? { mergeConflict } : {}),
        ...(code !== undefined ? { code } : {}),
        ...(target !== undefined ? { target } : {}),
      },
    };
  }
  for (const problem of reading.problems) warn(`Model "${name}": ${problem.message}`);
  const copies = maxChars === Infinity || text.length === 0 ? Infinity : Math.floor(maxChars / text.length);
  return { model: reading.table, copies, ...(reading.alias !== undefined ? { dbmlAlias: reading.alias } : {}) };
}
