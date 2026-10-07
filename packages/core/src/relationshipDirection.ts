/**
 * Which way a relationship points, from evidence — never a silent guess
 * (issue #133).
 *
 * A relationship points from the column that refers to a key (the "many"
 * side, the foreign key) at the key it refers to. Key flags in the model files
 * say that for certain; dbt tests say it likely; with neither, or when they
 * disagree, the answer is "ambiguous" and the user decides. Ties are never
 * broken by which end a drag started on: the result depends only on the
 * evidence, and is the same whichever end is passed first.
 */

import type { Cardinality, SemanticModel } from './types/semantic.js';
import type { DbtColumnEvidence } from './types/display.js';

/** Everything known about one end of a relationship. */
export interface EndEvidence {
  model: string;
  column: string;
  isPrimaryKey: boolean;
  isNaturalKey: boolean;
  /** The model file marks the column as a foreign key (never inferred from relationships). */
  isForeignKeyDeclared: boolean;
  /** How many columns of the model are primary key columns. */
  pkColumnCount: number;
  /** How many columns of the model are natural key columns. */
  nkColumnCount: number;
  /** What dbt's tests say about the column, when known. */
  dbt?: DbtColumnEvidence;
}

/** How sure `resolveDirection` is. */
export type DirectionConfidence = 'certain' | 'likely' | 'ambiguous';

/** One end, as `resolveDirection` reports it. */
export interface DirectionEnd {
  model: string;
  column: string;
}

export interface DirectionVerdict {
  /** The many (foreign-key) end. For an ambiguous verdict, simply the end that sorts first. */
  from: DirectionEnd;
  to: DirectionEnd;
  /** Never `one-to-many`. */
  cardinality: Exclude<Cardinality, 'one-to-many'>;
  confidence: DirectionConfidence;
  /** Key flags and dbt tests disagree about an end. Always comes with `ambiguous`. */
  conflict?: boolean;
  /** Plain sentences, one per piece of evidence used. */
  reasons: string[];
}

/** What one source of evidence says about an end. */
type Verdict =
  /** The end is unique: other rows point at it. */
  | 'one'
  /** The end is unique and itself points at the other end (a shared primary key). */
  | 'one-fk'
  /** The end is not unique: it points out. */
  | 'many'
  | 'unknown';

interface Reading {
  verdict: Verdict;
  reasons: string[];
}

/** What the key flags in the model file say about an end. */
function readKeys(e: EndEvidence): Reading {
  const name = `${e.model}.${e.column}`;
  const wholePk = e.isPrimaryKey && e.pkColumnCount === 1;
  const wholeNk = e.isNaturalKey && e.nkColumnCount === 1;
  const partOfKey = (e.isPrimaryKey && e.pkColumnCount > 1) || (e.isNaturalKey && e.nkColumnCount > 1);
  if (wholePk || wholeNk) {
    const what = wholePk ? 'primary key' : 'natural key';
    if (e.isForeignKeyDeclared) {
      return { verdict: 'one-fk', reasons: [`${name} is ${e.model}'s ${what} and is marked as a foreign key`] };
    }
    return { verdict: 'one', reasons: [`${name} is ${e.model}'s ${what}`] };
  }
  if (partOfKey) {
    const what = e.isPrimaryKey && e.pkColumnCount > 1 ? 'primary key' : 'natural key';
    return { verdict: 'many', reasons: [`${name} is only part of ${e.model}'s ${what}`] };
  }
  if (e.isForeignKeyDeclared) {
    return { verdict: 'many', reasons: [`${name} is marked as a foreign key`] };
  }
  return { verdict: 'unknown', reasons: [] };
}

