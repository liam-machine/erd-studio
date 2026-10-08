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
import { findColumnByName } from './columnLookup.js';

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

/**
 * What the key flags in the model file say about an end, read on their own.
 * This is the reading that decides whether a verdict can be **certain**.
 */
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

/** Whether a dbt `relationships` test on an end names `other` as its target. */
function testsPointAt(dbt: DbtColumnEvidence, other: DirectionEnd): boolean {
  const model = other.model.toLowerCase();
  const column = other.column.toLowerCase();
  return (dbt.relationshipsTo ?? []).some((t) => t.model.toLowerCase() === model && t.column.toLowerCase() === column);
}

/**
 * Two separate facts about an end: whether its values are **unique**, and
 * whether it **points out** at another table. They are never mixed up — a
 * declared foreign key or a dbt `relationships` test says the column points
 * somewhere, and says nothing about whether it is unique. Only when nothing
 * says it is unique does a pointing column read as the many side.
 */
interface EndFacts {
  /** From the key flags: whole key = unique, part of a composite key = not unique. */
  keyUnique?: boolean;
  keyUniqueReason?: string;
  /** From dbt: `unique` = unique; a composite unique or `unique: false` = not unique. */
  dbtUnique?: boolean;
  dbtUniqueReason?: string;
  /** The model file marks the column as a foreign key. */
  declaredFk: boolean;
  /** A dbt relationships test is declared on the column. */
  dbtPoints: boolean;
  /** …and it names the other end of this very relationship. */
  dbtPointsAtOther: boolean;
}

function readFacts(e: EndEvidence, other: DirectionEnd): EndFacts {
  const name = `${e.model}.${e.column}`;
  const facts: EndFacts = { declaredFk: e.isForeignKeyDeclared, dbtPoints: false, dbtPointsAtOther: false };
  const wholePk = e.isPrimaryKey && e.pkColumnCount === 1;
  const wholeNk = e.isNaturalKey && e.nkColumnCount === 1;
  if (wholePk || wholeNk) {
    facts.keyUnique = true;
    facts.keyUniqueReason = `${name} is ${e.model}'s ${wholePk ? 'primary key' : 'natural key'}`;
  } else if ((e.isPrimaryKey && e.pkColumnCount > 1) || (e.isNaturalKey && e.nkColumnCount > 1)) {
    facts.keyUnique = false;
    facts.keyUniqueReason = `${name} is only part of ${e.model}'s ${e.isPrimaryKey && e.pkColumnCount > 1 ? 'primary key' : 'natural key'}`;
  }
  const dbt = e.dbt;
  if (dbt) {
    if (dbt.unique === true) {
      facts.dbtUnique = true;
      facts.dbtUniqueReason = `dbt tests ${name} as unique`;
    } else if (dbt.inCompositeUnique) {
      facts.dbtUnique = false;
      facts.dbtUniqueReason = `dbt tests ${name} as part of a unique combination of columns`;
    } else if (dbt.unique === false) {
      facts.dbtUnique = false;
      facts.dbtUniqueReason = `dbt does not treat ${name} as unique`;
    }
    facts.dbtPoints = dbt.relationshipsTest === true;
    facts.dbtPointsAtOther = facts.dbtPoints && testsPointAt(dbt, other);
  }
  return facts;
}

/**
 * An end's combined verdict. `one-fk?` is a unique end whose only foreign-key
 * evidence is a dbt relationships test naming the other end (no declared
 * foreign key): it is the foreign-key side of a one-to-one
 * **only when the other end is unique too**. Against an end not known to be
 * unique it is the parent-declared form of a dbt test — the other end is the
 * many side — and reads as plain `one`.
 */
type EndVerdict = Verdict | 'one-fk?';

const isOne = (v: EndVerdict): boolean => v === 'one' || v === 'one-fk' || v === 'one-fk?';

/** Combined reading of one end. */
interface EndReading {
  end: DirectionEnd;
  verdict: EndVerdict;
  /** What the key flags alone say ('unknown' when they say nothing). */
  keyVerdict: Verdict;
  conflict: boolean;
  reasons: string[];
}

