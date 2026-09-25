/**
 * Raw files -> DisplayDomain in one call, for hosts that read a domain folder
 * through an async `readFile` (a git provider, an HTTP API, a zip) and render
 * it without the extension's editing extras.
 *
 * The folder layout is the extension's:
 *
 *   {semanticDir}/layers.json
 *   {semanticDir}/logical-models/{model}.yml
 *   {semanticDir}/{layer}/{domain}.json      <- domainPath
 *
 * Everything the files say is validated and repaired by the same functions
 * the extension host uses. The limits in the options exist for hosts that
 * read files they do not control; all of them are off by default.
 */

import type { DisplayDomain } from './types/display.js';
import type { DomainFormat, NodePosition, SemanticModel } from './types/semantic.js';
import type { LayerConfig } from './types/layer.js';
import {
  DomainFileError,
  DomainValidationError,
  buildUnifiedDomain,
  parseDomainJson,
  resolveDomainLayer,
  toLogicalStage,
  validateDomainDocument,
  type LayerLookup,
} from './domain.js';
import { LAYERS_CONFIG_FILE, parseLayersText } from './layers.js';
import { LOGICAL_MODELS_DIR, isSafeModelName, parseLogicalModelTextWithUsage } from './logicalModel.js';
import { computeMissingPositions, toDisplayDomain } from './displayDomain.js';
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
export class TooManyModelsError extends Error {
  constructor(readonly count: number, readonly max: number) {
    super(`The domain lists ${count} models; at most ${max} are allowed`);
    this.name = 'TooManyModelsError';
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
 * Options for {@link loadDisplayDomain}. Each numeric limit must be a number
 * of at least 0, or `Infinity` for none (`maxParallelReads`: a whole number of
 * at least 1, or `Infinity`); any other value, NaN included, makes
 * `loadDisplayDomain` reject with a TypeError before it reads anything.
 */
export interface LoadDisplayDomainOptions {
  /** Path of the domain file, `{semanticDir}/{layer}/{domain}.json`; `/` or `\` separated. */
  domainPath: string;
  /**
   * Read a file's text. Resolve `null` or `undefined` when it does not exist;
   * a rejection is passed through to the caller unchanged.
   */
  readFile(path: string): Promise<string | null | undefined>;
  /** The DisplayDomain's `readOnly` flag. */
  readOnly: boolean;
  /** Most files read at once. Default 8. */
  maxParallelReads?: number;
  /**
   * Which v5 model names may be read. A rejected name is never read and
   * renders as a placeholder. Default: `isSafeModelName`.
   */
  modelNameFilter?: (name: string) => boolean;
  /** Most entries `logical.models` may have (v4 and v5, counted before any filtering). Default unlimited. */
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
}

/** Split a domain path into its semantic-dir prefix (with trailing separator), parent dir and file name. */
function splitDomainPath(domainPath: string): { prefix: string; parentDirName: string; fileName: string } {
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

/**
 * Read a domain, its layers and its logical models through `readFile`, and
 * build the DisplayDomain of its logical stage.
 *
 * Bad input rejects with one of four classes: `DomainFileError` (missing,
 * empty or non-JSON domain file), `DomainValidationError` (not a loadable
 * domain, an unconfigured layer, or a malformed v4 inline model),
 * `TooManyModelsError` and `FileTooLargeError`. A model that is missing,
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
export async function loadDisplayDomain(options: LoadDisplayDomainOptions): Promise<DisplayDomain> {
  const {
    domainPath,
    readFile,
    readOnly,
    maxParallelReads = 8,
    modelNameFilter = isSafeModelName,
    maxModels = Infinity,
    maxYamlNodes = Infinity,
    maxDomainChars = Infinity,
    maxYamlChars = Infinity,
  } = options;
  const warn = options.warn ?? ((message: string) => console.warn(message));

  // 0. Limits that are not numbers would silently switch themselves off.
  checkLimit('loadDisplayDomain', 'maxParallelReads', maxParallelReads, { min: 1, integer: true });
  checkLimit('loadDisplayDomain', 'maxModels', maxModels);
  checkLimit('loadDisplayDomain', 'maxYamlNodes', maxYamlNodes);
  checkLimit('loadDisplayDomain', 'maxDomainChars', maxDomainChars);
  checkLimit('loadDisplayDomain', 'maxYamlChars', maxYamlChars);
  const ignoreStrayPositions =
    options.ignoreStrayPositions ??
    [maxModels, maxYamlNodes, maxDomainChars, maxYamlChars].some((limit) => limit !== Infinity);

  // 1-3. The domain file itself.
  const domainText = await readFile(domainPath);
  if (domainText === null || domainText === undefined) {
    throw new DomainFileError('missing', domainPath, `Domain file not found: ${domainPath}`);
  }
  if (domainText.length > maxDomainChars) {
    throw new FileTooLargeError(domainPath, domainText.length, maxDomainChars);
  }
  const { obj, format } = validateDomainDocument(parseDomainJson(domainText, domainPath), domainPath);

  // 4-5. Layers, from the semantic dir the domain sits in.
  const { prefix, parentDirName, fileName } = splitDomainPath(domainPath);
  const layersPath = `${prefix}${LAYERS_CONFIG_FILE}`;
  let layersText = await readFile(layersPath);
  if (layersText !== null && layersText !== undefined && layersText.length > maxDomainChars) {
    warn(`${layersPath} is ${layersText.length} characters long; at most ${maxDomainChars} are read. Using the default layers`);
    layersText = null;
  }
  const layers = parseLayersText(layersText, warn);
  const layerLookup: LayerLookup = {
    hasLayer: (id) => layers.some((l) => l.id === id),
    getValidLayerIds: () => layers.map((l) => l.id),
  };
  resolveDomainLayer(obj.layer, domainPath, parentDirName, layerLookup);

  // 6. The model cap, on the raw list, before anything is read.
  const logical = obj.logical;
  const rawModels =
    logical && typeof logical === 'object' && !Array.isArray(logical) &&
    Array.isArray((logical as Record<string, unknown>).models)
      ? ((logical as Record<string, unknown>).models as unknown[])
      : undefined;
  if (rawModels && rawModels.length > maxModels) {
    throw new TooManyModelsError(rawModels.length, maxModels);
  }

  // 7. v5 model files: each unique, allowed name read and parsed once.
  const parsed = new Map<string, ParsedModel>();
  if (format === 'v5' && rawModels) {
    const names = [...new Set(rawModels.filter((m): m is string => typeof m === 'string'))]
      .filter((name) => modelNameFilter(name));
    await mapWithLimit(names, maxParallelReads, async (name) => {
      const text = await readFile(`${prefix}${LOGICAL_MODELS_DIR}/${name}.yml`);
      parsed.set(name, parseModel(name, text, maxYamlChars, maxYamlNodes, warn));
    });
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
    return buildDisplayDomain(obj, format, {
      domainPath,
      fileName,
      parentDirName,
      layers,
      layerLookup,
      parsed,
      readOnly,
      ignoreStrayPositions,
      warn: callerWarn,
    });
  } catch (err) {
    if (err instanceof TypeError && !callerErrors.has(err)) {
      const invalid = new DomainValidationError(`${domainPath} is not a loadable domain: ${err.message}`);
      // As `new Error(message, { cause })` sets it (that form needs ES2022 lib typings).
      Object.defineProperty(invalid, 'cause', { value: err, writable: true, configurable: true });
      throw invalid;
    }
    throw err;
  }
}

/** Steps 8-10 of {@link loadDisplayDomain}: the parsed files -> the DisplayDomain. */
function buildDisplayDomain(
  obj: Record<string, unknown>,
  format: DomainFormat,
  ctx: {
    domainPath: string;
    fileName: string;
    parentDirName: string;
    layers: LayerConfig[];
    layerLookup: LayerLookup;
    parsed: ReadonlyMap<string, ParsedModel>;
    readOnly: boolean;
    ignoreStrayPositions: boolean;
    warn: (message: string) => void;
  },
): DisplayDomain {
  const { domainPath, fileName, parentDirName, layers, layerLookup, parsed, readOnly, ignoreStrayPositions, warn } = ctx;

  // 8. The UnifiedDomain, each occurrence of a model its own copy (sharing
  // the parsed strings, which are immutable, so repeats cost no text). Each
  // copy is charged to the file's budgets, so listing one model many times
  // cannot expand the result past what the budgets allow one file.
  const listed = new Map<string, number>();
  const unified = buildUnifiedDomain(obj, format, {
    filePath: domainPath,
    domainNameFallback: stripJsonExtension(fileName),
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
    warn,
  });

  // 9. Positions for models that have none.
  const computed = computeMissingPositions(
    ignoreStrayPositions
      ? { ...unified, viewConfig: { positions: modelPositions(unified.viewConfig.positions, unified.logical.models) } }
      : unified,
  );
  if (computed) {
    unified.viewConfig.positions = { ...(unified.viewConfig.positions ?? {}), ...computed };
  }

  // 10. The logical stage, as the canvas renders it.
  return toDisplayDomain(toLogicalStage(unified), {
    viewConfig: unified.viewConfig,
    stubColumns: unified.stubColumns,
    layerConfig: layers.find((l) => l.id === unified.layer),
    readOnly,
  });
}

/** The entries of `positions` that name one of `models`. */
function modelPositions(
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
 */
function copyPlain<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(copyPlain) as T;
  }
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = copyPlain(item);
    }
    return copy as T;
  }
  return value;
}

/** A parsed model file, and how many times the domain may list it within the file's budgets. */
interface ParsedModel {
  /** The model, or null (a placeholder) when the file is absent, too large or unusable. */
  model: SemanticModel | null;
  /** How many listings of the model get a copy; the rest are placeholders. */
  copies: number;
}

const NO_MODEL: ParsedModel = { model: null, copies: 0 };

/** Parse one model file's text, charging it to the budgets. */
function parseModel(
  name: string,
  text: string | null | undefined,
  maxChars: number,
  maxNodes: number,
  warn: (message: string) => void,
): ParsedModel {
  if (text === null || text === undefined) {
    return NO_MODEL;
  }
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`);
    return NO_MODEL;
  }
  try {
    const { model, nodes, chars } = parseLogicalModelTextWithUsage(text, name, { maxNodes, maxChars });
    // A budget that was not counted (unlimited) or not used allows any number of copies.
    const fits = (max: number, used: number): number => (used > 0 ? Math.floor(max / used) : Infinity);
    return { model, copies: Math.min(fits(maxNodes, nodes), fits(maxChars, chars)) };
  } catch (err) {
    warn(`Failed to read model "${name}": ${err instanceof Error ? err.message : String(err)}`);
    return NO_MODEL;
  }
}
