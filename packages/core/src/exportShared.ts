/**
 * The traversal the diagram exporters share (`exportDbml.ts`,
 * `exportDbmlRich.ts` with its `erd_layout`, and `exportMermaid.ts`): one tolerant pass over a `DisplaySubjectArea` that settles
 * which models, columns and relationships an export describes, in what order,
 * and why anything was left out. The formats differ only in syntax and in how
 * much of each model they carry, so they always describe the same relationships.
 *
 * The input may come from an older core (a cached `DisplaySubjectArea`), so every
 * optional field may be absent and the required ones may still be malformed:
 * a column without a text name, a model listed twice, a relationship to a
 * model that is not in the diagram. Nothing here throws on such input; what
 * cannot be exported is reported as a reason the exporters print as a
 * comment.
 *
 * Internal to core — not re-exported from the package entry.
 */

import type { DisplaySubjectArea } from './types/display.js';
import type { Rationale } from './types/semantic.js';
import { backwardsRelationshipNote, compositeGroupProblem, foreignKeyAtTo, linkKey } from './relationships.js';

/** Rationale keys in display order, with the label an export prints. */
export const RATIONALE_LABELS: ReadonlyArray<readonly [keyof Rationale, string]> = [
  ['purpose', 'Purpose'],
  ['design', 'Design'],
  ['grainChoice', 'Grain choice'],
  ['roleChoice', 'Role choice'],
  ['scdStrategy', 'SCD strategy'],
  ['measures', 'Measures'],
];

/** Cardinalities an export can draw. Anything else is skipped with a reason. */
export type ExportCardinality = 'many-to-one' | 'one-to-many' | 'one-to-one' | 'many-to-many';
const CARDINALITIES: ReadonlySet<string> = new Set(['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many']);

/** A `meta` map split into the entries an export can carry and the rest. */
export interface ExportMeta {
  /** Plain values (text, yes/no) as text, in the map's key order. */
  text: Array<readonly [string, string]>;
  /** Keys whose value is a list, a map or empty — named, never exported. */
  other: string[];
  /** Every entry as the map holds it, in key order (the rich DBML export writes them all). */
  entries: Array<readonly [string, unknown]>;
}

export interface ExportColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  /** The model file's own foreign-key flag (`DisplayColumn.isForeignKeyDeclared`); `isForeignKey` is the badge. */
  isForeignKeyDeclared: boolean;
  isNaturalKey: boolean;
  scdType?: number;
  additiveType?: string;
  meta: ExportMeta;
}

export interface ExportTable {
  name: string;
  /** Empty when the model names no schema. */
  schema: string;
  alias?: string;
  description: string;
  grain?: string;
  modelRole?: string;
  /** Non-empty rationale entries as `[label, text]`, in `RATIONALE_LABELS` order. */
  rationale: Array<readonly [string, string]>;
  /** The same entries keyed by rationale key, in the same order. */
  rationaleEntries: Array<readonly [keyof Rationale, string]>;
  meta: ExportMeta;
  loadError?: { kind: string; line?: number };
  columns: ExportColumn[];
  /** Columns left out of this model, one sentence each. */
  skippedColumns: string[];
}

/** A model to export, or one left out (listed twice, or without a name). */
export type TableItem = { kind: 'model'; model: ExportTable } | { kind: 'skipped'; text: string };

export interface ExportLink {
  from: ExportTable;
  /** The from end's columns, spelled as the model spells them. Two or more for a composite. */
  fromColumns: string[];
  to: ExportTable;
  toColumns: string[];
  cardinality: ExportCardinality;
  role?: string;
  /** The keys contradict its direction (`DisplayRelationship.keysContradict`, #163): written with a comment. */
  keysContradict?: true;
}

/** A relationship to export, or one left out with its reason. */
export type LinkItem = { kind: 'link'; link: ExportLink } | { kind: 'skipped'; text: string; reason: string };