/** What dbt's tests say about an end. */
function readDbt(e: EndEvidence): Reading {
  const name = `${e.model}.${e.column}`;
  const dbt = e.dbt;
  if (!dbt) return { verdict: 'unknown', reasons: [] };
  if (dbt.unique === true) {
    return dbt.relationshipsTest
      ? { verdict: 'one-fk', reasons: [`dbt tests ${name} as unique and as a relationship to another model`] }
      : { verdict: 'one', reasons: [`dbt tests ${name} as unique`] };
  }
  if (dbt.inCompositeUnique) {
    return { verdict: 'many', reasons: [`dbt tests ${name} as part of a unique combination of columns`] };
  }
  if (dbt.relationshipsTest) {
    return { verdict: 'many', reasons: [`dbt tests ${name} with a relationships test`] };
  }
  if (dbt.unique === false) {
    return { verdict: 'many', reasons: [`dbt does not treat ${name} as unique`] };
  }
  return { verdict: 'unknown', reasons: [] };
}

const isOne = (v: Verdict): boolean => v === 'one' || v === 'one-fk';

/** Combined reading of one end: keys first, dbt where keys say nothing. */
interface EndReading {
  end: DirectionEnd;
  verdict: Verdict;
  /** Whether the verdict rests on key flags alone. */
  fromKeys: boolean;
  conflict: boolean;
  reasons: string[];
}

function readEnd(e: EndEvidence): EndReading {
  const keys = readKeys(e);
  const dbt = readDbt(e);
  const end = { model: e.model, column: e.column };
  if (keys.verdict !== 'unknown' && dbt.verdict !== 'unknown') {
    if (isOne(keys.verdict) !== isOne(dbt.verdict)) {
      return { end, verdict: keys.verdict, fromKeys: true, conflict: true, reasons: [...keys.reasons.map((r) => `${r}, but ${dbt.reasons.join(', ')}`)] };
    }
    // Agreeing sources; dbt can add that a unique key also points out.
    const verdict = keys.verdict === 'one' && dbt.verdict === 'one-fk' ? 'one-fk' : keys.verdict;
    return { end, verdict, fromKeys: verdict === keys.verdict, conflict: false, reasons: [...keys.reasons, ...dbt.reasons] };
  }
  if (keys.verdict !== 'unknown') return { end, verdict: keys.verdict, fromKeys: true, conflict: false, reasons: keys.reasons };
  return { end, verdict: dbt.verdict, fromKeys: false, conflict: false, reasons: dbt.reasons };
}

const endLabel = (e: DirectionEnd): string => `${e.model}.${e.column}`.toLowerCase();

/**
 * Decide which way a relationship between two columns points, from key flags
 * and dbt tests only. Symmetric: `resolveDirection(a, b)` and
 * `resolveDirection(b, a)` give the same verdict.
 *
 * - **certain** — key flags alone settle it: one end is its model's whole
 *   primary or natural key and the other is not unique (part of a composite
 *   key, or a declared foreign key) → `many-to-one` from the not-unique end;
 *   or both ends are whole keys and exactly one is a declared foreign key →
 *   `one-to-one` from that end.
 * - **likely** — dbt tests decide it, or one end is known and the other is not.
 * - **ambiguous** — no evidence; both ends unique with no foreign-key evidence
 *   (a one-to-one either way); both ends not unique (many-to-many or unkeyed);
 *   or key flags and dbt disagree about an end (`conflict: true`). The ends
 *   are then reported in a fixed order, not the order they were passed in.
 */
