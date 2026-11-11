/**
 * Reading the editing host's `CanvasContext` (the detail panel's File line
 * and "Not on this diagram" list, the node's "+n" chip). A viewer never has
 * one, so every helper answers "nothing" for a null context.
 */
import type { CanvasContext, DisplaySubjectArea, OffDiagramRelationship } from '@erd-studio/core';

const NONE: readonly OffDiagramRelationship[] = Object.freeze([]);

/** `record[key]` when it is the record's own key: a table named `constructor` is not `Object.prototype.constructor`. */
export function ownValue<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Each domain's table names, lower-cased, worked out once per domain object. */
const namesByDomain = new WeakMap<DisplaySubjectArea, ReadonlySet<string>>();

function diagramNames(domain: DisplaySubjectArea): ReadonlySet<string> {
  let names = namesByDomain.get(domain);
  if (!names) {
    names = new Set(domain.models.map((m) => m.name.toLowerCase()));
    namesByDomain.set(domain, names);
  }
  return names;
}

/**
 * The table's relationships to tables not on the diagram, as the host sent
 * them, less any whose other table is on the diagram now (added since the
 * context was worked out). Logical stage only.
 */
export function offDiagramRows(
  context: CanvasContext | null,
  domain: DisplaySubjectArea | null,
  modelName: string,
): readonly OffDiagramRelationship[] {
  if (!context || !domain || domain.stage !== 'logical') return NONE;
  const rows = ownValue(context.offDiagram, modelName);
  if (!Array.isArray(rows) || rows.length === 0) return NONE;
  const names = diagramNames(domain);
  const off = rows.filter((r) => !names.has(r.otherTable.toLowerCase()));
  return off.length === rows.length ? rows : off;
}

/**
 * The distinct tables of `rows`, in their order, each with its file where
 * the host named it (`otherTablePath`): two tables of one name in different
 * schema folders are two tables then.
 */
export function offDiagramTableRows(rows: readonly OffDiagramRelationship[]): Array<{ otherTable: string; otherTablePath?: string }> {
  const seen = new Set<string>();
  const out: Array<{ otherTable: string; otherTablePath?: string }> = [];
  for (const r of rows) {
    const key = r.otherTablePath !== undefined ? `\u0000${r.otherTablePath}` : r.otherTable.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.otherTablePath !== undefined ? { otherTable: r.otherTable, otherTablePath: r.otherTablePath } : { otherTable: r.otherTable });
  }
  return out;
}

/** The distinct tables of `rows`, in their order. */
export function offDiagramTables(rows: readonly OffDiagramRelationship[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of rows) {
    if (seen.has(r.otherTable.toLowerCase())) continue;
    seen.add(r.otherTable.toLowerCase());
    out.push(r.otherTable);
  }
  return out;
}

/** `many-to-one` as a reader writes it: `Many-to-one`. */
export function cardinalityLabel(cardinality: string): string {
  return cardinality.length > 0 ? cardinality[0].toUpperCase() + cardinality.slice(1) : cardinality;
}

/** The "+n" chip's tip. */
export function offDiagramChipTip(count: number): string {
  return count === 1
    ? '1 relationship to a table not on this diagram'
    : `${count} relationships to tables not on this diagram`;
}