export interface ExportSticky {
  text: string;
  linkedModel?: string;
  /** The note's colour as stored (`AnnotationColor`), when it has one. */
  color?: string;
  /** The note's box on the canvas, as stored (rich DBML writes it in `erd_layout`); absent when not a finite x and y. */
  box?: { x: number; y: number; width?: number; height?: number };
}

export interface PreparedSubjectArea {
  name: string;
  layer: string;
  stage: string;
  description: string;
  models: TableItem[];
  links: LinkItem[];
  stickies: ExportSticky[];
}

/** Text of a value that should be text: strings as they are, numbers and booleans as text, else `''`. */
export function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return '';
}

/** `value` on one line: line breaks and other control characters become spaces, ends trimmed. */
export function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

const lower = (s: string): string => s.toLowerCase();

function readMeta(value: unknown): ExportMeta {
  const meta: ExportMeta = { text: [], other: [], entries: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return meta;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    meta.entries.push([key, entry]);
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') {
      meta.text.push([key, String(entry)]);
    } else {
      meta.other.push(key);
    }
  }
  return meta;
}

function readColumn(raw: Record<string, unknown>, name: string): ExportColumn {
  const column: ExportColumn = {
    name,
    dataType: text(raw.dataType),
    description: text(raw.description),
    isPrimaryKey: raw.isPrimaryKey === true,
    isForeignKey: raw.isForeignKey === true,
    isForeignKeyDeclared: raw.isForeignKeyDeclared === true,
    isNaturalKey: raw.isNaturalKey === true,
    meta: readMeta(raw.meta),
  };
  if (typeof raw.scdType === 'number' && Number.isFinite(raw.scdType)) column.scdType = raw.scdType;
  const additive = text(raw.additiveType);
  if (additive) column.additiveType = additive;
  return column;
}

function readTable(raw: Record<string, unknown>, name: string): ExportTable {
  const model: ExportTable = {
    name,
    schema: text(raw.schema).trim(),
    description: text(raw.description),
    rationale: [],
    rationaleEntries: [],
    meta: readMeta(raw.meta),
    columns: [],
    skippedColumns: [],
  };
  const alias = text(raw.alias).trim();
  if (alias) model.alias = alias;
  const grain = text(raw.grain);
  if (grain.trim()) model.grain = grain;
  const role = text(raw.modelRole).trim();
  if (role) model.modelRole = role;
  const rationale = raw.rationale && typeof raw.rationale === 'object' ? (raw.rationale as Record<string, unknown>) : {};
  for (const [key, label] of RATIONALE_LABELS) {
    const value = text(rationale[key]);
    if (value.trim()) {
      model.rationale.push([label, value]);
      model.rationaleEntries.push([key, value]);
    }
  }
  if (raw.loadError && typeof raw.loadError === 'object') {
    const error = raw.loadError as Record<string, unknown>;
    model.loadError = { kind: text(error.kind) || 'unknown' };
    if (typeof error.line === 'number' && Number.isFinite(error.line)) model.loadError.line = error.line;
  }
  const seen = new Set<string>();
  const columns = Array.isArray(raw.columns) ? raw.columns : [];
  columns.forEach((entry, index) => {
    const col = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const colName = text(col.name);
    if (!colName.trim()) {
      model.skippedColumns.push(`column ${index + 1} has no name`);
      return;
    }
    if (seen.has(lower(colName))) {
      model.skippedColumns.push(`column ${oneLine(colName)} is listed more than once`);
      return;
    }
    seen.add(lower(colName));
    model.columns.push(readColumn(col, colName));
  });
  return model;
}

/** How a link reads in a comment: `a.x -> b.y`, or `a.(x, y) -> b.(u, v)` for a composite. */
export function describeEnds(fromModel: string, fromColumns: string[], toModel: string, toColumns: string[]): string {
  const part = (s: string): string => oneLine(s) || '?';
  const end = (model: string, cols: string[]): string =>
    `${part(model)}.${cols.length === 1 ? part(cols[0]) : `(${cols.map(part).join(', ')})`}`;
  return `${end(fromModel, fromColumns)} -> ${end(toModel, toColumns)}`;
}

