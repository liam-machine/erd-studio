/**
 * Bounded exhaustive check of relationship storage (#133) — the model.
 *
 * The "small scope hypothesis" (Alloy, TLA+): most bugs show up in small
 * instances, so check ALL small instances instead of guessing edge cases.
 *
 * Universe: two models, `dim` and `fct`, one link L (fct.k ↔ dim.k) and an
 * optional bystander link L2 (fct.k2 → dim.k, role "ship") in fct.yml. Two
 * diagrams, D1 and D2, both holding dim and fct. A state is a multiset of
 * stored copies of L — in dim.yml, fct.yml, D1 or D2 — each with a direction,
 * a cardinality, a role and a column spelling, under one of six key profiles.
 * Every state is run through every operation a user can perform from D1, and
 * the invariants below are checked after each.
 *
 * The provider's handlers decide every write with `planRelationshipWrite`
 * and the Move applies its plan with `applyMoveToModel`; the `host*` and
 * `move*` functions here call those same functions on in-memory files, and
 * `relationshipStateSpace.real.test.ts` drives the real provider and Move
 * command over a sample to check the plumbing around them.
 */

import { mergeLibraryRelationships } from '@erd-studio/core';
import {
  applyMoveToModel,
  diagramsStillDrawing,
  drawnDiagramCopies,
  moveTargets,
  planMoveToLibrary,
  planRelationshipWrite,
  renameColumnInDomainRelationships,
  renameColumnInRelationships,
  resolveConflict,
  routeToLibrary,
  usesLibraryRelationships,
} from '../../src/services/libraryRelationships';
import type { ConflictDefinition, MoveToLibraryPlan, RelationshipWriteOp } from '../../src/services/libraryRelationships';
import type { Cardinality, ColumnDef, ModelRelationship, Relationship, SemanticModel } from '../../src/types/semantic';

// ---------------------------------------------------------------------------
// Identity, as #133 defines it. Local copies, so the checks never trust the
// code under test (and run against commits that predate core's versions).
// ---------------------------------------------------------------------------

type EndsOnly = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;
/** Two `model.column` ends, unordered, without case. */
export function linkKey(rel: EndsOnly): string {
  const end = (model: string, column: string): string => `${model}.${column}`.trim().toLowerCase();
  const from = end(rel.fromModel, rel.fromColumn);
  const to = end(rel.toModel, rel.toColumn);
  return from <= to ? `${from}\u0000${to}` : `${to}\u0000${from}`;
}
export const sameLink = (a: EndsOnly, b: EndsOnly): boolean => linkKey(a) === linkKey(b);
/** The four ends in order, without case. */
export const relationshipKey = (r: EndsOnly): string =>
  [r.fromModel, r.fromColumn, r.toModel, r.toColumn].map((x) => x.toLowerCase()).join('\u0000');
export function canonicalRelationship<T extends Relationship>(rel: T): T {
  if (rel.cardinality !== 'one-to-many') return rel;
  return { ...rel, fromModel: rel.toModel, fromColumn: rel.toColumn, toModel: rel.fromModel, toColumn: rel.fromColumn, cardinality: 'many-to-one' };
}

// ---------------------------------------------------------------------------
// The universe
// ---------------------------------------------------------------------------

export type ModelName = 'dim' | 'fct';
export type DomainName = 'D1' | 'D2' | 'D3';
export const CARDS: Cardinality[] = ['many-to-one', 'one-to-many', 'one-to-one', 'many-to-many'];
export const SHORT: Record<Cardinality, string> = { 'many-to-one': 'm:1', 'one-to-many': '1:m', 'one-to-one': '1:1', 'many-to-many': 'm:m' };
export const SWAP: Record<Cardinality, Cardinality> = { 'many-to-one': 'one-to-many', 'one-to-many': 'many-to-one', 'one-to-one': 'one-to-one', 'many-to-many': 'many-to-many' };

export type Key = 'pk' | 'nk' | '';
export const PROFILES: Record<string, Record<ModelName, Array<[string, Key]>>> = {
  star: { dim: [['k', 'pk']], fct: [['id', 'pk'], ['k', ''], ['k2', '']] },
  noKeys: { dim: [['k', '']], fct: [['id', ''], ['k', ''], ['k2', '']] },
  composite: { dim: [['k', 'pk'], ['k_x', 'pk']], fct: [['id', 'pk'], ['k', ''], ['k2', '']] },
  natural: { dim: [['k', 'nk']], fct: [['id', 'pk'], ['k', ''], ['k2', '']] },
  sharedKey: { dim: [['k', 'pk']], fct: [['k', 'pk'], ['k2', '']] },
  reversed: { dim: [['k', '']], fct: [['k', 'pk'], ['k2', '']] },
};
export type Profile = keyof typeof PROFILES;

