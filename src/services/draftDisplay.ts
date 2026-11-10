/**
 * Draft-first: the diagram a draft shows, built in memory by core's own
 * pipeline (spec `docs/dev/draft-first.md` §13 P1), so the preview draws
 * exactly what the canvas draws after Keep. Nothing here reads or writes a
 * file: tables come in as values (an import plan, a dbt draft) or as an
 * in-memory file map (a bundled example project).
 *
 * Pure: no `vscode`, no Node built-ins.
 */

import {
  buildUnifiedSubjectArea,
  computeMissingPositions,
  loadDisplaySubjectArea,
  toDisplaySubjectArea,
  toLogicalStage,
  validateSubjectAreaDocument,
  type LayerLookup,
} from '@erd-studio/core';
import { dbmlStorageReader } from '@erd-studio/core/dbml';
import type { DisplaySubjectArea } from '../types/display';
import type { DraftSchemaCount } from '../types/draft';
import type { LayerConfig } from '../types/layer';
import type { NodePosition, Relationship, SemanticTable, ViewConfig } from '../types/semantic';

/** The schema version of the in-memory document (v5: model names, relationships beside them). */
const DRAFT_DOCUMENT_SCHEMA_VERSION = 5;

/** The limits a bundled example is read with (`loadDisplaySubjectArea`'s, every one set). */
export const DRAFT_FILE_LIMITS = Object.freeze({
  maxParallelReads: 8,
  maxModels: 1000,
  maxYamlNodes: 50_000,
  maxDomainChars: 2 * 1024 * 1024,
  maxYamlChars: 1024 * 1024,
  maxRelationshipsChars: 4 * 1024 * 1024,
});

export interface DraftDisplay {
  display: DisplaySubjectArea;
  /** No table has a stored position: the page lays the diagram out (`isFreshLayout`'s rule). */
  autoLayout: boolean;
}

export interface DisplayFromTablesInput {
  /** The diagram's name. */
  name: string;
  /** Its layer id. */
  layer: string;
  description?: string;
  /** Every table drawn, in order (new, reused and changed library tables alike). */
  tables: readonly SemanticTable[];
  /** Every relationship drawn (each link once, a composite as its column pairs). */
  relationships: readonly Relationship[];
  /** Stored positions and sticky notes, when the source has them. */
  viewConfig?: ViewConfig;
  layers: readonly LayerConfig[];
}

/** No warning from a draft's own pipeline reaches anyone: the draft is never written. */
const quiet = (): void => {};

/** A table without its own `relationships`: the draft passes every link once, beside the tables. */
function withoutRelationships(table: SemanticTable): SemanticTable {
  const { relationships: _relationships, ...rest } = table;
  return { ...rest, columns: (rest.columns ?? []).map((c) => ({ ...c })) };
}

/** Whether no table of `names` has an entry in `positions` (and there is a table). */
function noTablePositioned(names: readonly string[], positions: Readonly<Record<string, NodePosition>> | undefined): boolean {
  if (names.length === 0) return false;
  const stored = positions ?? {};
  return names.every((name) => !Object.prototype.hasOwnProperty.call(stored, name) || !stored[name]);
}

/**
 * A draft's diagram from tables in memory: a v5 document run through core's
 * pipeline (`validateSubjectAreaDocument` → `buildUnifiedSubjectArea` →
 * `computeMissingPositions` → `toLogicalStage` → `toDisplaySubjectArea`),
 * read-only. Each table's own `relationships` are dropped so each link is
 * drawn once, from `relationships`.
 */