interface RawLink {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: string;
  role?: string;
  compositeKey?: string;
  keysContradict?: true;
}

function readRawLink(entry: unknown): RawLink {
  const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
  const link: RawLink = {
    fromModel: text(raw.fromModel),
    fromColumn: text(raw.fromColumn),
    toModel: text(raw.toModel),
    toColumn: text(raw.toColumn),
    cardinality: text(raw.cardinality),
  };
  const role = oneLine(text(raw.role));
  if (role) link.role = role;
  const compositeKey = text(raw.compositeKey).trim();
  if (compositeKey) link.compositeKey = compositeKey;
  if (raw.keysContradict === true) link.keysContradict = true;
  return link;
}

/**
 * The relationships as the canvas draws them: a composite foreign key's
 * members (entries sharing a `compositeKey` between the same two models) as
 * one group at its first member's place, everything else on its own. A group
 * that is not a valid composite (#133 L2) is not folded.
 */
function groupLinks(raw: RawLink[]): RawLink[][] {
  const idOf = (r: RawLink): string => [r.fromModel, r.toModel, r.compositeKey ?? ''].map(lower).join('\u0000');
  const groups = new Map<string, RawLink[]>();
  for (const r of raw) {
    if (r.compositeKey) groups.set(idOf(r), [...(groups.get(idOf(r)) ?? []), r]);
  }
  const out: RawLink[][] = [];
  const placed = new Set<string>();
  for (const r of raw) {
    const members = r.compositeKey ? groups.get(idOf(r))! : [r];
    if (members.length < 2) {
      out.push([r]);
      continue;
    }
    const asRelationships = members.map((m) => ({ ...m, cardinality: m.cardinality as ExportCardinality }));
    if (compositeGroupProblem(asRelationships) !== null) {
      out.push([r]);
      continue;
    }
    if (placed.has(idOf(r))) continue;
    placed.add(idOf(r));
    out.push(members);
  }
  return out;
}

/** Find by exact name, then without case. */
function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  return items.find((i) => i.name === name) ?? items.find((i) => lower(i.name) === lower(name));
}

function resolveLinks(raw: RawLink[], models: ExportTable[]): LinkItem[] {
  const items: LinkItem[] = [];
  const exported = new Set<string>();
  for (const members of groupLinks(raw)) {
    const first = members[0];
    const description = describeEnds(
      first.fromModel,
      members.map((m) => m.fromColumn),
      first.toModel,
      members.map((m) => m.toColumn),
    );
    const skip = (reason: string): void => {
      items.push({ kind: 'skipped', text: description, reason });
    };
    if (!first.fromModel.trim() || !first.toModel.trim()) {
      skip('it does not name both of its tables');
      continue;
    }
    const from = findByName(models, first.fromModel);
    const to = findByName(models, first.toModel);
    if (!from) {
      skip(`${oneLine(first.fromModel)} is not in this diagram`);
      continue;
    }
    if (!to) {
      skip(`${oneLine(first.toModel)} is not in this diagram`);
      continue;
    }
    if (!CARDINALITIES.has(first.cardinality)) {
      skip(`its cardinality "${oneLine(first.cardinality)}" is not one an export can draw`);
      continue;
    }
    const fromColumns: string[] = [];
    const toColumns: string[] = [];
    let missing: string | null = null;
    for (const m of members) {
      const fc = findByName(from.columns, m.fromColumn);
      const tc = findByName(to.columns, m.toColumn);
      if (!fc) {
        missing = `${oneLine(from.name)} has no column ${oneLine(m.fromColumn) || '(blank)'}`;
        break;
      }
      if (!tc) {
        missing = `${oneLine(to.name)} has no column ${oneLine(m.toColumn) || '(blank)'}`;
        break;
      }
      if (from === to && fc === tc) {
        missing = 'a column cannot point at itself';
        break;
      }
      fromColumns.push(fc.name);
      toColumns.push(tc.name);
    }
    if (missing) {
      skip(missing);
      continue;
    }
    const identity = fromColumns
      .map((c, i) => linkKey({ fromModel: from.name, fromColumn: c, toModel: to.name, toColumn: toColumns[i] }))
      .sort()
      .join('\u0001');
    if (exported.has(identity)) {
      skip('the same link is already exported');
      continue;
    }
    exported.add(identity);
    const role = members.map((m) => m.role).find((r) => r !== undefined);
    items.push({
      kind: 'link',
      link: {
        from,
        fromColumns,
        to,
        toColumns,
        cardinality: first.cardinality as ExportCardinality,
        ...(role ? { role } : {}),
        ...(members.some((m) => m.keysContradict) ? { keysContradict: true as const } : {}),
      },
    });
  }
  return items;
}

