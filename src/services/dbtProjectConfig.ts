/**
 * DbtProjectConfig — reads the path-related keys ERD Studio cares about from
 * `dbt_project.yml` (`target-path`, `model-paths`) so that every consumer
 * (manifest parser, schema .yml walker, file watchers, staleness check)
 * honours the same configured locations instead of hard-coding `target/`
 * and `models/`.
 *
 * Read once at activation and passed into services. A change to these keys
 * is detected by FileWatcherService, which prompts for a window reload.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface DbtProjectConfig {
  /** Directory dbt writes artifacts to (relative to the project root). Default `target`. */
  targetPath: string;
  /** Directories dbt reads models (and their schema .yml files) from. Default `['models']`. */
  modelPaths: string[];
}

export const DEFAULT_TARGET_PATH = 'target';
export const DEFAULT_MODEL_PATHS: readonly string[] = ['models'];

export function defaultDbtProjectConfig(): DbtProjectConfig {
  return { targetPath: DEFAULT_TARGET_PATH, modelPaths: [...DEFAULT_MODEL_PATHS] };
}

/**
 * Normalise a path value from dbt_project.yml into a clean, relative,
 * forward-slash form suitable for both `path.join` and glob patterns:
 * trims whitespace, converts backslashes, strips leading `./` and trailing
 * slashes. Returns null for empty / non-string / absolute / traversal values.
 */
function normaliseRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  let p = value.trim().replace(/\\/g, '/');
  while (p.startsWith('./')) {
    p = p.slice(2);
  }
  p = p.replace(/\/+$/, '');
  if (!p || p === '.' || path.isAbsolute(p) || p.split('/').includes('..')) {
    return null;
  }
  return p;
}

function readPathList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of raw) {
    const p = normaliseRelativePath(item);
    if (p && !out.includes(p)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Parse `dbt_project.yml` at `projectRoot`. Missing file, malformed YAML,
 * or missing/invalid keys fall back to dbt's defaults so callers never
 * need to handle an error.
 */
export function readDbtProjectConfig(projectRoot: string): DbtProjectConfig {
  const config = defaultDbtProjectConfig();

  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectRoot, 'dbt_project.yml'), 'utf-8');
  } catch {
    return config;
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch {
    return config;
  }
  if (!doc || typeof doc !== 'object') {
    return config;
  }
  const map = doc as Record<string, unknown>;

  const targetPath = normaliseRelativePath(map['target-path']);
  if (targetPath) {
    config.targetPath = targetPath;
  }

  // `source-paths` is the pre-dbt-1.0 name for `model-paths`.
  const modelPaths = readPathList(map['model-paths'] ?? map['source-paths']);
  if (modelPaths.length > 0) {
    config.modelPaths = modelPaths;
  }

  return config;
}

/** Absolute path of `manifest.json` for the given project and config. */
export function resolveManifestPath(projectRoot: string, config: DbtProjectConfig): string {
  return path.join(projectRoot, config.targetPath, 'manifest.json');
}

/**
 * Build the glob fragment that matches every configured model directory,
 * e.g. `models` or `{models,extra_models}`.
 */
export function modelPathsGlob(config: DbtProjectConfig): string {
  const paths = config.modelPaths.length > 0 ? config.modelPaths : [...DEFAULT_MODEL_PATHS];
  return paths.length === 1 ? paths[0] : `{${paths.join(',')}}`;
}
