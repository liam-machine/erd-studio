/**
 * Shared bootstrap for the `erd-studio` CLI: find the dbt project, wire the
 * services the way `extension.ts` does, and load the three dbt inputs
 * (schema yml + source files, manifest, catalog) once.
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
import { findDbtProjectDir } from '../services/dbtEnv';
import { readDbtProjectConfig, resolveCatalogPath, resolveManifestPath, type DbtProjectConfig } from '../services/dbtProjectConfig';
import { DomainService } from '../services/domainService';
import { LayerService } from '../services/layerService';
import { LogicalModelService } from '../services/logicalModelService';
import { checkManifestStalenessFs } from '../services/manifestStaleness';
import { ManifestService } from '../services/manifestService';
import { YmlParserService } from '../services/ymlParserService';

/** The version baked into dist/cli.js; package.json's when run from source (tests). */
export const CLI_VERSION: string = typeof __ERD_CLI_VERSION__ === 'string' ? __ERD_CLI_VERSION__ : '0.0.0-dev';

/** Top-level fields of every JSON result. */
export interface Envelope {
  cliVersion: string;
  /** Absolute dbt project root (the folder holding dbt_project.yml). */
  projectRoot: string;
  /** ERD data dir, relative to `projectRoot`. */
  semanticDir: string;
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
  dbtConfig: DbtProjectConfig;
  layerService: LayerService;
  logicalModelService: LogicalModelService;
  domainService: DomainService;
  manifest: ManifestData;
  manifestInfo: ManifestInputInfo;
  ymlData: YmlData;
  catalog: CatalogData | undefined;
  catalogInfo: CatalogInputInfo;
}

/**
 * The dbt project root. An explicit `--project` must be the folder holding
 * `dbt_project.yml` — searching around a path the user named could land on
 * an unrelated project above it. Without one, the current directory, then
 * its ancestors, then up to three levels below it (`findDbtProjectDir`, the
 * extension's own search). Null when there is none.
 */
export function resolveProjectRoot(project: string | undefined, cwd: string = process.cwd()): string | null {
  if (project) {
    const dir = path.resolve(cwd, project);
    return fs.existsSync(path.join(dir, 'dbt_project.yml')) ? dir : null;
  }
  return findDbtProjectDir(cwd);
}

/** Like `resolveProjectRoot`, but a missing project is a `CliEnvError`. */
export function requireProjectRoot(project: string | undefined, cwd: string = process.cwd()): string {
  const root = resolveProjectRoot(project, cwd);
  if (!root) {
    throw new CliEnvError(
      'no-project',
      project
        ? `No dbt_project.yml found in ${redactPaths(relPath(cwd, path.resolve(cwd, project)))} (--project must be the folder that holds it).`
        : 'No dbt_project.yml found in this folder, above it, or up to three folders below it. Run this from your dbt project folder, or pass --project <dir>.',
    );
  }
  return root;
}

export function makeEnvelope(root: string, semanticDir: string): Envelope {
  return { cliVersion: CLI_VERSION, projectRoot: root, semanticDir };
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
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(16 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const m = /"invocation_id"\s*:\s*"([^"]+)"/.exec(buf.subarray(0, n).toString('utf8'));
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

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Build the services and load every input. Wiring follows extension.ts —
 * `LayerService` + `LogicalModelService` feed `DomainService` — with the
 * manifest parsed in-process (spec D6).
 */
export async function buildCliContext(opts: { project?: string; semanticDir: string; cwd?: string }): Promise<CliContext> {
  const root = requireProjectRoot(opts.project, opts.cwd);
  const semanticDir = opts.semanticDir;
  const dbtConfig = readDbtProjectConfig(root);

  const layerService = new LayerService(root, semanticDir);
  const logicalModelService = new LogicalModelService(root, semanticDir);
  const domainService = new DomainService(layerService);
  domainService.setLogicalModelService(logicalModelService);

  const manifestService = new ManifestService({ dbtConfig, parseInProcess: true });
  const catalogService = new CatalogService({ dbtConfig });
  const [manifest, ymlData, catalog] = await Promise.all([
    manifestService.loadManifest(root),
    new YmlParserService({ dbtConfig }).loadYmlData(root, undefined),
    catalogService.loadCatalog(root),
  ]);

  const manifestPath = resolveManifestPath(root, dbtConfig);
  const manifestMtime = mtimeMs(manifestPath);
  let manifestStatus: ArtifactStatus;
  let newestSourceChange: string | null = null;
  if (manifestService.isMissing || manifestMtime === null) {
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
  const catalogMtime = mtimeMs(catalogPath);
  let catalogStatus: CatalogStatus;
  if (catalogMtime === null) {
    catalogStatus = 'missing';
  } else if (!catalog) {
    catalogStatus = 'unreadable';
  } else if (manifestMtime !== null && catalogMtime < manifestMtime
    && !sameDbtInvocation(catalogPath, manifestPath)) {
    // `dbt docs generate` writes catalog.json and then rewrites manifest.json a moment later,
    // so file times alone would call a fresh catalog stale; one run shares one invocation_id.
    catalogStatus = 'older-than-manifest';
  } else {
    catalogStatus = 'ok';
  }

  return {
    envelope: makeEnvelope(root, semanticDir),
    root,
    semanticDir,
    dbtConfig,
    layerService,
    logicalModelService,
    domainService,
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
