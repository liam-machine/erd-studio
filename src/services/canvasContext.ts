/**
 * The canvas context (`canvasContext` message): what the host knows about
 * the project beyond the open diagram, for the detail panel's File line and
 * "Not on this diagram" list and the node's "+n" chip.
 *
 * Pure: the host reads the library and the files, this only arranges them,
 * so it is testable without VS Code and never writes. Relationships come
 * from the Table Library only (every Ref of a DBML project, not just the
 * relationships files the diagram imports; each FK table's own list in a
 * YAML project), arranged by the Relationships view's own
 * `buildRelationshipsOverview`, so a composite key is one row and a
 * relationship is read from its foreign-key end everywhere.
 */
import type { CanvasContext, OffDiagramRelationship } from '@erd-studio/core';
import type { SemanticTable } from '../types/semantic';
import { buildRelationshipsOverview, columnList } from './relationshipsOverview';

export interface CanvasContextInput {
  /** The diagram's table names, as the canvas shows them. */
  readonly members: readonly string[];
  /** The Table Library's tables, with their relationships attached. */
  readonly libraryTables: readonly SemanticTable[];
  /** A table's file, project-relative with `/` separators, or undefined when it has none. */
  readonly fileOf: (name: string) => string | undefined;
  /** The label of the layer a table lives in, when it has one (DBML storage). */
  readonly layerLabelOf?: (name: string) => string | undefined;
  /** The diagram's own layer label: another table in it is not named as "in" it. */
  readonly diagramLayerLabel?: string;
  /** Who reviews a change to a table's file (CODEOWNERS), none when nobody does. */
  readonly ownersOf?: (name: string) => readonly string[];
}

const lower = (s: string): string => s.trim().toLowerCase();

/** The joining columns as one line: `a`, `(a, b)`, or `a → b` when the ends are named differently. */
export function joinColumnsText(fromColumns: readonly string[], toColumns: readonly string[]): string {
  const from = columnList(fromColumns);
  const to = columnList(toColumns);
  return lower(from) === lower(to) ? from : `${from} → ${to}`;
}

/**
 * Build the context for one diagram. A relationship to a table the library
 * does not have is left out (there is nothing to add); so is one whose two
 * ends are both on the diagram, or both off it.
 */
export function buildCanvasContext(input: CanvasContextInput): CanvasContext {
  const onDiagram = new Map<string, string>();
  for (const name of input.members) if (!onDiagram.has(lower(name))) onDiagram.set(lower(name), name);

  // Maps, then `Object.fromEntries`: a table named `constructor` or
  // `__proto__` is an own key, never the object's prototype.
  const tableFiles = new Map<string, string>();
  const owners = new Map<string, string>();
  for (const name of onDiagram.values()) {
    const file = input.fileOf(name);
    if (file !== undefined) tableFiles.set(name, file);
    const who = input.ownersOf?.(name) ?? [];
    if (who.length > 0) owners.set(name, who.join(', '));
  }

  const overview = buildRelationshipsOverview(input.libraryTables);
  const offDiagram = new Map<string, OffDiagramRelationship[]>();
  const diagramLayer = input.diagramLayerLabel !== undefined ? lower(input.diagramLayerLabel) : undefined;
  for (const entry of overview.entries) {
    if (entry.problems.some((p) => p.kind === 'missingTable')) continue;
    const fromOn = onDiagram.get(lower(entry.fromModel));
    const toOn = onDiagram.get(lower(entry.toModel));
    if ((fromOn === undefined) === (toOn === undefined)) continue;
    const member = (fromOn ?? toOn)!;
    const otherTable = fromOn !== undefined ? entry.toModel : entry.fromModel;
    const layer = input.layerLabelOf?.(otherTable);
    const row: OffDiagramRelationship = {
      otherTable,
      ...(layer !== undefined && lower(layer) !== diagramLayer ? { otherLayer: layer } : {}),
      columns: joinColumnsText(entry.fromColumns, entry.toColumns),
      cardinality: entry.cardinality,
      direction: fromOn !== undefined ? 'out' : 'in',
    };
    const rows = offDiagram.get(member);
    if (rows) rows.push(row);
    else offDiagram.set(member, [row]);
  }
  for (const rows of offDiagram.values()) {
    rows.sort((a, b) => a.otherTable.localeCompare(b.otherTable) || a.columns.localeCompare(b.columns));
  }

  return {
    tableFiles: Object.fromEntries(tableFiles),
    offDiagram: Object.fromEntries(offDiagram),
    ...(owners.size > 0 ? { owners: Object.fromEntries(owners) } : {}),
  };
}
