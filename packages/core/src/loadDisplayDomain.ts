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
 * Everything the files say is validated and repaired by the same functions
 * the extension host uses. The limits in the options exist for hosts that
 * read files they do not control; all of them are off by default.
 */

import type { DisplaySubjectArea } from './types/display.js';
import type { SubjectAreaFormat, TableLoadError, NodePosition, SemanticTable } from './types/semantic.js';
import { usesTableLibrary } from './types/semantic.js';
import type { DbmlAttachTable, DbmlRelationshipsReading, DbmlStorageReader } from './types/dbmlStorage.js';
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
import { TABLES_DIR, YamlCharLimitError, YamlNodeLimitError, isSafeTableName, parseTableTextWithUsage } from './logicalModel.js';
import { DBML_RELATIONSHIPS_FILE_NAME, DBML_RELATIONSHIPS_FILE_STEM } from './dbmlRichProperties.js';
import { tableFileCandidates } from './storage.js';
import { attachRelationships, dbmlTableLookup } from './dbmlAttach.js';
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
  /** Path of the domain file, `{semanticDir}/{layer}/{domain}.json`; `/` or `\` separated. */
  domainPath: string;
  /**
   * Read a file's text. Resolve `null` or `undefined` when it does not exist;
   * a rejection is passed through to the caller unchanged.
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
  /** Receives repair warnings. Default console.warn. */
  warn?: (message: string) => void;
  /**
   * The DBML readers, `dbmlStorageReader` from `@erd-studio/core/dbml`.
   * Required to read a `.dbml` diagram (without it one throws a
   * `SubjectAreaValidationError` saying so). With it, a JSON diagram also
   * finds tables stored as `.dbml` in `tables/` and draws their
   * relationships; without it, JSON loading is exactly what it was.
   * `maxYamlChars` limits a `.dbml` table file as written; `maxYamlNodes`
   * does not apply to DBML.
   */
  dbml?: DbmlStorageReader;
  /**
   * Longest relationships file (`tables/[<folder>/]_relationships.dbml`), in
   * characters. A longer one is not read: its relationships are not drawn,
   * with a warning. Default unlimited.
   */
  maxRelationshipsChars?: number;
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

/** The file name without `.json`, as `path.basename(file, '.json')` gives it. */
function stripJsonExtension(fileName: string): string {
  return fileName.endsWith('.json') && fileName !== '.json' ? fileName.slice(0, -'.json'.length) : fileName;
}

/** Whether `path` names a `.dbml` file (any case). */
function isDbmlPath(path: string): boolean {
  return path.toLowerCase().endsWith('.dbml');
}

/** The last segment of a prefix such as `.erd-studio/tables/` (`tables`), or `''`. */
function lastSegment(prefix: string): string {
  const segments = prefix.split(/[\\/]/).filter((s) => s !== '');
  return segments[segments.length - 1] ?? '';
}

function notADiagram(domainPath: string): SubjectAreaValidationError {
  return new SubjectAreaValidationError(
    `${domainPath} is a DBML table or relationships file, not a diagram. Open a diagram in a layer folder.`,
  );
}

