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
import type { SemanticModel } from './types/semantic.js';
import {
  DomainFileError,
  buildUnifiedDomain,
  parseDomainJson,
  resolveDomainLayer,
  toLogicalStage,
  validateDomainDocument,
  type LayerLookup,
} from './domain.js';
import { LAYERS_CONFIG_FILE, parseLayersText } from './layers.js';
import { LOGICAL_MODELS_DIR, isSafeModelName, parseLogicalModelText } from './logicalModel.js';
import { computeMissingPositions, toDisplayDomain } from './displayDomain.js';

/**
 * Run `worker` over `items` with at most `limit` calls in flight, keeping the
 * results in input order. The first rejection rejects the whole call, and no
 * further items are started after it.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const lanes = Math.min(items.length, Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : items.length);
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
  /** Most model files read at once. Default 8. */
  maxParallelReads?: number;
  /**
   * Which v5 model names may be read. A rejected name is never read and
   * renders as a placeholder. Default: `isSafeModelName`.
   */
  modelNameFilter?: (name: string) => boolean;
  /** Most entries `logical.models` may have (v4 and v5, counted before any filtering). Default unlimited. */
  maxModels?: number;
  /** Most YAML nodes one model file may expand to; a file over it renders as a placeholder. Default unlimited. */
  maxYamlNodes?: number;
  /** Longest domain file, in characters; longer throws `FileTooLargeError`. Default unlimited. */
  maxDomainChars?: number;
  /** Longest model file, in characters; a longer one renders as a placeholder. Default unlimited. */
  maxYamlChars?: number;
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
 * domain, or an unconfigured layer), `TooManyModelsError` and
 * `FileTooLargeError`. A model that is missing, unreadable, unsafe, too large
 * or over the node budget renders as a placeholder instead.
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
  const layers = parseLayersText(await readFile(`${prefix}${LAYERS_CONFIG_FILE}`), warn);
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
  const parsed = new Map<string, SemanticModel | null>();
  if (format === 'v5' && rawModels) {
    const names = [...new Set(rawModels.filter((m): m is string => typeof m === 'string'))]
      .filter((name) => modelNameFilter(name));
    await mapWithLimit(names, maxParallelReads, async (name) => {
      const text = await readFile(`${prefix}${LOGICAL_MODELS_DIR}/${name}.yml`);
      parsed.set(name, parseModel(name, text, maxYamlChars, maxYamlNodes, warn));
    });
  }

  // 8. The UnifiedDomain, each occurrence of a model its own copy.
  const unified = buildUnifiedDomain(obj, format, {
    filePath: domainPath,
    domainNameFallback: stripJsonExtension(fileName),
    parentDirName,
    layers: layerLookup,
    getModel: (name) => {
      const model = parsed.get(name);
      return model ? structuredClone(model) : null;
    },
    warn,
  });

  // 9. Positions for models that have none.
  const computed = computeMissingPositions(unified);
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

/** Parse one model file's text, or null (a placeholder) when it is absent, too large or unusable. */
function parseModel(
  name: string,
  text: string | null | undefined,
  maxChars: number,
  maxNodes: number,
  warn: (message: string) => void,
): SemanticModel | null {
  if (text === null || text === undefined) {
    return null;
  }
  if (text.length > maxChars) {
    warn(`Model "${name}" is ${text.length} characters long; at most ${maxChars} are read`);
    return null;
  }
  try {
    return parseLogicalModelText(text, name, { maxNodes });
  } catch (err) {
    warn(`Failed to read model "${name}": ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
