/**
 * Which way round a new link goes, from key evidence alone (#133 L1): the
 * end that is its model's whole key is the "one" side, and the column
 * pointing at it holds the foreign key. Never from drag order — with nothing
 * to go on the answer is "not decided", and the New Relationship dialog asks.
 */

import { keyEvidenceDetail } from './keyEvidence.js';
import type { DbtKeyHint, DbtKeyIndex, KeyColumn, KeyEvidence, KeyedModel } from './keyEvidence.js';

/** One end of a link: a model and one or more of its columns, with what is known about them. */
export interface LinkEnd {
  model: string;
  columns: readonly string[];
  evidence: KeyEvidence;
  /** Every column of the end is flagged `isForeignKey` in the model file. */
  declaredFk: boolean;
  /** Where `evidence` came from. */
  source?: 'keys' | 'dbt' | 'none';
  because?: DbtKeyHint['because'];
}

export interface Orientation {
  from: LinkEnd;
  to: LinkEnd;
  cardinality: 'many-to-one' | 'one-to-one' | 'many-to-many';
  /** false: nothing says which side holds the foreign key — the dialog asks. */
  decided: boolean;
  /** What decided it: the models' key flags, dbt's tests, or nothing. */
  basis: 'keys' | 'dbt' | 'none';
}

/**
 * A link end for `columns` of `model`. `declaredFk` reads a column's stored
 * foreign-key flag; by default `isForeignKey` (a model file's column) — a
 * canvas column passes its `isForeignKeyDeclared`, as its `isForeignKey` is
 * the badge.
 */
export function linkEnd(
  model: string,
  modelDef: KeyedModel | null | undefined,
  columns: readonly string[],
  options: { dbt?: DbtKeyIndex; declaredFk?: (column: KeyColumn) => boolean } = {},
): LinkEnd {
  const detail = keyEvidenceDetail(modelDef ? { ...modelDef, name: modelDef.name ?? model } : { name: model }, columns, options.dbt);
  const isFk = options.declaredFk ?? ((c: KeyColumn) => c.isForeignKey === true);
  const cols = (modelDef?.columns ?? []).filter((c) => !!c && typeof c.name === 'string');
  const declaredFk = columns.length > 0 && columns.every((name) => {
    const col = cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
    return !!col && isFk(col);
  });
  return {
    model, columns, evidence: detail.evidence, declaredFk, source: detail.source, ...(detail.because ? { because: detail.because } : {}),
  };
}

const endKey = (e: LinkEnd): string => `${e.model}.${e.columns.join(',')}`;

/** The two ends in a fixed order, whatever order they were given in. */
function ordered(a: LinkEnd, b: LinkEnd): [LinkEnd, LinkEnd] {
  const ka = endKey(a).toLowerCase();
  const kb = endKey(b).toLowerCase();
  if (ka !== kb) return ka < kb ? [a, b] : [b, a];
  return endKey(a) <= endKey(b) ? [a, b] : [b, a];
}

/**
 * Orient a link from its ends' evidence. Symmetric: `orientLink(a, b)` and
 * `orientLink(b, a)` give the same answer; when it is not decided, `from` is
 * the end that sorts first.
 *
 * | one end    | other end         | result                                                    |
 * |------------|-------------------|-----------------------------------------------------------|
 * | whole key  | not key / unknown | many-to-one from the other end                            |
 * | whole key  | whole key         | one-to-one from the end flagged as foreign key, else asks |
 * | not key    | unknown           | many-to-one from the not-key end                          |
 * | unknown    | unknown           | asks (many-to-one suggested)                              |
 * | not key    | not key           | asks (many-to-many suggested)                             |
 */
export function orientLink(a: LinkEnd, b: LinkEnd): Orientation {
  const [first, second] = ordered(a, b);
  const basisOf = (...ends: LinkEnd[]): 'keys' | 'dbt' =>
    (ends.some((e) => e.source === 'dbt') ? 'dbt' : 'keys');
  const decided = (from: LinkEnd, to: LinkEnd, cardinality: Orientation['cardinality'], used: LinkEnd[]): Orientation =>
    ({ from, to, cardinality, decided: true, basis: basisOf(...used) });
  const ask = (cardinality: Orientation['cardinality']): Orientation =>
    ({ from: first, to: second, cardinality, decided: false, basis: 'none' });

  const whole = [first, second].filter((e) => e.evidence === 'whole-key');
  if (whole.length === 2) {
    const fk = [first, second].filter((e) => e.declaredFk);
    if (fk.length === 1) return decided(fk[0], fk[0] === first ? second : first, 'one-to-one', [first, second]);
    return ask('one-to-one');
  }
  if (whole.length === 1) {
    const key = whole[0];
    const other = key === first ? second : first;
    return decided(other, key, 'many-to-one', other.evidence === 'unknown' ? [key] : [key, other]);
  }
  const notKey = [first, second].filter((e) => e.evidence === 'not-key');
  if (notKey.length === 2) return ask('many-to-many');
  if (notKey.length === 1) {
    const pointing = notKey[0];
    return decided(pointing, pointing === first ? second : first, 'many-to-one', [pointing]);
  }
  return ask('many-to-one');
}