export function displayFromTables(input: DisplayFromTablesInput): DraftDisplay {
  const filePath = `${input.layer}/${input.name}.json`;
  const tables = input.tables.map(withoutRelationships);
  const byName = new Map<string, SemanticTable>();
  const byLowerName = new Map<string, SemanticTable>();
  for (const t of tables) {
    if (!byName.has(t.name)) byName.set(t.name, t);
    if (!byLowerName.has(t.name.toLowerCase())) byLowerName.set(t.name.toLowerCase(), t);
  }
  const viewConfig: ViewConfig = {
    ...(input.viewConfig ?? {}),
    ...(input.viewConfig?.positions ? { positions: { ...input.viewConfig.positions } } : {}),
    ...(input.viewConfig?.annotations ? { annotations: input.viewConfig.annotations.map((a) => ({ ...a })) } : {}),
  };
  const document = {
    schemaVersion: DRAFT_DOCUMENT_SCHEMA_VERSION,
    domain: input.name,
    layer: input.layer,
    description: input.description ?? '',
    logical: {
      models: tables.map((t) => t.name),
      relationships: input.relationships.map((r) => ({ ...r })),
    },
    viewConfig,
  };
  const { obj, format } = validateSubjectAreaDocument(document, filePath);
  // The draft's own layer always resolves, even before `layers.json` has it (a new project's first Keep writes it).
  const layerIds = [...new Set([...input.layers.map((l) => l.id), input.layer])];
  const layers: LayerLookup = { hasLayer: (id) => layerIds.includes(id), getValidLayerIds: () => [...layerIds] };
  const unified = buildUnifiedSubjectArea(obj, format, {
    filePath,
    domainNameFallback: input.name,
    parentDirName: input.layer,
    layers,
    getModel: (name) => {
      const table = byName.get(name) ?? byLowerName.get(name.toLowerCase());
      return table ? { ...table, columns: (table.columns ?? []).map((c) => ({ ...c })) } : null;
    },
    warn: quiet,
  });
  const autoLayout = noTablePositioned(unified.logical.models.map((m) => m.name), unified.viewConfig.positions);
  const computed = computeMissingPositions(unified);
  if (computed) unified.viewConfig.positions = { ...(unified.viewConfig.positions ?? {}), ...computed };
  const display = toDisplaySubjectArea(toLogicalStage(unified), {
    viewConfig: unified.viewConfig,
    stubColumns: unified.stubColumns,
    layerConfig: input.layers.find((l) => l.id === unified.layer),
    readOnly: true,
  });
  return { display, autoLayout };
}

export interface DisplayFromFilesInput {
  /** Every file of the project, by posix path (`.erd-studio/gold/diagrams/sales.dbml`). */
  files: Readonly<Record<string, string>>;
  /** The diagram to draw, a key of `files`. */
  domainPath: string;
}

/**
 * A draft's diagram from files in memory (a bundled example project): core's
 * `loadDisplaySubjectArea` with a `readFile` over `files` (a missing file is
 * null), the DBML readers and every limit set, read-only. Rejects as
 * `loadDisplaySubjectArea` does.
 */
export async function displayFromFiles(input: DisplayFromFilesInput): Promise<DraftDisplay> {
  const { files, domainPath } = input;
  const has = (p: string): boolean => Object.prototype.hasOwnProperty.call(files, p);
  const display = await loadDisplaySubjectArea({
    domainPath,
    readFile: async (p) => (has(p) ? files[p] : null),
    readOnly: true,
    dbml: dbmlStorageReader,
    warn: quiet,
    ...DRAFT_FILE_LIMITS,
  });
  return { display, autoLayout: noTablePositioned(display.models.map((m) => m.name), storedPositions(files, domainPath)) };
}

/** The positions the diagram file itself stores (before core places the rest), or undefined when it cannot be read. */
function storedPositions(files: Readonly<Record<string, string>>, domainPath: string): Record<string, NodePosition> | undefined {
  const text = Object.prototype.hasOwnProperty.call(files, domainPath) ? files[domainPath] : undefined;
  if (text === undefined) return undefined;
  try {
    const document: unknown = domainPath.toLowerCase().endsWith('.dbml')
      ? dbmlStorageReader.parseSubjectArea(text, domainPath).obj
      : JSON.parse(text);
    const { obj, format } = validateSubjectAreaDocument(document, domainPath);
    const unified = buildUnifiedSubjectArea(obj, format, {
      filePath: domainPath,
      domainNameFallback: 'draft',
      parentDirName: '',
      layers: { hasLayer: () => true, getValidLayerIds: () => [] },
      warn: quiet,
    });
    return unified.viewConfig.positions;
  } catch {
    return undefined;
  }
}

/** Tables counted by schema (`''`: no schema), biggest first, then by name. */
export function draftSchemas(tables: readonly { schema?: string }[]): DraftSchemaCount[] {
  const counts = new Map<string, number>();
  for (const t of tables) {
    const schema = t.schema ?? '';
    counts.set(schema, (counts.get(schema) ?? 0) + 1);
  }
  return [...counts]
    .map(([schema, n]) => ({ schema, tables: n }))
    .sort((a, b) => b.tables - a.tables || a.schema.localeCompare(b.schema, 'en', { numeric: true }));
}