/** One table file found for a listed name, before it is turned into the model the domain shows. */
interface FoundTable {
  /** The path read. */
  path: string;
  text: string;
  /** The library folder of a `tables/` file (`''` at the top), else undefined. */
  folder?: string;
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
  } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // 0. Limits that are not numbers would silently switch themselves off.
  checkLimit('loadDisplaySubjectArea', 'maxParallelReads', maxParallelReads, { min: 1, integer: true });
  checkLimit('loadDisplaySubjectArea', 'maxModels', maxModels);
  checkLimit('loadDisplaySubjectArea', 'maxYamlNodes', maxYamlNodes);
  checkLimit('loadDisplaySubjectArea', 'maxDomainChars', maxDomainChars);
  checkLimit('loadDisplaySubjectArea', 'maxYamlChars', maxYamlChars);
  checkLimit('loadDisplaySubjectArea', 'maxRelationshipsChars', maxRelationshipsChars);
  const ignoreStrayPositions =
    options.ignoreStrayPositions ??
    [maxModels, maxYamlNodes, maxDomainChars, maxYamlChars, maxRelationshipsChars].some((limit) => limit !== Infinity);

  const { prefix, parentDirName, fileName } = splitSubjectAreaPath(domainPath);
  const layersPath = `${prefix}${LAYERS_CONFIG_FILE}`;
  const readLayersText = async (): Promise<string | null | undefined> => {
    const text = await readFile(layersPath);
    if (text !== null && text !== undefined && text.length > maxDomainChars) {
      warn(`${layersPath} is ${text.length} characters long; at most ${maxDomainChars} are read. Using the default layers`);
      return null;
    }
    return text;
  };

  // 0b. A `.dbml` table or relationships file is not a diagram (§4.4). No
  // `.dbml` under `tables/` is ever a diagram: with DBML evidence there,
  // `tables/` is either the library (a table file) or a YAML project's
  // listed layer (its `.dbml` files are `other`), the two answers
  // `classifySemanticFile` gives (§3.3, §3.5). So core needs no listing.
  const isDbml = isDbmlPath(domainPath);
  if (isDbml) {
    const stem = fileName.slice(0, -'.dbml'.length);
    if (stem.toLowerCase() === DBML_RELATIONSHIPS_FILE_STEM || lastSegment(prefix) === TABLES_DIR || parentDirName === TABLES_DIR) {
      throw notADiagram(domainPath);
    }
    if (!dbml) {
      throw new SubjectAreaValidationError(
        `${domainPath} is a DBML diagram; pass dbml: dbmlStorageReader from '@erd-studio/core/dbml' to read it.`,
      );
    }
  }

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
    for (const message of reading.warnings) warn(`${domainPath}: ${message}`);
    document = reading.obj;
  } else {
    document = parseSubjectAreaJson(domainText, domainPath);
  }
  const { obj, format } = validateSubjectAreaDocument(document, domainPath);

  // 4-5. Layers, from the semantic dir the domain sits in.
  const layers = parseLayersText(await readLayersText(), warn);
  const layerLookup: LayerLookup = {
    hasLayer: (id) => layers.some((l) => l.id === id),
    getValidLayerIds: () => layers.map((l) => l.id),
  };
  const domainLayer = resolveSubjectAreaLayer(obj.layer, domainPath, parentDirName, layerLookup);

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

  // 7. v5 model files: each unique, allowed name read and parsed once.
  const parsed = new Map<string, ParsedTable>();
  if (usesTableLibrary(format) && rawModels) {
    const names = [...new Set(rawModels.filter((m): m is string => typeof m === 'string'))]
      .filter((name) => modelNameFilter(name));
    // Alphabetical, like the extension's TableLibraryService, so a name that
    // (wrongly) exists in two folders resolves to the same file in both hosts.
    // (`''`, the top of the library, is always probed first.)
    const folders = [...new Set([domainLayer, ...layers.map((l) => l.id)])]
      .filter((f) => f !== '')
      .sort((a, b) => a.localeCompare(b));
    // `logical-models/` then `tables/` (#162), each top level first.
    // 2.0-switch: S4b reads a DBML diagram's members from its resolved `use` paths
    // (`reading.uses`, then `reading.useTableDirs`); until then only the YAML probe runs.
    const found = new Map<string, FoundTable>();
    await mapWithLimit(names, maxParallelReads, async (name) => {
      // One lane probes one candidate at a time, so maxParallelReads holds.
      const candidates = tableFileCandidates(prefix, name, folders);
      let text: string | null | undefined;
      let path = '';
      for (let i = 0; (text === null || text === undefined) && i < candidates.length; i++) {
        path = candidates[i];
        text = await readFile(path);
      }
      if (text === null || text === undefined) {
        parsed.set(name, NO_TABLE);
        return;
      }
      if (dbml && isDbmlPath(path)) {
        const folder = path.slice(`${prefix}${TABLES_DIR}/`.length).split('/').slice(0, -1)[0] ?? '';
        found.set(name, { path, text, folder });
        parsed.set(name, parseDbmlTable(name, text, dbml, maxYamlChars, warn));
        return;
      }
      // The YAML table's own warnings (a parse error, say) follow the mixed-state one.
      const parseWarnings: string[] = [];
      const table = parseTable(name, text, maxYamlChars, maxYamlNodes, (m) => parseWarnings.push(m));
      // An empty file, or one with no name:, is no table: it is drawn as missing, and says so below.
      if (reading && (table.model !== null || table.loadError !== undefined)) {
        warn(`Table "${name}" is a YAML table (${path}); the DBML diagram shows it, but run ERD Studio: Convert Project to DBML before editing its relationships (fix the file first if Convert leaves it as it is)`);
      }
      for (const m of parseWarnings) warn(m);
      parsed.set(name, table);
    });

    // 7b. DBML relationships: every relationships file in the probe set,
    // attached to the DBML tables read (§2.4, §4.4 step 6).
    if (dbml && (reading !== undefined || found.size > 0)) {
      const relPaths = ['', ...folders].map((f) => `${prefix}${TABLES_DIR}/${f === '' ? '' : `${f}/`}${DBML_RELATIONSHIPS_FILE_NAME}`);
      const readings = (await mapWithLimit(relPaths, maxParallelReads, async (path, i) => {
        const text = await readFile(path);
        if (text === null || text === undefined) return undefined;
        if (text.length > maxRelationshipsChars) {
          warn(`${path} is larger than the limit; its relationships are not drawn (${text.length} characters; at most ${maxRelationshipsChars} are read)`);
          return undefined;
        }
        const relReading: DbmlRelationshipsReading = dbml.readRelationships(text);
        for (const problem of relReading.problems) warn(`${path}: ${problem.message}`);
        return { path, folder: i === 0 ? '' : folders[i - 1], reading: relReading };
      })).filter((r): r is NonNullable<typeof r> => r !== undefined);
      if (readings.length > 0) {
        const entries: DbmlAttachTable[] = [];
        for (const [name, entry] of parsed) {
          if (!entry.model) continue;
          const dbmlFile = found.get(name);
          entries.push({
            table: entry.model,
            folder: dbmlFile?.folder ?? '',
            storage: dbmlFile ? 'dbml' : 'yaml',
            ...(entry.dbmlAlias !== undefined ? { dbmlAlias: entry.dbmlAlias } : {}),
          });
        }
        // Only the members were read, so a Ref whose owner is off this
        // diagram (or did not read) is no orphan here (§2.4: `partial`).
        const attached = attachRelationships(readings, dbmlTableLookup(entries), { partial: true });
        for (const message of attached.warnings) warn(message);
        for (const [name, entry] of parsed) {
          if (!entry.model || !found.has(name)) continue;
          const relationships = attached.byOwner.get(entry.model.name.toLowerCase());
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
  const callerWarn = (message: string): void => {
    try {
      warn(message);
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
    warn: (message: string) => void;
    /** A DBML diagram's own version (D8), applied to the Unified and Display `schemaVersion` only. */
    schemaVersion?: number;
    /** The name when the file names none (a DBML diagram's stem). */
    domainNameFallback?: string;
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

  // 10. The logical stage, as the canvas renders it.
  return toDisplaySubjectArea(toLogicalStage(unified), {
    viewConfig: unified.viewConfig,
    stubColumns: unified.stubColumns,
    layerConfig: layers.find((l) => l.id === unified.layer),
    readOnly,
  });
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

/** Parse one model file's text, charging it to the budgets. */
function parseTable(
  name: string,
  text: string | null | undefined,
  maxChars: number,
  maxNodes: number,
  warn: (message: string) => void,
): ParsedTable {
  if (text === null || text === undefined) {
    return NO_TABLE;
  }
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`);
    return NO_TABLE;
  }
  try {
    const { model, nodes, chars } = parseTableTextWithUsage(text, name, { maxNodes, maxChars, duplicateKeys: 'last' });
    // A budget that was not counted (unlimited) or not used allows any number of copies.
    const fits = (max: number, used: number): number => (used > 0 ? Math.floor(max / used) : Infinity);
    return { model, copies: Math.min(fits(maxNodes, nodes), fits(maxChars, chars)) };
  } catch (err) {
    warn(`Failed to read model "${name}": ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof YamlNodeLimitError || err instanceof YamlCharLimitError) {
      return NO_TABLE;
    }
    const { kind, line, mergeConflict } = classifyTableLoadError(err);
    return { ...NO_TABLE, loadError: { kind, ...(line !== undefined ? { line } : {}), ...(mergeConflict ? { mergeConflict } : {}) } };
  }
}

/** Parse one `.dbml` table file's text, charging it (as written) to the character budget. */
function parseDbmlTable(
  name: string,
  text: string,
  dbml: DbmlStorageReader,
  maxChars: number,
  warn: (message: string) => void,
): ParsedTable {
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`);
    return NO_TABLE;
  }
  const reading = dbml.parseTable(text, name);
  if (!reading.ok) {
    warn(`Failed to read model "${name}": ${reading.error.message}`);
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