/** The canvas's ⚠ sentence for a link drawn backwards (#163), on one line. */
export function backwardsNoteOf(link: ExportLink): string {
  return backwardsRelationshipNote(
    { fromModel: oneLine(link.from.name), toModel: oneLine(link.to.name), cardinality: link.cardinality },
    link.fromColumns.map((c, i) => ({ fromColumn: oneLine(c), toColumn: oneLine(link.toColumns[i]) })),
  );
}

/** Read a `DisplaySubjectArea` into what an export describes. Never throws. */
export function prepareSubjectArea(domain: DisplaySubjectArea): PreparedSubjectArea {
  const input = (domain && typeof domain === 'object' ? domain : {}) as unknown as Record<string, unknown>;
  const modelItems: TableItem[] = [];
  const models: ExportTable[] = [];
  const seen = new Set<string>();
  const rawModels = Array.isArray(input.models) ? input.models : [];
  rawModels.forEach((entry, index) => {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const name = text(raw.name);
    if (!name.trim()) {
      modelItems.push({ kind: 'skipped', text: `table ${index + 1} has no name` });
      return;
    }
    if (seen.has(lower(name))) {
      modelItems.push({ kind: 'skipped', text: `${oneLine(name)} is listed more than once; exported once` });
      return;
    }
    seen.add(lower(name));
    const model = readTable(raw, name);
    models.push(model);
    modelItems.push({ kind: 'model', model });
  });

  const rawLinks = (Array.isArray(input.relationships) ? input.relationships : []).map(readRawLink);

  const viewConfig = input.viewConfig && typeof input.viewConfig === 'object' ? (input.viewConfig as Record<string, unknown>) : {};
  const stickies: ExportSticky[] = [];
  for (const entry of Array.isArray(viewConfig.annotations) ? viewConfig.annotations : []) {
    const raw = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const body = text(raw.text);
    if (!body.trim()) continue;
    const linked = text(raw.linkedModel).trim();
    const color = text(raw.color).trim();
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const box = finite(raw.x) && finite(raw.y)
      ? { x: raw.x, y: raw.y, ...(finite(raw.width) ? { width: raw.width } : {}), ...(finite(raw.height) ? { height: raw.height } : {}) }
      : undefined;
    stickies.push({ text: body, ...(linked ? { linkedModel: linked } : {}), ...(color ? { color } : {}), ...(box ? { box } : {}) });
  }

  return {
    name: text(input.domain),
    layer: text(input.layer),
    stage: text(input.stage),
    description: text(input.description),
    models: modelItems,
    links: resolveLinks(rawLinks, models),
    stickies,
  };
}

/** The columns a link leaves from — the foreign key: the to end for a one-to-many, else the from end. */
export function foreignKeyColumns(link: ExportLink): { model: ExportTable; columns: string[] } {
  return foreignKeyAtTo(link.cardinality)
    ? { model: link.to, columns: link.toColumns }
    : { model: link.from, columns: link.fromColumns };
}
