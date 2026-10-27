/**
 * Shared bootstrap for the `erd-studio` CLI: find the project, wire the
 * services the way `extension.ts` does, and load the three dbt inputs
 * (schema yml + source files, manifest, catalog) once.
 *
 * The project is a dbt project, or — logical-only, like the extension in a
 * folder with no dbt project — a folder that holds the ERD Studio folder but
 * no `dbt_project.yml`. There the dbt services are built disabled: they read
 * nothing (not even a `models/` folder that happens to exist) and every dbt
 * input is empty, so only the logical files are read.
 *
 * Everything here is read-only (spec D5) and free of `vscode` — this module
 * is bundled into `dist/cli.js`.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { CatalogData } from '../types/catalog';
import { redactPaths } from '../types/feedback';
import type { ManifestData } from '../types/manifest';
import type { YmlData } from '../types/ymlData';
import { CatalogService } from '../services/catalogService';
import { findDbtProjectCandidates, hasDbtProjectFile } from '../services/projectDiscovery';
import { readDbtProjectConfig, resolveCatalogPath, resolveManifestPath, type DbtProjectConfig } from '../services/dbtProjectConfig';
import { SubjectAreaService } from '../services/domainService';
import { LayerService } from '../services/layerService';
import { TableLibraryService } from '../services/logicalModelService';
import { checkManifestStalenessFs } from '../services/manifestStaleness';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';
import { DEFAULT_CLI_SEMANTIC_DIR } from './args';

/** The version baked into dist/cli.js; package.json's when run from source (tests). */
export const CLI_VERSION: string = typeof __ERD_CLI_VERSION__ === 'string' ? __ERD_CLI_VERSION__ : '0.0.0-dev';

/** Top-level fields of every JSON result. */
export interface Envelope {
  cliVersion: string;
  /**
   * Absolute project root: the folder holding dbt_project.yml, or — when
   * `dbtProject` is false — the folder holding the ERD Studio folder.
   */
  projectRoot: string;
  /** ERD data dir, relative to `projectRoot`. */
  semanticDir: string;
  /**
   * True when `projectRoot` holds dbt_project.yml. False for a logical-only
   * folder (its ERD Studio files are read; nothing dbt is read or run) and
   * when doctor found no project at all.
   */
  dbtProject: boolean;
}

export type ArtifactStatus = 'ok' | 'missing' | 'stale' | 'unreadable';
export type CatalogStatus = 'ok' | 'missing' | 'older-than-manifest' | 'unreadable';

/** A problem with the environment rather than the invocation — exit code 3. */
export class CliEnvError extends Error {
  readonly exitCode = 3;
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CliEnvError';
  }
}

export interface ManifestInputInfo {
  status: ArtifactStatus;
  /** Absolute path of the manifest the config points at. */
  path: string;
  modifiedAt: string | null;
  /** Model count when a manifest was parsed (a stale one included), else null. */
  models: number | null;
  newestSourceChange: string | null;
}

export interface CatalogInputInfo {
  status: CatalogStatus;
  path: string;
  modifiedAt: string | null;
  nodes: number | null;
}

export interface CliContext {
  envelope: Envelope;
  root: string;
  semanticDir: string;
  /** `root` holds dbt_project.yml. False: logical-only, every dbt input below is empty. */
  hasDbt: boolean;
  dbtConfig: DbtProjectConfig;
  layerService: LayerService;
  tableLibraryService: TableLibraryService;
  subjectAreaService: SubjectAreaService;
  manifest: ManifestData;
  manifestInfo: ManifestInputInfo;
  ymlData: YmlData;
  catalog: CatalogData | undefined;
  catalogInfo: CatalogInputInfo;
}

