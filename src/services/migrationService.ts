/**
 * MigrationService — converts v1/v2 stage-first domain files to v3 unified format.
 *
 * v1/v2 layout: erd-studio/{stage}/{layer}/{domain}.json (two files per domain)
 * v3 layout:    erd-studio/{layer}/{domain}.json          (one file per domain)
 *
 * The migration scans conceptual/ and logical/ directories, merges sibling pairs
 * into UnifiedDomain objects, writes them to the new layout, and removes the old
 * stage directories.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { StageData, UnifiedDomain } from '../types/semantic';
import { CURRENT_SCHEMA_VERSION } from '../types/semantic';

/** Result of scanning old stage directories for domains to migrate. */
export interface MigrationScanResult {
  /** Domains found with files to merge. */
  domains: MigrationDomainEntry[];
  /** Total number of old files that will be consumed. */
  fileCount: number;
}

/** A single domain discovered during migration scan. */
export interface MigrationDomainEntry {
  layer: string;
  domain: string;
  conceptualPath: string | null;
  logicalPath: string | null;
}

const EMPTY_STAGE_DATA: StageData = {
  models: [],
  relationships: [],
};

/**
 * Scan old v1/v2 stage directories and return what would be migrated.
 * Does not modify the filesystem.
 */
export function scanV2Domains(
  projectPath: string,
  semanticDir: string,
): MigrationScanResult {
  const basePath = path.join(projectPath, semanticDir);
  const domainMap = new Map<string, MigrationDomainEntry>();

  for (const stage of ['conceptual', 'logical'] as const) {
    const stageDir = path.join(basePath, stage);
    if (!fs.existsSync(stageDir)) {
      continue;
    }

    let layerDirs: string[];
    try {
      layerDirs = fs.readdirSync(stageDir).filter(entry => {
        const fullPath = path.join(stageDir, entry);
        return fs.statSync(fullPath).isDirectory();
      });
    } catch {
      continue;
    }

    for (const layer of layerDirs) {
      const layerDir = path.join(stageDir, layer);
      let files: string[];
      try {
        files = fs.readdirSync(layerDir).filter(f => f.endsWith('.json'));
      } catch {
        continue;
      }

      for (const file of files) {
        const domain = path.basename(file, '.json');
        const key = `${layer}/${domain}`;
        const existing = domainMap.get(key) ?? {
          layer,
          domain,
          conceptualPath: null,
          logicalPath: null,
        };

        if (stage === 'conceptual') {
          existing.conceptualPath = path.join(layerDir, file);
        } else {
          existing.logicalPath = path.join(layerDir, file);
        }

        domainMap.set(key, existing);
      }
    }
  }

  const domains = Array.from(domainMap.values());
  const fileCount = domains.reduce(
    (sum, d) => sum + (d.conceptualPath ? 1 : 0) + (d.logicalPath ? 1 : 0),
    0,
  );

  return { domains, fileCount };
}

/**
 * Merge two v1/v2 sibling domain files into a single v3 UnifiedDomain.
 *
 * Either path may be null (orphan). If both are null, returns a minimal domain.
 * When both exist, metadata (description, modelFolder) is taken from the logical
 * file since it's the more detailed stage.
 */
export function mergeV2Siblings(
  conceptualPath: string | null,
  logicalPath: string | null,
  domain: string,
  layer: string,
): UnifiedDomain {
  const conceptualData = conceptualPath ? readOldDomainFile(conceptualPath) : null;
  const logicalData = logicalPath ? readOldDomainFile(logicalPath) : null;

  // Prefer logical for shared metadata, fall back to conceptual
  const primary = logicalData ?? conceptualData;

  // Hoist viewConfig to root level — prefer logical, then conceptual
  const viewConfig = (logicalData?.viewConfig ?? conceptualData?.viewConfig ?? {}) as import('../types/semantic').ViewConfig;

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    domain,
    layer,
    description: primary?.description ?? '',
    ...(primary?.modelFolder ? { modelFolder: primary.modelFolder } : {}),
    conceptual: extractStageData(conceptualData),
    logical: extractStageData(logicalData),
    viewConfig,
  };
}

/**
 * Perform the full v2→v3 migration: scan, merge, write new files, delete old dirs.
 *
 * Uses a two-phase approach: reads and merges all domains before writing any files,
 * so a parse error in any source file aborts before any mutation occurs.
 *
 * Returns the number of domains migrated.
 */
export function migrateV2ToV3(
  projectPath: string,
  semanticDir: string,
): number {
  const basePath = path.join(projectPath, semanticDir);
  const scan = scanV2Domains(projectPath, semanticDir);

  if (scan.domains.length === 0) {
    return 0;
  }

  // Phase 1: Read and merge all domains (no writes yet — safe to abort on error)
  const prepared = scan.domains.map(entry => {
    const unified = mergeV2Siblings(
      entry.conceptualPath,
      entry.logicalPath,
      entry.domain,
      entry.layer,
    );
    const targetPath = path.join(basePath, entry.layer, `${entry.domain}.json`);
    return { entry, unified, targetPath };
  });

  // Phase 2: Guard against overwriting existing v3 files
  for (const { targetPath } of prepared) {
    if (fs.existsSync(targetPath)) {
      throw new Error(
        `Migration would overwrite existing file: ${targetPath}. ` +
        'Remove it manually or rename before migrating.',
      );
    }
  }

  // Phase 3: Write all merged files
  for (const { entry, unified, targetPath } of prepared) {
    const targetDir = path.join(basePath, entry.layer);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    fs.writeFileSync(
      targetPath,
      JSON.stringify(unified, null, 2) + '\n',
      { encoding: 'utf-8' },
    );
  }

  // Phase 4: Remove old stage directories (only after all writes succeeded)
  for (const stage of ['conceptual', 'logical']) {
    const stageDir = path.join(basePath, stage);
    if (fs.existsSync(stageDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  return scan.domains.length;
}

/**
 * Check whether old v1/v2 stage directories exist and contain domain files.
 * Returns false for empty stage directories (no false positives).
 */
export function hasLegacyLayout(
  projectPath: string,
  semanticDir: string,
): boolean {
  const scan = scanV2Domains(projectPath, semanticDir);
  return scan.domains.length > 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface OldDomainFile {
  description: string;
  modelFolder?: string;
  models: unknown[];
  relationships: unknown[];
  viewConfig: Record<string, unknown>;
}

function readOldDomainFile(filePath: string): OldDomainFile {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  return {
    description: typeof parsed.description === 'string' ? parsed.description : '',
    modelFolder: typeof parsed.modelFolder === 'string' ? parsed.modelFolder : undefined,
    models: Array.isArray(parsed.models) ? parsed.models : [],
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    viewConfig: parsed.viewConfig && typeof parsed.viewConfig === 'object' && !Array.isArray(parsed.viewConfig)
      ? (parsed.viewConfig as Record<string, unknown>)
      : {},
  };
}

function extractStageData(data: OldDomainFile | null): StageData {
  if (!data) {
    return { ...EMPTY_STAGE_DATA };
  }

  return {
    models: data.models as StageData['models'],
    relationships: data.relationships as StageData['relationships'],
  };
}
