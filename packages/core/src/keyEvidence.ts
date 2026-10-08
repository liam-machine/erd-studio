/**
 * What is known about whether a set of columns is its model's whole key
 * (#133 L1) — the one place relationship direction reads key evidence: drag
 * orientation, the New Relationship dialog, ⇄'s refusal, Move's turn-round
 * and the read winner all ask it.
 *
 * Evidence comes from the first source that says anything:
 *
 * 1. The model's own flags. A set equal to the model's full set of
 *    `isPrimaryKey` columns, or of `isNaturalKey` columns, is its whole key;
 *    in a model that flags any key, any other set is not.
 * 2. dbt's tests (schema yml and manifest), consulted only for a model that
 *    flags no key: a `unique` test on the one column, or a
 *    `unique_combination_of_columns` equal to the set, says whole key; a set
 *    strictly inside a combination, or a single column a `relationships` test
 *    leaves, says not.
 *
 * Flags win outright: when the model flags a key, dbt is never consulted.
 */

export type KeyEvidence = 'whole-key' | 'not-key' | 'unknown';

/** What dbt's tests say about one column. Built by the host; never stored in any file. */
export interface DbtKeyHint {
  key: 'unique' | 'not-unique';
  because: 'unique-test' | 'unique-combination' | 'part-of-unique-combination' | 'relationships-test';
  /** The ≥2-column unique combinations the column is part of, lowercased and sorted. */
  combinations?: string[][];
}

/** model (lowercased) → column (lowercased) → hint, plus the ≥2-column unique combinations. */
export interface DbtKeyIndex {
  columns: ReadonlyMap<string, ReadonlyMap<string, DbtKeyHint>>;
  /** model (lowercased) → each unique_combination_of_columns of ≥2 columns, lowercased and sorted. */
  combinations: ReadonlyMap<string, readonly (readonly string[])[]>;
}

/** The test declarations one dbt source (the schema yml, or the manifest) carries. */
export interface DbtTestSource {
  /** A Map, or `Object.entries` of a record. */
  uniqueColumns?: Iterable<readonly [string, Iterable<string>]>;
  compositeUniqueGroups?: Iterable<readonly [string, Iterable<readonly string[]>]>;
  relationshipTests?: Iterable<{ fromModel: string; fromColumn: string }>;
}

export const EMPTY_DBT_KEY_INDEX: DbtKeyIndex = { columns: new Map(), combinations: new Map() };

const lower = (s: string): string => s.trim().toLowerCase();
const comboKey = (cols: readonly string[]): string => cols.join('\u0000');

/**
 * Merge what dbt's tests say about each column across `sources`. Order does
 * not matter: a `unique` answer always beats a `not-unique` one, whichever
 * source or test supplied it.
 */
export function buildDbtKeyIndex(sources: ReadonlyArray<DbtTestSource | undefined>): DbtKeyIndex {
  const uniqueTested = new Map<string, Set<string>>();
  const oneColumnCombination = new Map<string, Set<string>>();
  const combos = new Map<string, Map<string, string[]>>();
  const pointsOut = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, model: string, column: string): void => {
    const m = lower(model);
    if (!map.has(m)) map.set(m, new Set());
    map.get(m)!.add(lower(column));
  };
  for (const source of sources) {
    if (!source) continue;
    for (const [model, columns] of source.uniqueColumns ?? []) for (const column of columns) add(uniqueTested, model, column);
    for (const [model, groups] of source.compositeUniqueGroups ?? []) {
      for (const group of groups) {
        const cols = [...new Set(group.map(lower))].sort();
        if (cols.length === 1) add(oneColumnCombination, model, cols[0]);
        if (cols.length < 2) continue;
        const m = lower(model);
        if (!combos.has(m)) combos.set(m, new Map());
        combos.get(m)!.set(comboKey(cols), cols);
      }
    }
    for (const test of source.relationshipTests ?? []) add(pointsOut, test.fromModel, test.fromColumn);
  }

  const columns = new Map<string, Map<string, DbtKeyHint>>();
  const models = new Set([...uniqueTested.keys(), ...oneColumnCombination.keys(), ...combos.keys(), ...pointsOut.keys()]);
  for (const model of models) {
    const modelCombos = [...(combos.get(model)?.values() ?? [])];
    const named = new Set([
      ...(uniqueTested.get(model) ?? []), ...(oneColumnCombination.get(model) ?? []), ...modelCombos.flat(), ...(pointsOut.get(model) ?? []),
    ]);
    const hints = new Map<string, DbtKeyHint>();
    for (const column of named) {
      const memberOf = modelCombos.filter((c) => c.includes(column)).map((c) => [...c]);
      const withCombos = memberOf.length > 0 ? { combinations: memberOf } : {};
      if (uniqueTested.get(model)?.has(column)) hints.set(column, { key: 'unique', because: 'unique-test', ...withCombos });
      else if (oneColumnCombination.get(model)?.has(column)) hints.set(column, { key: 'unique', because: 'unique-combination', ...withCombos });
      else if (memberOf.length > 0) hints.set(column, { key: 'not-unique', because: 'part-of-unique-combination', ...withCombos });
      else hints.set(column, { key: 'not-unique', because: 'relationships-test' });
    }
    columns.set(model, hints);
  }
  const combinations = new Map([...combos].map(([model, byKey]) => [model, [...byKey.values()].sort((a, b) => (comboKey(a) < comboKey(b) ? -1 : 1))]));
  return { columns, combinations };
}