function holdsSemanticDir(dir: string, semanticDir: string): boolean {
  try {
    return fs.statSync(path.join(dir, semanticDir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The project root. An explicit `--project` must be a folder that holds
 * `dbt_project.yml` or — a logical-only project — the ERD Studio folder
 * (`semanticDir`); searching around a path the user named could land
 * on an unrelated project above it.
 *
 * Without one, the folder the extension would run on: walk up from the
 * current directory to the nearest folder holding `dbt_project.yml` or the
 * ERD Studio folder, whichever comes first, so a design folder nested in a
 * dbt repo is its own (logical-only) root, as the extension opens it, and
 * never the dbt project above it. A design folder that is the current
 * directory still gives way to a dbt project up to three levels below it
 * (any dbt project beats a plain folder, as in the extension's search).
 * With no such folder at or above it — or only one above it — a dbt
 * project up to three levels below the current directory comes next
 * (`findDbtProjectCandidates`, the extension's own search), then that
 * design folder above. Null when there is none.
 */
export function resolveProjectRoot(
  project: string | undefined,
  cwd: string = process.cwd(),
  semanticDir: string = DEFAULT_CLI_SEMANTIC_DIR,
): string | null {
  if (project) {
    const dir = path.resolve(cwd, project);
    return hasDbtProjectFile(dir) || holdsSemanticDir(dir, semanticDir) ? dir : null;
  }
  const origin = path.resolve(cwd);
  let designRoot: string | null = null;
  for (let dir = origin; ; dir = path.dirname(dir)) {
    if (hasDbtProjectFile(dir)) { return dir; }
    if (holdsSemanticDir(dir, semanticDir)) { designRoot = dir; break; }
    if (path.dirname(dir) === dir) { break; }
  }
  // Below the current directory (it holds no dbt_project.yml, or the walk would have returned it).
  const below = findDbtProjectCandidates([origin])[0];
  return below ?? designRoot;
}

/** Like `resolveProjectRoot`, but a missing project is a `CliEnvError`. */
export function requireProjectRoot(
  project: string | undefined,
  cwd: string = process.cwd(),
  semanticDir: string = DEFAULT_CLI_SEMANTIC_DIR,
): string {
  const root = resolveProjectRoot(project, cwd, semanticDir);
  if (!root) {
    throw new CliEnvError(
      'no-project',
      project
        ? `No dbt_project.yml or ${semanticDir}/ folder found in ${redactPaths(relPath(cwd, path.resolve(cwd, project)))} `
          + '(--project must be the folder that holds one).'
        : `No dbt project or ${semanticDir}/ folder found here: looked for dbt_project.yml in this folder, above it and up to three `
          + `folders below it, and for ${semanticDir}/ in this folder and above it. Run this from your project folder, or pass --project <dir>.`,
    );
  }
  return root;
}

export function makeEnvelope(root: string, semanticDir: string, dbtProject: boolean): Envelope {
  return { cliVersion: CLI_VERSION, projectRoot: root, semanticDir, dbtProject };
}

/** `file` relative to `root` with forward slashes (absolute, forward-slashed, when outside it). */
export function relPath(root: string, file: string): string {
  const rel = path.relative(root, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) { return rel.replace(/\\/g, '/'); }
  return file.replace(/\\/g, '/');
}

function mtimeMs(file: string): number | null {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * The `metadata.invocation_id` of a dbt artifact, read from its first few KB — dbt writes the
 * `metadata` block first, so a 40 MB manifest need not be read again just for this.
 */
export function readInvocationId(file: string): string | null {
  return readMetadataField(file, 'invocation_id');
}

/** The `metadata.generated_at` of a dbt artifact (epoch ms), read the same cheap way; null when absent. */
export function readGeneratedAt(file: string): number | null {
  const raw = readMetadataField(file, 'generated_at');
  const ms = raw === null ? NaN : Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

function readMetadataField(file: string, field: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(buf.subarray(0, n).toString('utf8'));
    return m ? m[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { fs.closeSync(fd); }
  }
}

/** True when both artifacts come from the same dbt run (e.g. one `dbt docs generate`). */
export function sameDbtInvocation(a: string, b: string): boolean {
  const idA = readInvocationId(a);
  return idA !== null && idA === readInvocationId(b);
}

/**
 * Is the catalog older than the manifest? Decided from what dbt recorded inside the files —
 * `metadata.generated_at` — because file times are not evidence: a fresh `git clone` (CI, or a
 * repo that commits its artifacts, like the sample project) stamps both files with whatever order
 * the checkout wrote them in. Artifacts from one dbt run are always current together (`dbt docs
 * generate` writes the catalog and then rewrites the manifest). File times are only the fallback
 * when either file records no time.
 */
export function catalogOlderThanManifest(
  catalogPath: string, manifestPath: string, catalogMtime: number, manifestMtime: number,
): boolean {
  if (sameDbtInvocation(catalogPath, manifestPath)) { return false; }
  const catalogAt = readGeneratedAt(catalogPath);
  const manifestAt = readGeneratedAt(manifestPath);
  if (catalogAt !== null && manifestAt !== null) { return catalogAt < manifestAt; }
  return catalogMtime < manifestMtime;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Build the services and load every input. Wiring follows extension.ts —
 * `LayerService` + `TableLibraryService` feed `SubjectAreaService` — with the
 * manifest parsed in-process (spec D6).
 */
export async function buildCliContext(opts: { project?: string; semanticDir: string; cwd?: string }): Promise<CliContext> {
  const semanticDir = opts.semanticDir;
  const root = requireProjectRoot(opts.project, opts.cwd, semanticDir);
  const hasDbt = hasDbtProjectFile(root);
  const dbtConfig = readDbtProjectConfig(root);

  const layerService = new LayerService(root, semanticDir);
  const tableLibraryService = new TableLibraryService(root, semanticDir);
  const subjectAreaService = new SubjectAreaService(layerService);
  subjectAreaService.setTableLibraryService(tableLibraryService);

  // Logical-only: built disabled, so nothing dbt is read (the extension's own switch).
  const manifestService = new ManifestService({ dbtConfig, parseInProcess: true, enabled: hasDbt });
  const catalogService = new CatalogService({ dbtConfig, enabled: hasDbt });
  const [manifest, ymlData, catalog] = await Promise.all([
    manifestService.loadManifest(root),
    new YmlParserService({ dbtConfig, enabled: hasDbt }).loadYmlData(root, undefined),
    catalogService.loadCatalog(root),
  ]);

  const manifestPath = resolveManifestPath(root, dbtConfig);
  // A logical-only folder has no artifacts to look at: both read as missing.
  const manifestMtime = hasDbt ? mtimeMs(manifestPath) : null;
  let manifestStatus: ArtifactStatus;
  let newestSourceChange: string | null = null;
  if (!hasDbt || manifestService.isMissing || manifestMtime === null) {
    manifestStatus = 'missing';
  } else if (manifestService.isStale) {
    // The parse failed and nothing was known before it: dbt mid-write, or a broken file.
    manifestStatus = 'unreadable';
  } else {
    const staleness = checkManifestStalenessFs(root, dbtConfig);
    newestSourceChange = iso(staleness.newestSourceMtime);
    manifestStatus = staleness.isStale ? 'stale' : 'ok';
  }

  const catalogPath = resolveCatalogPath(root, dbtConfig);
  const catalogMtime = hasDbt ? mtimeMs(catalogPath) : null;
  let catalogStatus: CatalogStatus;
  if (catalogMtime === null) {
    catalogStatus = 'missing';
  } else if (!catalog) {
    catalogStatus = 'unreadable';
  } else if (manifestMtime !== null
    && catalogOlderThanManifest(catalogPath, manifestPath, catalogMtime, manifestMtime)) {
    catalogStatus = 'older-than-manifest';
  } else {
    catalogStatus = 'ok';
  }

  return {
    envelope: makeEnvelope(root, semanticDir, hasDbt),
    root,
    semanticDir,
    hasDbt,
    dbtConfig,
    layerService,
    tableLibraryService,
    subjectAreaService,
    manifest,
    manifestInfo: {
      status: manifestStatus,
      path: manifestPath,
      modifiedAt: iso(manifestMtime),
      models: manifestStatus === 'missing' || manifestStatus === 'unreadable' ? null : manifest.models.size,
      newestSourceChange,
    },
    ymlData,
    catalog,
    catalogInfo: {
      status: catalogStatus,
      path: catalogPath,
      modifiedAt: iso(catalogMtime),
      nodes: catalog ? catalog.byUniqueId.size : null,
    },
  };
}

/** The inventory/diff `inputs` block: the catalog's four states folded onto `ArtifactStatus`. */
export function inputsOf(ctx: CliContext): { manifest: ArtifactStatus; catalog: ArtifactStatus } {
  const catalog: ArtifactStatus = ctx.catalogInfo.status === 'older-than-manifest' ? 'stale' : ctx.catalogInfo.status;
  return { manifest: ctx.manifestInfo.status, catalog };
}