export const L_KEY = linkKey({ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k' });
export const BYSTANDER: ModelRelationship = { fromColumn: 'k2', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one', role: 'ship' };

export interface World {
  profile: Profile;
  lib: Record<ModelName, ModelRelationship[]>;
  dom: Record<DomainName, Relationship[]>;
  /** Which models each diagram holds, in file order. */
  domModels: Record<DomainName, ModelName[]>;
}

/** One stored copy of L, as enumerated. */
export interface Copy { where: ModelName | 'D1' | 'D2'; dir: 'fd' | 'df'; card: Cardinality; role?: string; upper: boolean }

export function relOf(c: Copy): Relationship {
  const col = c.upper ? 'K' : 'k';
  const [fromModel, toModel] = c.dir === 'fd' ? ['fct', 'dim'] : ['dim', 'fct'];
  return { fromModel, fromColumn: col, toModel, toColumn: col, cardinality: c.card, ...(c.role ? { role: c.role } : {}) };
}

export function worldOf(profile: Profile, copies: Copy[], bystander: boolean): World {
  const w: World = {
    profile,
    lib: { dim: [], fct: bystander ? [{ ...BYSTANDER }] : [] },
    dom: { D1: [], D2: [], D3: [] },
    domModels: { D1: ['dim', 'fct'], D2: ['dim', 'fct'], D3: ['dim'] },
  };
  for (const c of copies) {
    const rel = relOf(c);
    if (c.where === 'dim' || c.where === 'fct') {
      const { fromModel: _f, ...entry } = rel;
      w.lib[c.where].push(entry);
    } else {
      w.dom[c.where].push(rel);
    }
  }
  return w;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function columnsOf(profile: Profile, model: ModelName): ColumnDef[] {
  return PROFILES[profile][model].map(([name, key]) => ({
    name, dataType: 'string', description: '',
    ...(key === 'pk' ? { isPrimaryKey: true } : {}),
    ...(key === 'nk' ? { isNaturalKey: true } : {}),
  }));
}

/** Fresh library models (what `listModels()` / `getModel()` hand out), in `order`. */
export function libModels(w: World, order: ModelName[] = ['dim', 'fct']): SemanticModel[] {
  return order.map((name) => ({
    name,
    columns: columnsOf(w.profile, name),
    ...(w.lib[name].length > 0 ? { relationships: clone(w.lib[name]) } : {}),
  }));
}

/** Write library models back into a world. */
export function withLib(w: World, models: readonly SemanticModel[]): World {
  const next = clone(w);
  for (const m of models) next.lib[m.name as ModelName] = clone(m.relationships ?? []);
  return next;
}

export const domainRelCount = (w: World): number => w.dom.D1.length + w.dom.D2.length + w.dom.D3.length;
export const libraryMode = (w: World): boolean => usesLibraryRelationships(libModels(w), domainRelCount(w));

/** What diagram `d` draws: core's read path, as `DomainService.getDomain` calls it. */
export function draw(w: World, d: DomainName, modelOrder?: ModelName[], reverseEntries = false): Relationship[] {
  const order = modelOrder ?? w.domModels[d];
  const models = libModels(w, order);
  if (reverseEntries) for (const m of models) if (m.relationships) m.relationships.reverse();
  const own = reverseEntries ? [...w.dom[d]].reverse() : w.dom[d];
  return mergeLibraryRelationships(models, clone(own));
}

// ---------------------------------------------------------------------------
// Facts: what a copy says, independent of how it is spelled or which way round
// ---------------------------------------------------------------------------

export interface Fact { key: string; card: Cardinality; dir: string; role?: string }

/** A copy's meaning: canonical cardinality, its many/FK side (none for m:m), role. */
export function factOf(rel: Relationship): Fact {
  const c = canonicalRelationship(rel);
  const dir = c.cardinality === 'many-to-many' ? '' : `${c.fromModel}.${c.fromColumn}`.toLowerCase();
  return { key: linkKey(rel), card: c.cardinality, dir, ...(rel.role ? { role: rel.role } : {}) };
}
export const factText = (f: Fact): string => `${f.key.replace('\u0000', '~')}|${SHORT[f.card]}|${f.dir}|${f.role ?? '-'}`;

export function storedCopies(w: World): Array<{ file: string; rel: Relationship }> {
  return [
    ...(['dim', 'fct'] as const).flatMap((m) => w.lib[m].map((e) => ({ file: `${m}.yml`, rel: { fromModel: m, ...e } }))),
    ...(['D1', 'D2', 'D3'] as const).flatMap((d) => w.dom[d].map((rel) => ({ file: d, rel }))),
  ];
}

/** `f` survives in `after` when some fact says the same, with its role (a fact with no role is covered by any). */
export const covers = (after: Fact[], f: Fact): boolean =>
  after.some((a) => a.key === f.key && a.card === f.card && a.dir === f.dir && (!f.role || a.role === f.role));

/** The drawn line for `key`, read in `relEnds`' direction. */
export function drawnAs(lines: Relationship[], key: string): Relationship | undefined {
  return lines.find((r) => linkKey(r) === key);
}

/** Cardinality of `rel` read from `from` model's end. */
export function cardFrom(rel: Relationship, fromModel: string): Cardinality {
  return rel.fromModel.toLowerCase() === fromModel.toLowerCase() ? rel.cardinality : SWAP[rel.cardinality];
}

// ---------------------------------------------------------------------------
// Host mirror: the provider's handlers, line for line (SemanticEditorProvider)
// ---------------------------------------------------------------------------

export interface Outcome { world: World; error?: string; report?: string[]; notice?: string[] }
export type Ends = Pick<Relationship, 'fromModel' | 'fromColumn' | 'toModel' | 'toColumn'>;

/** One canvas edit from diagram `d`, decided by the provider's own planner. */
export function hostWrite(w: World, op: RelationshipWriteOp, d: DomainName = 'D1'): Outcome {
  const plan = planRelationshipWrite(op, { home: libraryMode(w) ? 'library' : 'domain', models: libModels(w), domainRelationships: clone(w.dom[d]) });
  if (!plan.ok) return { world: w, error: plan.error };
  const out = withLib(w, plan.changed);
  if (plan.domainRelationships) out.dom[d] = clone(plan.domainRelationships);
  if (op.kind !== 'remove' || !libraryMode(w)) return { world: out };
  // The provider's delete notice: other diagrams still drawing a copy of their own.
  const others = (['D1', 'D2', 'D3'] as const).filter((x) => x !== d)
    .map((x) => ({ label: x, models: out.domModels[x], relationships: out.dom[x] }));
  return { world: out, notice: diagramsStillDrawing(op.keys, others) };
}

export const hostAdd = (w: World, p: Relationship, d: DomainName = 'D1'): Outcome => hostWrite(w, { kind: 'add', drawn: p }, d);
export const hostUpdate = (w: World, p: Relationship, d: DomainName = 'D1'): Outcome =>
  hostWrite(w, { kind: 'update', ends: p, cardinality: p.cardinality }, d);
export const hostEdit = (w: World, original: Ends, p: Relationship, d: DomainName = 'D1'): Outcome =>
  hostWrite(w, { kind: 'edit', original, drawn: p }, d);
export const hostRemove = (w: World, keys: Ends[], d: DomainName = 'D1'): Outcome => hostWrite(w, { kind: 'remove', keys }, d);

/** Add Existing Model / Draw from dbt: `fct` joins D3 (which holds `dim`) with dbt's relationship. */
export function hostRoute(w: World, dbt: Relationship): Outcome {
  const out = clone(w);
  out.domModels.D3 = ['dim', 'fct'];
  // relationshipsForAddedModels filters D3's own relationships by linkKey.
  const added = w.dom.D3.some((r) => sameLink(r, dbt)) ? [] : [dbt];
  if (added.length === 0 || !libraryMode(w)) {
    out.dom.D3.push(...added);
    return { world: out };
  }
  const library = libModels(w);
  const others = drawnDiagramCopies((['D1', 'D2'] as const).map((d) => ({ label: d, models: w.domModels[d], relationships: w.dom[d] })));
  const { kept, changed } = routeToLibrary(added, [], (name) => library.find((m) => m.name === name) ?? null, others);
  const res = withLib(out, changed);
  res.dom.D3.push(...kept);
  return { world: res };
}

/** Column rename in `model` from D1 (handleUpdateColumn, v5): the library, D1 and the other diagrams' own copies. */
export function hostRenameColumn(w: World, model: ModelName, oldName: string, newName: string): Outcome {
  const models = libModels(w);
  const own = models.find((m) => m.name === model)!;
  renameColumnInRelationships([own], model, oldName, newName);
  renameColumnInRelationships(models.filter((m) => m.name !== model), model, oldName, newName);
  const out = withLib(w, models);
  // The open diagram, and every other diagram's own copies, in the same edit (#133 L5).
  for (const d of ['D1', 'D2', 'D3'] as const) {
    renameColumnInDomainRelationships(out.dom[d] as unknown as Array<Record<string, unknown>>, model, oldName, newName);
  }
  return { world: out };
}

/** The Move command's plan, as `runMove` builds it. */
export function movePlan(w: World, domainOrder: DomainName[] = ['D1', 'D2', 'D3'], modelOrder: ModelName[] = ['dim', 'fct']): MoveToLibraryPlan {
  const domains = domainOrder
    .map((d) => ({ label: d, relationships: clone(w.dom[d]) }))
    .filter((d) => d.relationships.length > 0);
  const cache = new Map<string, SemanticModel | null>();
  const libraryModel = (name: string): SemanticModel | null => {
    if (!cache.has(name)) cache.set(name, libModels(w).find((m) => m.name === name) ?? null);
    return cache.get(name) ?? null;
  };
  return planMoveToLibrary(domains, libraryModel, libModels(w, modelOrder), () => false);
}

/** A conflict pick: a definition, or undefined to leave it. */
export type MovePick = ConflictDefinition | undefined;

/** Every combination of conflict picks for `plan`. */
export function pickSets(plan: MoveToLibraryPlan): MovePick[][] {
  let sets: MovePick[][] = [[]];
  for (const c of plan.conflicts) sets = sets.flatMap((set) => [...c.definitions, undefined].map((o) => [...set, o]));
  return sets;
}

export const pickLabel = (picks: MovePick[]): string =>
  picks.length ? ` [${picks.map((d) => (d ? SHORT[d.cardinality] : 'leave')).join(',')}]` : '';

/** `runMove` after the dialogs: `picks[i]` settles conflict i (undefined = leave it). */
export function moveApply(w: World, plan0: MoveToLibraryPlan, picks: MovePick[]): Outcome {
  let plan = plan0;
  if (plan.removeFromDomains.size === 0 && plan.conflicts.length === 0 && plan.rehome.length === 0) {
    return { world: w, report: ['nothing to move'] };
  }
  plan0.conflicts.forEach((conflict, i) => { if (picks[i]) plan = resolveConflict(plan, conflict, picks[i]!); });
  if (plan.removeFromDomains.size === 0 && plan.rehome.length === 0) return { world: w, report: ['nothing changed'] };
  let out = clone(w);
  for (const name of moveTargets(plan)) {
    const copy = libModels(out).find((m) => m.name === name)!;
    if (applyMoveToModel(plan, copy)) out = withLib(out, [copy]);
  }
  for (const d of ['D1', 'D2', 'D3'] as const) {
    const keys = plan.removeFromDomains.get(d);
    if (keys) out.dom[d] = out.dom[d].filter((r) => !keys.has(linkKey(r)));
  }
  return { world: out, report: [...plan.conflicts.map(() => 'conflict left'), ...plan.disagreements.map(() => 'disagreement')] };
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export function copyAlphabet(roles: Array<string | undefined>, uppers: boolean[]): Copy[] {
  const out: Copy[] = [];
  for (const card of CARDS) for (const role of roles) for (const upper of uppers) {
    out.push({ where: 'dim', dir: 'df', card, role, upper });
    out.push({ where: 'fct', dir: 'fd', card, role, upper });
    for (const where of ['D1', 'D2'] as const) for (const dir of ['fd', 'df'] as const) out.push({ where, dir, card, role, upper });
  }
  return out;
}

export const copyCode = (c: Copy): string => `${c.where}:${c.dir}:${SHORT[c.card]}:${c.role ?? '-'}:${c.upper ? 'K' : 'k'}`;

/** Canonical under the symmetries D1↔D2 and r1↔r2; null when `copies` is not its class's representative. */
export function representative(copies: Copy[]): boolean {
  const code = (cs: Copy[]): string => cs.map(copyCode).sort().join(' ');
  const swapD = (c: Copy): Copy => ({ ...c, where: c.where === 'D1' ? 'D2' : c.where === 'D2' ? 'D1' : c.where });
  const swapR = (c: Copy): Copy => ({ ...c, role: c.role === 'r1' ? 'r2' : c.role === 'r2' ? 'r1' : c.role });
  const mine = code(copies);
  return [copies.map(swapD), copies.map(swapR), copies.map((c) => swapR(swapD(c)))].every((cs) => code(cs) >= mine);
}

export function* multisets(alphabet: Copy[], size: number, start = 0, acc: Copy[] = []): Generator<Copy[]> {
  if (acc.length === size) { yield acc; return; }
  for (let i = start; i < alphabet.length; i++) yield* multisets(alphabet, size, i, [...acc, alphabet[i]]);
}

export interface State { profile: Profile; copies: Copy[]; bystander: boolean }

/**
 * `full` (default): every profile, ≤2 copies (roles none/r1/r2 and upper-case
 * spellings for star and sharedKey), plus 3 copies for star. `small`: ≤2
 * copies over roles none/r1, lower case — the CI-sized scope.
 */
export function* states(scope: 'full' | 'small' = (process.env.STATESPACE_SCOPE as 'small' | undefined) ?? 'full'): Generator<State> {
  const small = copyAlphabet([undefined, 'r1'], [false]);
  const full = scope === 'small' ? small : copyAlphabet([undefined, 'r1', 'r2'], [false, true]);
  for (const profile of Object.keys(PROFILES) as Profile[]) {
    for (const bystander of [false, true]) {
      const alphabet = profile === 'star' || profile === 'sharedKey' ? full : small;
      for (let size = 0; size <= 2; size++) {
        for (const copies of multisets(alphabet, size)) if (representative(copies)) yield { profile, copies, bystander };
      }
      if (profile === 'star' && scope === 'full') {
        for (const copies of multisets(small, 3)) if (representative(copies)) yield { profile, copies, bystander };
      }
    }
  }
}

/** Smaller is simpler: fewer copies, then no bystander, the star profile, no roles, no upper case. */
export function weight(s: State): number {
  return s.copies.length * 100 + (s.bystander ? 10 : 0) + (s.profile === 'star' ? 0 : 5)
    + s.copies.filter((c) => c.role).length * 2 + s.copies.filter((c) => c.upper).length * 3;
}

// ---------------------------------------------------------------------------
// Operations (all from D1's canvas)
// ---------------------------------------------------------------------------

/** A canvas message, as the webview sends it. */
export type HostCall = { d?: DomainName } & (
  | { kind: 'add'; p: Relationship }
  | { kind: 'update'; p: Relationship }
  | { kind: 'edit'; original: Ends; p: Relationship }
  | { kind: 'remove'; keys: Ends[] });

export function runHost(w: World, c: HostCall): Outcome {
  switch (c.kind) {
    case 'add': return hostAdd(w, c.p, c.d);
    case 'update': return hostUpdate(w, c.p, c.d);
    case 'edit': return hostEdit(w, c.original, c.p, c.d);
    case 'remove': return hostRemove(w, c.keys, c.d);
  }
}

/** The webview message for `c`. */
export function messageOf(c: HostCall): { type: string; payload: unknown } {
  switch (c.kind) {
    case 'add': return { type: 'addRelationship', payload: c.p };
    case 'update': return { type: 'updateRelationship', payload: c.p };
    case 'edit': return {
      type: 'editRelationship',
      payload: {
        originalFromModel: c.original.fromModel, originalFromColumn: c.original.fromColumn,
        originalToModel: c.original.toModel, originalToColumn: c.original.toColumn, ...c.p,
      },
    };
    case 'remove': return { type: 'removeRelationship', payload: c.keys[0] };
  }
}

const host = (d: DomainName, call: HostCall): { call: HostCall; run: (w: World) => Outcome } => {
  const c = { ...call, d } as HostCall;
  return { call: c, run: (w) => runHost(w, c) };
};

export interface Op {
  name: string;
  /** The canvas message, for ops the provider handles (cross-checked against the real one). */
  call?: HostCall;
  /** Link keys the operation sets out to change; every other fact must survive. */
  targets: string[];
  run: (w: World) => Outcome;
  /** Extra postconditions on success; return violation texts. */
  post?: (before: World, after: World, outcome: Outcome) => Array<[string, string]>;
}

export const fd = (card: Cardinality, role?: string): Relationship =>
  ({ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: card, ...(role ? { role } : {}) });
export const reverseEnds = (r: Relationship): Relationship =>
  ({ ...r, fromModel: r.toModel, fromColumn: r.toColumn, toModel: r.fromModel, toColumn: r.fromColumn, cardinality: SWAP[r.cardinality] });

export function opsFor(w: World, d: DomainName = 'D1', opts: { renames?: boolean } = { renames: true }): Op[] {
  const other: DomainName = d === 'D1' ? 'D2' : 'D1';
  const at = d === 'D1' ? '' : ` @${d}`;
  const ops: Op[] = [];
  const lines = draw(w, d);
  const line = drawnAs(lines, L_KEY);

  // Add, either direction, every cardinality, with and without a role. The
  // New Relationship dialog refuses a link D1 already draws (sameLink), so
  // the host only ever sees an add for a link D1 does not draw.
  if (!line) for (const dir of ['fd', 'df'] as const) for (const card of CARDS) for (const role of [undefined, 'r1']) {
    const p = dir === 'fd' ? fd(card, role) : reverseEnds(fd(SWAP[card], role));
    ops.push({
      name: `add ${dir === 'fd' ? 'fct→dim' : 'dim→fct'} ${SHORT[p.cardinality]}${role ? ' r1' : ''}` + at,
      targets: [L_KEY],
      ...host(d, { kind: 'add', p }),
      post: (_b, a) => {
        const got = drawnAs(draw(a, d), L_KEY);
        if (!got) return [['add-not-drawn', `${d} draws nothing after a successful add`]];
        const v: Array<[string, string]> = [];
        if (cardFrom(got, p.fromModel) !== p.cardinality) v.push(['add-wrong-card', `drew ${SHORT[cardFrom(got, p.fromModel)]} from ${p.fromModel}, asked ${SHORT[p.cardinality]}`]);
        if ((got.role ?? undefined) !== role) v.push(['add-wrong-role', `drew role ${got.role ?? '-'} asked ${role ?? '-'}`]);
        return v;
      },
    });
  }

  if (line) {
    const ends: Ends = { fromModel: line.fromModel, fromColumn: line.fromColumn, toModel: line.toModel, toColumn: line.toColumn };
    // A line drawn without a role may show the one a stored copy carries (the
    // rule: the drawn copy's role, else any copy's role).
    const storedRoles = (b: World): string[] => storedCopies(b)
      .filter((c) => linkKey(c.rel) === L_KEY && (c.file.endsWith('.yml') || c.file === d)).map((c) => c.rel.role ?? '').filter(Boolean);
    const keepsRole = (want?: string, canGain = false) => (b: World, a: World): Array<[string, string]> => {
      const got = drawnAs(draw(a, d), L_KEY);
      if (!got) return [['edit-lost-line', `${d} draws nothing after the edit`]];
      if ((got.role ?? undefined) === want) return [];
      if (canGain && want === undefined && got.role && storedRoles(b).includes(got.role)) return [];
      return [['edit-role', `drew role ${got.role ?? '-'}, expected ${want ?? '-'}`]];
    };
    const drawsCard = (card: Cardinality, role?: string, canGain = false) => (b: World, a: World): Array<[string, string]> => {
      const got = drawnAs(draw(a, d), L_KEY);
      if (!got) return [['edit-lost-line', `${d} draws nothing after the edit`]];
      const v: Array<[string, string]> = [];
      if (cardFrom(got, line.fromModel) !== card) v.push(['edit-wrong-card', `drew ${SHORT[cardFrom(got, line.fromModel)]} from ${line.fromModel}, asked ${SHORT[card]}`]);
      v.push(...keepsRole(role, canGain)(b, a));
      return v;
    };
    ops.push({
      name: 'swap ⇄' + at, targets: [L_KEY],
      ...host(d, { kind: 'update', p: { ...ends, cardinality: SWAP[line.cardinality] } }),
      post: drawsCard(SWAP[line.cardinality], line.role, true),
    });
    for (const card of CARDS) {
      ops.push({
        name: `set cardinality ${SHORT[card]}` + at, targets: [L_KEY],
        ...host(d, { kind: 'update', p: { ...ends, cardinality: card } }),
        post: drawsCard(card, line.role, true),
      });
    }
    for (const role of [undefined, 'r1', 'r2']) {
      ops.push({
        name: `edit role → ${role ?? 'none'}` + at, targets: [L_KEY],
        ...host(d, { kind: 'edit', original: ends, p: { ...ends, cardinality: line.cardinality, ...(role ? { role } : {}) } }),
        post: drawsCard(line.cardinality, role),
      });
    }
    ops.push({
      name: 'edit: turn ends round' + at, targets: [L_KEY],
      ...host(d, { kind: 'edit', original: ends, p: { ...reverseEnds({ ...ends, cardinality: line.cardinality }), ...(line.role ? { role: line.role } : {}) } }),
      post: drawsCard(line.cardinality, line.role),
    });
    if (w.lib.fct.every((e) => e.fromColumn !== 'k2')) {
      ops.push({
        name: 'edit: re-key to fct.k2' + at, targets: [L_KEY, linkKey({ ...ends, fromModel: 'fct', fromColumn: 'k2', toModel: 'dim', toColumn: 'k' })],
        ...host(d, { kind: 'edit', original: ends, p: { fromModel: 'fct', fromColumn: 'k2', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' } }),
        post: (_b, a) => (drawnAs(draw(a, d), L_KEY) ? [['rekey-old-still-drawn', 'the old link is still drawn']] : []),
      });
    }
    ops.push({
      name: 'delete' + at, targets: [L_KEY],
      ...host(d, { kind: 'remove', keys: [ends] }),
      post: (_b, a, outcome) => {
        const v: Array<[string, string]> = [];
        if (drawnAs(draw(a, d), L_KEY)) v.push(['I7 delete-total', `${d} still draws the deleted link`]);
        if (storedCopies(a).some((c) => (c.file.endsWith('.yml') || c.file === d) && linkKey(c.rel) === L_KEY)) {
          v.push(['I7 delete-total', `a library or ${d} copy survives`]);
        }
        // D3: another diagram may keep its own copy, but the user is told which.
        if (libraryMode(_b) && drawnAs(draw(a, other), L_KEY) && !(outcome.notice ?? []).includes(other)) {
          v.push(['I7b delete-other-diagram', `library mode: ${other} still draws the deleted link (its own copy), unnamed`]);
        }
        return v;
      },
    });
  }

  // The bystander's edits must leave L alone.
  const by = drawnAs(lines, linkKey({ fromModel: 'fct', fromColumn: 'k2', toModel: 'dim', toColumn: 'k' }));
  if (by) {
    const ends: Ends = { fromModel: by.fromModel, fromColumn: by.fromColumn, toModel: by.toModel, toColumn: by.toColumn };
    ops.push({ name: 'bystander: swap' + at, targets: [linkKey(by)], ...host(d, { kind: 'update', p: { ...ends, cardinality: SWAP[by.cardinality] } }) });
    ops.push({ name: 'bystander: delete' + at, targets: [linkKey(by)], ...host(d, { kind: 'remove', keys: [ends] }) });
  }

  // Add Existing Model / Draw from dbt: dbt's canonical relationship.
  const known = storedCopies(w).some((c) => linkKey(c.rel) === L_KEY);
  if (d === 'D1') for (const dbt of [fd('many-to-one'), fd('one-to-one'), { ...reverseEnds(fd('one-to-one')) }]) {
    ops.push({
      name: `dbt adds fct to D3: ${dbt.fromModel}→${dbt.toModel} ${SHORT[dbt.cardinality]}` + at,
      targets: known ? [] : [L_KEY], // an existing link's definition must not be overwritten
      run: (x) => hostRoute(x, dbt),
    });
  }

  // Column renames (pre-#133 behaviour, included for completeness).
  if (opts.renames !== false && d === 'D1') for (const model of ['dim', 'fct'] as const) {
    ops.push({ name: `rename ${model}.k → key` + at, targets: ['rename'], run: (x) => hostRenameColumn(x, model, 'k', 'key') });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Invariants
// ---------------------------------------------------------------------------

export type Violation = [invariant: string, detail: string];

export function sortRels(rels: Relationship[]): string {
  return rels.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}:${SHORT[r.cardinality]}:${r.role ?? '-'}`).sort().join(' | ');
}

/** I2, I3, I8 for every diagram of `w`. */
export function readInvariants(w: World): Violation[] {
  const v: Violation[] = [];
  for (const d of ['D1', 'D2', 'D3'] as const) {
    if (w.domModels[d].length < 2) continue;
    const lines = draw(w, d);
    const keys = lines.map(linkKey);
    if (new Set(keys).size !== keys.length) v.push(['I2 one-line-per-link', `${d} draws ${keys.length} lines for ${new Set(keys).size} links`]);
    const flipped = draw(w, d, [...w.domModels[d]].reverse());
    if (sortRels(flipped) !== sortRels(lines)) v.push(['I3 deterministic (model order)', `${d}: ${sortRels(lines)}  vs  ${sortRels(flipped)}`]);
    const reordered = draw(w, d, undefined, true);
    if (sortRels(reordered) !== sortRels(lines)) v.push(['I3b deterministic (entry order within a file)', `${d}: ${sortRels(lines)}  vs  ${sortRels(reordered)}`]);
    const stored = [...storedCopies(w).filter((c) => c.file.endsWith('.yml')).map((c) => c.rel), ...w.dom[d]];
    for (const line of lines) {
      const backing = stored.filter((s) => sameLink(s, line) && cardFrom(s, line.fromModel) === line.cardinality);
      if (backing.length === 0) v.push(['I8 drawn-is-stored', `${d} draws ${sortRels([line])}, no copy says that`]);
      else if (line.role && !stored.some((s) => sameLink(s, line) && s.role === line.role)) v.push(['I8 drawn-is-stored', `${d} role ${line.role} not stored`]);
    }
  }
  return v;
}

/** Read violations of `after` that `before` did not already have (same invariant, same diagram). */
export function newReadViolations(before: World, after: World): Violation[] {
  const had = new Set(readInvariants(before).map(([inv, d]) => `${inv}|${d.slice(0, 2)}`));
  return readInvariants(after).filter(([inv, d]) => !had.has(`${inv}|${d.slice(0, 2)}`));
}

/** I9: no file the operation wrote holds two entries for one link. */
export function noDuplicates(before: World, after: World): Violation[] {
  const v: Violation[] = [];
  const files: Array<[string, Relationship[], Relationship[]]> = [
    ...(['dim', 'fct'] as const).map((m): [string, Relationship[], Relationship[]] => [
      `${m}.yml`, before.lib[m].map((e) => ({ fromModel: m, ...e })), after.lib[m].map((e) => ({ fromModel: m, ...e }))]),
    ...(['D1', 'D2', 'D3'] as const).map((d): [string, Relationship[], Relationship[]] => [d, before.dom[d], after.dom[d]]),
  ];
  for (const [file, b, a] of files) {
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const dupes = (rels: Relationship[]) => rels.length - new Set(rels.map(linkKey)).size;
    if (dupes(a) > dupes(b)) v.push(['I9 no-duplicate-entries', `${file} written with two entries for one link`]);
  }
  return v;
}

/** I4: L as written by add / swap / edit — one canonical library copy in its home, none in D1. */
export function canonicalAfterWrite(after: World, d: DomainName = 'D1'): Violation[] {
  const v: Violation[] = [];
  const copies = storedCopies(after).filter((c) => linkKey(c.rel) === L_KEY && (c.file.endsWith('.yml') || c.file === d));
  const lib = copies.filter((c) => c.file.endsWith('.yml'));
  if (lib.length !== 1) v.push(['I4 canonical-after-write', `${lib.length} library copies after the write`]);
  for (const c of lib) if (c.rel.cardinality === 'one-to-many') v.push(['I4 canonical-after-write', `${c.file} holds one-to-many`]);
  if (copies.some((c) => c.file === d)) v.push(['I4 canonical-after-write', `${d} still holds a copy`]);
  return v;
}

/** I1: every fact before survives unless its link is a target. */
export function noSilentLoss(before: World, after: World, targets: string[]): Violation[] {
  const v: Violation[] = [];
  const afterFacts = storedCopies(after).map((c) => factOf(c.rel));
  for (const f of storedCopies(before).map((c) => factOf(c.rel))) {
    if (targets.includes(f.key)) continue;
    if (covers(afterFacts, f)) continue;
    if (covers(afterFacts, { ...f, role: undefined })) v.push(['I1 no-silent-loss (role)', `lost role of ${factText(f)}`]);
    else v.push(['I1 no-silent-loss', `lost ${factText(f)}`]);
  }
  return v;
}

/** I1b: what each diagram draws for untargeted links is unchanged. */
export function sameDrawing(before: World, after: World, targets: string[], allow: (d: DomainName, key: string) => boolean = () => false): Violation[] {
  const v: Violation[] = [];
  for (const d of ['D1', 'D2'] as const) {
    const b = draw(before, d).filter((r) => !targets.includes(linkKey(r)));
    const a = draw(after, d).filter((r) => !targets.includes(linkKey(r)));
    for (const line of b) {
      if (allow(d, linkKey(line))) continue;
      if (b.filter((r) => sameLink(r, line)).length > 1) continue; // drawn twice already (I2 on the state)
      const got = a.find((r) => sameLink(r, line));
      const fb = factOf(line);
      const fa = got ? factOf(got) : undefined;
      // A label gained where there was none is the shared definition showing; losing or changing one is not.
      if (!fa || fa.card !== fb.card || fa.dir !== fb.dir || (fb.role !== undefined && fa.role !== fb.role)) {
        v.push(['I1b drawing-unchanged', `${d}: ${factText(fb)} became ${fa ? factText(fa) : 'nothing'}`]);
      }
    }
  }
  return v;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export function describeState(s: State): string {
  return `[${s.profile}${s.bystander ? ' +bystander' : ''}] ${s.copies.length === 0 ? '(no copy of L)' : s.copies.map((c) => {
    const r = relOf(c);
    return `${c.where === 'dim' || c.where === 'fct' ? `${c.where}.yml` : c.where}: ${r.fromModel}.${r.fromColumn}→${r.toModel}.${r.toColumn} ${SHORT[c.card]}${c.role ? ` "${c.role}"` : ''}`;
  }).join('; ')}`;
}

export interface Found { count: number; weight: number; state: string; op: string; detail: string }

/** Every invariant after `op` took `w` to `a` (a successful run). */
export function checkOp(w: World, op: Op, a: World, outcome: Outcome = { world: a }): Violation[] {
    const vs: Violation[] = [...newReadViolations(w, a), ...noDuplicates(w, a)];
    if (op.targets.includes('rename')) {
      // Renaming k → key: every fact survives, renamed.
      const model = op.name.startsWith('rename dim') ? 'dim' : 'fct';
      const ren = (f: Fact): Fact => {
        const sub = (t: string) => t.split('\u0000').map((e) => (e === `${model}.k` ? `${model}.key` : e)).sort().join('\u0000');
        return { ...f, key: sub(f.key), dir: f.dir === `${model}.k` ? `${model}.key` : f.dir };
      };
      const afterFacts = storedCopies(a).map((c) => factOf(c.rel));
      for (const c of storedCopies(w)) {
        const f = factOf(c.rel);
        if (covers(afterFacts, ren(f))) continue;
        const why = c.file === 'D2' ? 'in another diagram' : /K/.test(c.rel.fromColumn + c.rel.toColumn) ? 'spelled in another case' : 'other';
        vs.push([`R rename-follows (${why})`, `${factText(f)} in ${c.file} not renamed`]);
      }
    } else {
      vs.push(...noSilentLoss(w, a, op.targets));
      if (!op.name.startsWith('add') || op.targets.length === 0) vs.push(...sameDrawing(w, a, op.targets));
      vs.push(...(op.post?.(w, a, outcome) ?? []));
      const opDomain: DomainName = op.call?.d ?? 'D1';
    const writesL = op.targets.includes(L_KEY) && /^(add|swap|set|edit)/.test(op.name) && libraryMode(w) && drawnAs(draw(a, opDomain), L_KEY);
      if (writesL && !op.name.includes('re-key')) vs.push(...canonicalAfterWrite(a, opDomain));
    }
  return vs;
}

/** Every invariant after the Move took `w` to `a` with `picks`. */
export function checkMove(w: World, plan: MoveToLibraryPlan, picks: MovePick[], a: World): Violation[] {
  const settled = plan.conflicts.filter((_, i) => picks[i]).map((c) => linkKey(c.relationship));
  // Turned round by its keys (the preview lists each): library entries and diagram copies.
  const turned = [
    ...plan.rehome.filter((r) => factOf(r.stored).dir !== factOf(r.to).dir).map((r) => r.stored),
    ...plan.turned.map((t) => t.relationship),
  ];
  // A diagram copy the library's version replaces is listed in the preview (D2).
  const listed = [...turned, ...plan.keptLibrary.map((k) => k.relationship)].map((r) => factText(factOf(r)));
  const vs: Violation[] = [...newReadViolations(w, a), ...noDuplicates(w, a)];
  vs.push(...noSilentLoss(w, a, settled).filter(([, d]) => !listed.some((t) => d.endsWith(t))));
  plan.conflicts.forEach((c, i) => {
    const pick = picks[i];
    if (!pick) return;
    const role = pick.relationship.role ?? c.relationship.role;
    const want = factOf({ ...pick.relationship, ...(role ? { role } : {}) });
    if (!covers(storedCopies(a).map((x) => factOf(x.rel)), want)) vs.push(['M picked-definition-stored', `picked ${factText(want)} is not stored`]);
    for (const d of ['D1', 'D2'] as const) {
      const got = drawnAs(draw(a, d), linkKey(c.relationship));
      if (got && factText(factOf(got)) !== factText(want)) vs.push(['M picked-definition-drawn', `${d} draws ${factText(factOf(got))}, picked ${factText(want)}`]);
    }
  });
  vs.push(...sameDrawing(w, a, [...settled, ...turned.map(linkKey)]));
  // I5: a second run moves nothing and changes nothing.
  const again = movePlan(a);
  if (again.toLibrary.length > 0 || again.rehome.length > 0 || [...again.removeFromDomains.values()].some((k) => k.size > 0)) {
    vs.push(['I5 move-idempotent', `second plan: toLibrary ${again.toLibrary.length}, rehome ${again.rehome.length}, removeFromDomains ${[...again.removeFromDomains.values()].reduce((n, k) => n + k.size, 0)}`]);
  }
  const twice = moveApply(a, again, again.conflicts.map(() => undefined));
  if (JSON.stringify(twice.world) !== JSON.stringify(a) && again.conflicts.length === 0) vs.push(['I5 move-idempotent', 'second apply changed the files']);
  // Determinism: the order domains and models are listed in does not matter.
  const flippedPlan = movePlan(w, ['D2', 'D1', 'D3'], ['fct', 'dim']);
  if (flippedPlan.conflicts.length === plan.conflicts.length) {
    // The same pick by meaning: the definition that says the same.
    const flipped = moveApply(w, flippedPlan, flippedPlan.conflicts.map((fc) => {
      const i = plan.conflicts.findIndex((c) => sameLink(fc.relationship, c.relationship));
      const pick = picks[i];
      return pick && fc.definitions.find((d) => factText(factOf(d.relationship)) === factText(factOf(pick.relationship)));
    }));
    const norm = (x: World) => JSON.stringify(storedCopies(x).map((c) => `${c.file}|${factText(factOf(c.rel))}`).sort());
    if (norm(flipped.world) !== norm(a)) vs.push(['M3 move-deterministic', `domain order changes the result: ${norm(a)} vs ${norm(flipped.world)}`]);
  } else {
    vs.push(['M3 move-deterministic', 'domain order changes the conflicts found']);
  }
  return vs;
}