/** A column as key evidence reads it: a model file's column, or a canvas column carrying `dbtKey`. */
export interface KeyColumn {
  name: string;
  isPrimaryKey?: boolean;
  isNaturalKey?: boolean;
  isForeignKey?: boolean;
  /** What dbt's tests say about it (the editable canvas payload only). */
  dbtKey?: DbtKeyHint;
}

/** The parts of a model key evidence reads. `name` is needed only to look dbt evidence up in an index. */
export interface KeyedModel {
  name?: string;
  columns?: ReadonlyArray<KeyColumn>;
}

/** Key evidence, with where it came from: the model's flags (`keys`), dbt's tests (`dbt`), or nothing. */
export interface KeyEvidenceDetail {
  evidence: KeyEvidence;
  source: 'keys' | 'dbt' | 'none';
  /** For `source: 'dbt'`: which test said so. */
  because?: DbtKeyHint['because'];
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

/** {@link keyEvidenceOf}, with the source of the answer. */
export function keyEvidenceDetail(
  model: KeyedModel | null | undefined,
  columns: readonly string[],
  dbt?: DbtKeyIndex,
): KeyEvidenceDetail {
  const set = [...new Set(columns.map((c) => lower(`${c}`)))];
  const cols = (model?.columns ?? []).filter((c) => !!c && typeof c.name === 'string');
  if (set.length === 0) return { evidence: 'unknown', source: 'none' };

  // 1. The model's own flags.
  const pk = cols.filter((c) => c.isPrimaryKey).map((c) => lower(c.name));
  const nk = cols.filter((c) => c.isNaturalKey).map((c) => lower(c.name));
  if (pk.length > 0 || nk.length > 0) {
    const whole = (pk.length > 0 && sameSet(set, pk)) || (nk.length > 0 && sameSet(set, nk));
    return { evidence: whole ? 'whole-key' : 'not-key', source: 'keys' };
  }

  // 2. dbt's tests: the column's own hint first, else the index.
  const modelName = model?.name !== undefined ? lower(model.name) : undefined;
  const hintOf = (column: string): DbtKeyHint | undefined =>
    cols.find((c) => lower(c.name) === column)?.dbtKey
    ?? (modelName !== undefined ? dbt?.columns.get(modelName)?.get(column) : undefined);
  if (set.length === 1) {
    const hint = hintOf(set[0]);
    if (hint) return { evidence: hint.key === 'unique' ? 'whole-key' : 'not-key', source: 'dbt', because: hint.because };
    return { evidence: 'unknown', source: 'none' };
  }
  const combinations: Array<readonly string[]> = [
    ...(modelName !== undefined ? dbt?.combinations.get(modelName) ?? [] : []),
    ...set.flatMap((column) => hintOf(column)?.combinations ?? []),
  ];
  if (combinations.some((combo) => sameSet(set, combo))) return { evidence: 'whole-key', source: 'dbt', because: 'unique-combination' };
  if (combinations.some((combo) => combo.length > set.length && set.every((c) => combo.includes(c)))) {
    return { evidence: 'not-key', source: 'dbt', because: 'part-of-unique-combination' };
  }
  return { evidence: 'unknown', source: 'none' };
}

/**
 * What is known about `columns` (one or more) being `model`'s whole key. dbt's
 * index is consulted only for a column without a `dbtKey` of its own, and only
 * when the model flags no key.
 */
export function keyEvidenceOf(model: KeyedModel | null | undefined, columns: readonly string[], dbt?: DbtKeyIndex): KeyEvidence {
  return keyEvidenceDetail(model, columns, dbt).evidence;
}

/** The single-column form: `keyEvidenceOf(model, [column], dbt)`. */
export function keyEvidence(model: KeyedModel | null | undefined, column: string, dbt?: DbtKeyIndex): KeyEvidence {
  return keyEvidenceOf(model, [column], dbt);
}