function readEnd(e: EndEvidence, other: DirectionEnd): EndReading {
  const name = `${e.model}.${e.column}`;
  const otherName = `${other.model}.${other.column}`;
  const keys = readKeys(e);
  const f = readFacts(e, other);
  const end = { model: e.model, column: e.column };
  // Only the two uniqueness facts can disagree: "points out" never contradicts "unique".
  if (f.keyUnique !== undefined && f.dbtUnique !== undefined && f.keyUnique !== f.dbtUnique) {
    return { end, verdict: keys.verdict, keyVerdict: keys.verdict, conflict: true, reasons: [`${f.keyUniqueReason}, but ${f.dbtUniqueReason}`] };
  }
  const reasons = [...keys.reasons];
  const dbtReason = f.dbtUnique === true && f.dbtPointsAtOther
    ? `dbt tests ${name} as unique and as a relationship to ${otherName}`
    : f.dbtUniqueReason
      ?? (f.dbtPointsAtOther ? `dbt tests ${name} as a relationship to ${otherName}` : f.dbtPoints ? `dbt tests ${name} with a relationships test` : undefined);
  if (dbtReason) reasons.push(dbtReason);

  const unique = f.keyUnique ?? f.dbtUnique;
  let verdict: EndVerdict;
  if (unique === true) {
    // A declared foreign key that is unique is a one-fk however its
    // uniqueness is known (a whole key, or a dbt `unique` test): the same
    // facts must give the same verdict.
    if (f.declaredFk) verdict = 'one-fk';
    else if (f.dbtPointsAtOther) verdict = 'one-fk?';
    else verdict = 'one';
  } else if (unique === false) {
    verdict = 'many';
  } else {
    // Nothing says whether it is unique: a column that points out is the many side.
    verdict = f.declaredFk || f.dbtPoints ? 'many' : 'unknown';
  }
  return { end, verdict, keyVerdict: keys.verdict, conflict: false, reasons };
}

/** Settle a provisional `one-fk?` against the other end's verdict. */
function settle(v: EndVerdict, other: EndVerdict): Verdict {
  if (v !== 'one-fk?') return v;
  return isOne(other) ? 'one-fk' : 'one';
}

/** What a pair of verdicts decides, before any confidence is attached. */
type Decision =
  | { kind: 'decided'; fromIsX: boolean; cardinality: DirectionVerdict['cardinality'] }
  | { kind: 'ambiguous'; cardinality: DirectionVerdict['cardinality'] };

function decide(vx: Verdict, vy: Verdict): Decision {
  if (vx === 'unknown' && vy === 'unknown') return { kind: 'ambiguous', cardinality: 'many-to-one' };
  // One end unique, the other not unique.
  if (isOne(vx) && vy === 'many') return { kind: 'decided', fromIsX: false, cardinality: 'many-to-one' };
  if (isOne(vy) && vx === 'many') return { kind: 'decided', fromIsX: true, cardinality: 'many-to-one' };
  // Both unique: a one-to-one, from the end that also points out.
  if (isOne(vx) && isOne(vy)) {
    if (vx === 'one-fk' && vy === 'one') return { kind: 'decided', fromIsX: true, cardinality: 'one-to-one' };
    if (vy === 'one-fk' && vx === 'one') return { kind: 'decided', fromIsX: false, cardinality: 'one-to-one' };
    return { kind: 'ambiguous', cardinality: 'one-to-one' };
  }
  if (vx === 'many' && vy === 'many') return { kind: 'ambiguous', cardinality: 'many-to-many' };
  // One end known, the other not.
  const knownIsX = vy === 'unknown';
  const known = knownIsX ? vx : vy;
  if (known === 'one') return { kind: 'decided', fromIsX: !knownIsX, cardinality: 'many-to-one' };
  // A unique column that also points out says nothing about which way it
  // relates to a column nothing is known about: it may hold the key to it (a
  // one-to-one, as a subtype holds its supertype's key), or be the key the
  // other column points at (a many-to-one, as a department's manager_id
  // points at a subtype's key). Never guessed.
  if (known === 'one-fk') return { kind: 'ambiguous', cardinality: 'many-to-one' };
  return { kind: 'decided', fromIsX: knownIsX, cardinality: 'many-to-one' };
}

