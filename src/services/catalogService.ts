/**
 * CatalogService — reads dbt's `target/catalog.json` (written by
 * `dbt docs generate`) so the physical stage can show the columns and types
 * the warehouse actually has, rather than the `data_type:` strings dbt copies
 * out of the schema .yml files into the manifest.
 *
 * Parsed on the extension host, not in a worker: a catalog is a fraction of
 * the size of a manifest (one entry per built relation, no macros, no compiled
 * SQL) and, unlike the manifest, nothing downstream needs a stale/missing
 * resilience contract — the catalog is pure enrichment, so every failure mode
 * (absent, mid-write, malformed, oversized) collapses to the same answer:
 * `undefined`, meaning "carry on exactly as if dbt docs had never been run".
 *
 * Imports only fs, nameUtils, dbtProjectConfig and the catalog types — never
 * vscode, so it stays inside the mcp-server type-check closure.
 */

import * as fs from 'fs';

import { normaliseName } from './nameUtils';
import {
  defaultDbtProjectConfig,
  resolveCatalogPath,
  type DbtProjectConfig,
} from './dbtProjectConfig';
import type {
  CatalogColumn,
  CatalogData,
  CatalogNodeInfo,
  CatalogResourceType,
} from '../types/catalog';

/**
 * Upper bound on a catalog we are willing to read into memory. A catalog is
 * far smaller than a manifest for the same project, so anything past this is
 * a sign of something other than what we expect; refusing it keeps a
 * pathological file from blocking the extension host in JSON.parse.
 */
export const DEFAULT_CATALOG_MAX_BYTES = 64 * 1024 * 1024;

const RESOURCE_PREFIXES = new Set<string>(['model', 'seed', 'snapshot']);

export interface CatalogServiceOptions {
  /** dbt project paths. Only `target-path` bears on where catalog.json lives. */
  dbtConfig?: Partial<DbtProjectConfig>;
  /** Refuse to read a catalog larger than this. Defaults to {@link DEFAULT_CATALOG_MAX_BYTES}. */
  maxBytes?: number;
  /**
   * Told when a catalog exists but cannot be used (unreadable, malformed or
   * over the size limit) — never for an absent one. The extension host counts
   * these for usage telemetry.
   */
  onReadFailure?: () => void;
}

export class CatalogService {
  /** Undefined means "no usable catalog"; `loaded` is what distinguishes that from "not read yet". */
  private cache: CatalogData | undefined;
  private loaded = false;
  private loadPromise: Promise<CatalogData | undefined> | null = null;
  private loadId = 0;

  private readonly dbtConfig: DbtProjectConfig;
  private readonly maxBytes: number;
  private readonly onReadFailure?: () => void;

  /** Zero-arg construction must work, mirroring `new ManifestService()`. */
  constructor(options: CatalogServiceOptions = {}) {
    const defaults = defaultDbtProjectConfig();
    const overrides = options.dbtConfig ?? {};
    this.dbtConfig = {
      ...defaults,
      ...overrides,
      targetPath: overrides.targetPath || defaults.targetPath,
    };
    this.maxBytes = options.maxBytes ?? DEFAULT_CATALOG_MAX_BYTES;
    this.onReadFailure = options.onReadFailure;
  }

  /** Absolute path of the catalog this service reads for `projectPath`. */
  getCatalogPath(projectPath: string): string {
    return resolveCatalogPath(projectPath, this.dbtConfig);
  }

  /**
   * Read and index the catalog, caching the result (including the "there
   * isn't one" result) until {@link invalidate} is called. Concurrent calls
   * share one read.
   */
  async loadCatalog(projectPath: string): Promise<CatalogData | undefined> {
    if (this.loaded) {
      return this.cache;
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }

    const currentLoadId = ++this.loadId;
    this.loadPromise = this.read(projectPath);
    try {
      const result = await this.loadPromise;
      // Only cache if invalidate() did not fire while we were reading.
      if (currentLoadId === this.loadId) {
        this.cache = result;
        this.loaded = true;
      }
      return result;
    } finally {
      if (currentLoadId === this.loadId) {
        this.loadPromise = null;
      }
    }
  }