export function resolveDirection(a: EndEvidence, b: EndEvidence): DirectionVerdict {
  // Fixed order first, so the verdict cannot depend on argument order.
  const [x, y] = endLabel(a) <= endLabel(b) ? [readEnd(a), readEnd(b)] : [readEnd(b), readEnd(a)];
  const reasons = [...x.reasons, ...y.reasons];
  const ambiguous = (cardinality: DirectionVerdict['cardinality'], extra: Partial<DirectionVerdict> = {}): DirectionVerdict => ({
    from: x.end, to: y.end, cardinality, confidence: 'ambiguous', reasons, ...extra,
  });
  const decided = (
    from: EndReading,
    to: EndReading,
    cardinality: DirectionVerdict['cardinality'],
    confidence: DirectionConfidence,
  ): DirectionVerdict => ({ from: from.end, to: to.end, cardinality, confidence, reasons: [...from.reasons, ...to.reasons] });

  if (x.conflict || y.conflict) {
    return ambiguous('many-to-one', { conflict: true });
  }
  const certain = x.fromKeys && y.fromKeys;
  const vx = x.verdict;
  const vy = y.verdict;

  if (vx === 'unknown' && vy === 'unknown') {
    return ambiguous('many-to-one', { reasons: ['Neither column is a key, a declared foreign key or covered by a dbt test'] });
  }
  // One end unique, the other not unique.
  if (isOne(vx) && vy === 'many') return decided(y, x, 'many-to-one', certain ? 'certain' : 'likely');
  if (isOne(vy) && vx === 'many') return decided(x, y, 'many-to-one', certain ? 'certain' : 'likely');
  // Both unique: a one-to-one, from the end that also points out.
  if (isOne(vx) && isOne(vy)) {
    if (vx === 'one-fk' && vy === 'one') return decided(x, y, 'one-to-one', certain ? 'certain' : 'likely');
    if (vy === 'one-fk' && vx === 'one') return decided(y, x, 'one-to-one', certain ? 'certain' : 'likely');
    return ambiguous('one-to-one');
  }
  if (vx === 'many' && vy === 'many') return ambiguous('many-to-many');
  // One end known, the other not.
  const [known, unknown] = vx === 'unknown' ? [y, x] : [x, y];
  if (known.verdict === 'one') return decided(unknown, known, 'many-to-one', 'likely');
  if (known.verdict === 'one-fk') return decided(known, unknown, 'one-to-one', 'likely');
  return decided(known, unknown, 'many-to-one', 'likely');
}

/** A column as `endEvidence` reads it: the stored flags, or the display ones. */
export interface EvidenceColumn {
  name: string;
  isPrimaryKey?: boolean;
  isNaturalKey?: boolean;
  dbtEvidence?: DbtColumnEvidence;
}

/**
 * The evidence for one end, from its model's column list. `declaredForeignKey`
 * says which flag means "the model file marks this as a foreign key" for the
 * column shape at hand. Column names match without case. Undefined when the
 * model has no such column.
 */
export function endEvidence<C extends EvidenceColumn>(
  model: string,
  columns: readonly C[],
  column: string,
  declaredForeignKey: (col: C) => boolean,
): EndEvidence | undefined {
  const col = columns.find((c) => c.name === column) ?? columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
  if (!col) return undefined;
  return {
    model,
    column: col.name,
    isPrimaryKey: col.isPrimaryKey === true,
    isNaturalKey: col.isNaturalKey === true,
    isForeignKeyDeclared: declaredForeignKey(col),
    pkColumnCount: columns.filter((c) => c.isPrimaryKey === true).length,
    nkColumnCount: columns.filter((c) => c.isNaturalKey === true).length,
    ...(col.dbtEvidence ? { dbt: col.dbtEvidence } : {}),
  };
}

/** {@link endEvidence} for a model as stored (`ColumnDef.isForeignKey` is the declared flag). */
export function endEvidenceFromModel(model: Pick<SemanticModel, 'name' | 'columns'>, column: string): EndEvidence | undefined {
  return endEvidence(model.name, model.columns ?? [], column, (c) => (c as { isForeignKey?: boolean }).isForeignKey === true);
}

/**
 * {@link endEvidence} for a model as displayed: `DisplayColumn.isForeignKeyDeclared`
 * is the declared flag (its `isForeignKey` badge is also set by relationships,
 * so it is never evidence).
 */
export function endEvidenceFromDisplay(
  model: { name: string; columns: ReadonlyArray<EvidenceColumn & { isForeignKeyDeclared?: boolean }> },
  column: string,
): EndEvidence | undefined {
  return endEvidence(model.name, model.columns, column, (c) => c.isForeignKeyDeclared === true);
}