const sameDecision = (a: Decision, b: Decision): boolean =>
  a.kind === b.kind && a.cardinality === b.cardinality && (a.kind === 'ambiguous' || (b.kind === 'decided' && a.fromIsX === b.fromIsX));

const exactLabel = (e: DirectionEnd): string => `${e.model}.${e.column}`;
const endLabel = (e: DirectionEnd): string => exactLabel(e).toLowerCase();

/** Whether `a` comes first in the fixed order: lowercased label, then the exact one. */
function endSortsFirst(a: DirectionEnd, b: DirectionEnd): boolean {
  const la = endLabel(a);
  const lb = endLabel(b);
  if (la !== lb) return la < lb;
  return exactLabel(a) <= exactLabel(b);
}

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
 *   dbt that agrees with keys which already settle it leaves the verdict certain.
 * - **ambiguous** — no evidence; both ends unique with no foreign-key evidence
 *   (a one-to-one either way); both ends not unique (many-to-many or unkeyed);
 *   or key flags and dbt disagree about an end (`conflict: true`). The ends
 *   are then reported in a fixed order, not the order they were passed in.
 */
export function resolveDirection(a: EndEvidence, b: EndEvidence): DirectionVerdict {
  // Fixed order first, so the verdict cannot depend on argument order. Two
  // ends that differ only in case (`Dd.id`, `DD.id`) tie on the lowercased
  // label and are then ordered by the exact one.
  const [ea, eb] = endSortsFirst(a, b) ? [a, b] : [b, a];
  const endOf = (e: EndEvidence): DirectionEnd => ({ model: e.model, column: e.column });
  const rx = readEnd(ea, endOf(eb));
  const ry = readEnd(eb, endOf(ea));
  const x = { ...rx, verdict: settle(rx.verdict, ry.verdict) };
  const y = { ...ry, verdict: settle(ry.verdict, rx.verdict) };
  const reasons = [...x.reasons, ...y.reasons];
  const ambiguous = (cardinality: DirectionVerdict['cardinality'], extra: Partial<DirectionVerdict> = {}): DirectionVerdict => ({
    from: x.end, to: y.end, cardinality, confidence: 'ambiguous', reasons, ...extra,
  });

  if (x.conflict || y.conflict) {
    return ambiguous('many-to-one', { conflict: true });
  }
  const decision = decide(x.verdict, y.verdict);
  if (decision.kind === 'ambiguous') {
    if (x.verdict === 'unknown' && y.verdict === 'unknown') {
      return ambiguous(decision.cardinality, { reasons: ['Neither column is a key, a declared foreign key or covered by a dbt test'] });
    }
    const unknownEnd = x.verdict === 'unknown' ? x : y.verdict === 'unknown' ? y : undefined;
    return unknownEnd
      ? ambiguous(decision.cardinality, {
        reasons: [...reasons, `nothing is known about ${exactLabel(unknownEnd.end)}, so it is not known which way the two relate`],
      })
      : ambiguous(decision.cardinality);
  }
  // Certain only when the key flags alone, read without dbt, reach the very
  // same answer: dbt agreeing (or adding detail the answer does not turn on)
  // never makes the verdict less sure, and dbt alone never makes it certain.
  const certain = x.keyVerdict !== 'unknown' && y.keyVerdict !== 'unknown'
    && sameDecision(decide(x.keyVerdict, y.keyVerdict), decision);
  const [from, to] = decision.fromIsX ? [x, y] : [y, x];
  // Only the two-sided case can be certain; "one end known" is always likely.
  const confidence: DirectionConfidence = certain ? 'certain' : 'likely';
  return { from: from.end, to: to.end, cardinality: decision.cardinality, confidence, reasons: [...from.reasons, ...to.reasons] };
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
  const col = findColumnByName(columns, column);
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