  /** Drop the cached catalog so the next load re-reads from disk. */
  invalidate(): void {
    this.loadId++;
    this.cache = undefined;
    this.loaded = false;
    this.loadPromise = null;
  }

  private async read(projectPath: string): Promise<CatalogData | undefined> {
    const catalogPath = this.getCatalogPath(projectPath);
    try {
      const stat = await fs.promises.stat(catalogPath); // throws ENOENT when absent — the common case
      if (stat.size === 0) {
        return undefined; // dbt is mid-write; there is nothing to serve and nothing to warn about
      }
      if (stat.size > this.maxBytes) {
        console.warn(
          `[CatalogService] ${catalogPath} is ${stat.size} bytes ` +
            `(limit ${this.maxBytes}) — skipping.`,
        );
        this.onReadFailure?.();
        return undefined;
      }
      const raw = await fs.promises.readFile(catalogPath, 'utf-8');
      return extractCatalogData(JSON.parse(raw) as Record<string, unknown>);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        console.warn(
          `[CatalogService] Could not read ${catalogPath}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        this.onReadFailure?.();
      }
      // Absent, unreadable or malformed — all the same answer to the caller.
      return undefined;
    }
  }
}

/**
 * Pure: a parsed catalog.json object → indexed {@link CatalogData}.
 *
 * Exported beside the service rather than from a `src/workers/` module
 * because there is no catalog worker and therefore no serialisation boundary
 * to sit on; it is here so it can be unit-tested against object literals.
 *
 * Anything it does not recognise is skipped rather than rejected — a catalog
 * from a newer dbt, an `--empty-catalog` run or a `--select`ed subset all
 * yield fewer nodes, never an error.
 */
export function extractCatalogData(catalog: Record<string, unknown>): CatalogData {
  const byUniqueId = new Map<string, CatalogNodeInfo>();
  const byName = new Map<string, CatalogNodeInfo>();

  const metadata = catalog.metadata as Record<string, unknown> | undefined;
  const errors = catalog.errors;
  const data: CatalogData = {
    byUniqueId,
    byName,
    generatedAt: typeof metadata?.generated_at === 'string' ? metadata.generated_at : null,
    partial: Array.isArray(errors) && errors.length > 0,
  };

  // `sources` is deliberately ignored: ERD Studio's physical stage is built
  // from models, and a source relation has no logical counterpart to enrich.
  const nodes = catalog.nodes as Record<string, unknown> | undefined;
  if (!nodes || typeof nodes !== 'object' || Array.isArray(nodes)) {
    return data;
  }

  for (const [key, value] of Object.entries(nodes)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const info = extractNode(key, value as Record<string, unknown>);
    if (!info) {
      continue;
    }
    byUniqueId.set(info.uniqueId, info);

    const nameKey = normaliseName(info.name);
    const existing = byName.get(nameKey);
    if (!existing || compareVersionTokens(info.version, existing.version) > 0) {
      byName.set(nameKey, info);
    }
  }

  return data;
}

function extractNode(key: string, node: Record<string, unknown>): CatalogNodeInfo | null {
  const parsed = parseCatalogNodeId(key);
  if (!parsed) {
    return null;
  }

  const metadata = (node.metadata ?? {}) as Record<string, unknown>;

  // `stats` (row counts, bytes, last modified) is ignored — it describes the
  // relation's size, not its shape.
  const rawColumns = node.columns;
  const columns: CatalogColumn[] = [];
  if (rawColumns && typeof rawColumns === 'object' && !Array.isArray(rawColumns)) {
    for (const [columnKey, columnValue] of Object.entries(
      rawColumns as Record<string, unknown>,
    )) {
      if (!columnValue || typeof columnValue !== 'object') {
        continue;
      }
      const column = columnValue as Record<string, unknown>;
      columns.push({
        name: typeof column.name === 'string' && column.name ? column.name : columnKey,
        dataType: typeof column.type === 'string' ? column.type : null,
        comment: typeof column.comment === 'string' ? column.comment : null,
        // An adapter that omits `index` sorts last rather than jumping to the front.
        index: typeof column.index === 'number' ? column.index : Number.MAX_SAFE_INTEGER,
      });
    }
  }
  columns.sort((a, b) => a.index - b.index);
  const topLevel = dropNestedFieldPaths(columns);

  return {
    // `unique_id` is optional and nullable in the catalog v1 schema; where it
    // is present it holds the same value as the map key.
    uniqueId: typeof node.unique_id === 'string' && node.unique_id ? node.unique_id : key,
    resourceType: parsed.resourceType,
    name: parsed.name,
    ...(parsed.version !== undefined ? { version: parsed.version } : {}),
    relationName: typeof metadata.name === 'string' ? metadata.name : '',
    schema: typeof metadata.schema === 'string' ? metadata.schema : '',
    database: typeof metadata.database === 'string' ? metadata.database : null,
    comment: typeof metadata.comment === 'string' ? metadata.comment : null,
    columns: topLevel,
  };
}

/**
 * Drop BigQuery's nested STRUCT/RECORD leaves, keeping only top-level columns.
 *
 * dbt-bigquery's `get_catalog` reads INFORMATION_SCHEMA.COLUMN_FIELD_PATHS and
 * aliases `field_path as column_name`, deliberately, so that nested fields show
 * up in dbt docs. A `STRUCT<city STRING, postcode STRING>` column called
 * `address` therefore arrives as THREE catalog entries: `address`,
 * `address.city` and `address.postcode`. Every other adapter emits one row per
 * column and no dots.
 *
 * Unioned into the rendered column list verbatim, the two leaves become node
 * rows that no schema yml can ever match, so Compare-to-Logical reports them as
 * `extra` and a sync plan offers to add two columns that are not columns. A
 * leaf is only dropped when its own parent is present in the same relation, so
 * a genuine column containing a dot — a quoted identifier, or the nested field
 * documented the dbt-sanctioned way as `- name: address.city` — still survives
 * on the declared side of the union.
 */
function dropNestedFieldPaths(columns: CatalogColumn[]): CatalogColumn[] {
  if (!columns.some((c) => c.name.includes('.'))) {
    return columns;
  }
  const present = new Set(columns.map((c) => normaliseName(c.name)));
  return columns.filter((c) => {
    const dot = c.name.indexOf('.');
    if (dot <= 0) { return true; }
    return !present.has(normaliseName(c.name.slice(0, dot)));
  });
}


/**
 * Split a catalog node key — which is a manifest `unique_id` — into its
 * resource type, short name and optional version token.
 *
 * `model.<project>.<name>` / `seed.…` / `snapshot.…`, optionally suffixed
 * `.v<token>`. dbt version identifiers may be integers (`v2`), floats
 * (`v1.1`, which splits the id into four dotted parts) or arbitrary strings
 * (`vprod`), so a `/^v\d+$/` test would both miss real versions and, without
 * the leading-dot requirement, mistake a model literally named `v2` for one.
 *
 * Returns null for any other node kind (`test.`, `source.`, `operation.`, …).
 */
export function parseCatalogNodeId(
  key: string,
): { resourceType: CatalogResourceType; name: string; version?: string } | null {
  const parts = key.split('.');
  if (parts.length < 3 || !RESOURCE_PREFIXES.has(parts[0])) {
    return null;
  }

  let rest = parts.slice(2).join('.');
  let version: string | undefined;
  const match = rest.match(/\.v([0-9]+(?:\.[0-9]+)*|[A-Za-z0-9_-]+)$/);
  // `match.index > 0` keeps a model whose whole name is `v2` from being read
  // as an empty name at version 2.
  if (match && match.index !== undefined && match.index > 0) {
    version = match[1];
    rest = rest.slice(0, match.index);
  }
  if (!rest) {
    return null;
  }

  return { resourceType: parts[0] as CatalogResourceType, name: rest, version };
}

/**
 * Order two version tokens: numeric when both parse as numbers (so `v10`
 * beats `v9`), lexicographic otherwise (`vprod` vs `vstaging`). An
 * unversioned node sorts lowest, so any versioned node wins the name index.
 */
function compareVersionTokens(a?: string, b?: string): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return -1;
  }
  if (b === undefined) {
    return 1;
  }
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isFinite(numA) && Number.isFinite(numB)) {
    return numA === numB ? 0 : numA < numB ? -1 : 1;
  }
  return a < b ? -1 : 1;
}
