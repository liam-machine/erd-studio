/**
 * The exhaustive check's two further universes (#133 L2, L3) — see
 * relationshipStateSpace.model.ts for the method and the main universe.
 *
 * SELF: one model, `emp`, and one link L = emp.mgr ↔ emp.id (a
 * self-reference), stored in emp.yml, D1 or D2, either way round, under a
 * profile that keys `id` or keys nothing.
 *
 * GROUP: `fct` and `dim` (dim keyed by the composite (k, k_x)), and a
 * composite foreign key G = { L: fct.k ↔ dim.k, Lx: fct.k_x ↔ dim.k_x }. A
 * copy of G is the group itself, a hand-edited partial (L alone with the
 * key) or the two members as single links (what a 1.6.7 save leaves).
 *
 * Every write goes through `planRelationshipWrite`, every read through core's
 * `mergeLibraryRelationships`, every Move through `planMoveToLibrary` /
 * `applyMoveToModel`, every drawing through the renderer's `transformDomain`
 * — the code the extension runs.
 */

import { canonicalRelationship, linkKey, mergeLibraryRelationships, toDisplayDomain } from '@erd-studio/core';
import type { DisplayDomain } from '@erd-studio/core';
import { transformDomain } from '@erd-studio/renderer/editor';
import type { FkFlowEdge } from '@erd-studio/renderer/editor';
import {
  applyMoveToModel, groupOf, moveTargets, planMoveToLibrary, planRelationshipWrite, removeColumnFromDomainRelationships,
  removeColumnRelationships, resolveConflict, usesLibraryRelationships,
} from '../../src/services/libraryRelationships';
import type { ConflictDefinition, MoveToLibraryPlan, RelationshipWriteOp } from '../../src/services/libraryRelationships';
import { validateRelationshipEnds } from '../../src/providers/payloadValidation';
import type { Cardinality, ColumnDef, ModelRelationship, Relationship, SemanticModel } from '../../src/types/semantic';
import { CARDS, SHORT, SWAP, clone, multisets } from './relationshipStateSpace.model';
import type { Violation } from './relationshipStateSpace.model';

type D = 'D1' | 'D2' | 'D3';
const DS: D[] = ['D1', 'D2', 'D3'];

/** A world of any models: their columns, library entries, and three diagrams. */
export interface GWorld {
  columns: Record<string, ColumnDef[]>;
  lib: Record<string, ModelRelationship[]>;
  dom: Record<D, Relationship[]>;
  domModels: Record<D, string[]>;
}

const col = (name: string, pk = false): ColumnDef => ({ name, dataType: 'string', description: '', ...(pk ? { isPrimaryKey: true } : {}) });

export function gModels(w: GWorld, order = Object.keys(w.columns)): SemanticModel[] {
  return order.map((name) => ({ name, columns: clone(w.columns[name]), ...(w.lib[name].length > 0 ? { relationships: clone(w.lib[name]) } : {}) }));
}
const withModels = (w: GWorld, models: readonly SemanticModel[]): GWorld => {
  const next = clone(w);
  for (const m of models) next.lib[m.name] = clone(m.relationships ?? []);
  return next;
};
const libraryMode = (w: GWorld): boolean => usesLibraryRelationships(gModels(w), DS.reduce((n, d) => n + w.dom[d].length, 0));

export function gDraw(w: GWorld, d: D, reverse = false): Relationship[] {
  const order = reverse ? [...w.domModels[d]].reverse() : w.domModels[d];
  const models = gModels(w, order);
  if (reverse) for (const m of models) m.relationships?.reverse();
  return mergeLibraryRelationships(models, clone(reverse ? [...w.dom[d]].reverse() : w.dom[d]));
}

export function gStored(w: GWorld): Array<{ file: string; rel: Relationship }> {
  return [
    ...Object.keys(w.lib).flatMap((m) => w.lib[m].map((e) => ({ file: `${m}.yml`, rel: { fromModel: m, ...e } }))),
    ...DS.flatMap((d) => w.dom[d].map((rel) => ({ file: d, rel }))),
  ];
}

export interface GOutcome { world: GWorld; error?: string }

export function gWrite(w: GWorld, op: RelationshipWriteOp, d: D = 'D1'): GOutcome {
  const plan = planRelationshipWrite(op, { home: libraryMode(w) ? 'library' : 'domain', models: gModels(w), domainRelationships: clone(w.dom[d]) });
  if (!plan.ok) return { world: w, error: plan.error };
  const out = withModels(w, plan.changed);
  if (plan.domainRelationships) out.dom[d] = clone(plan.domainRelationships);
  return { world: out };
}

export function gMovePlan(w: GWorld, domainOrder: D[] = ['D1', 'D2', 'D3'], modelOrder = Object.keys(w.columns)): MoveToLibraryPlan {
  const domains = domainOrder.map((d) => ({ label: d, relationships: clone(w.dom[d]) })).filter((d) => d.relationships.length > 0);
  const libraryModel = (name: string): SemanticModel | null => gModels(w).find((m) => m.name === name.toLowerCase()) ?? null;
  return planMoveToLibrary(domains, libraryModel, gModels(w, modelOrder), () => false);
}

export function gMoveApply(w: GWorld, plan0: MoveToLibraryPlan, picks: Array<ConflictDefinition | undefined>): GWorld {
  let plan = plan0;
  plan0.conflicts.forEach((c, i) => { if (picks[i]) plan = resolveConflict(plan, c, picks[i]!); });
  let out = clone(w);
  for (const name of moveTargets(plan)) {
    const copy = gModels(out).find((m) => m.name === name.toLowerCase())!;
    if (applyMoveToModel(plan, copy)) out = withModels(out, [copy]);
  }
  for (const d of DS) {
    const keys = plan.removeFromDomains.get(d);
    if (keys) out.dom[d] = out.dom[d].filter((r) => !keys.has(linkKey(r)));
  }
  return out;
}

export function gPickSets(plan: MoveToLibraryPlan): Array<Array<ConflictDefinition | undefined>> {
  let sets: Array<Array<ConflictDefinition | undefined>> = [[]];
  for (const c of plan.conflicts) sets = sets.flatMap((set) => [...c.definitions, undefined].map((o) => [...set, o]));
  return sets;
}

/** The Move's invariants on any universe: a second run plans and changes nothing; diagram order decides nothing. */
function moveInvariants(w: GWorld, plan: MoveToLibraryPlan, picks: Array<ConflictDefinition | undefined>, a: GWorld): Violation[] {
  const v: Violation[] = [];
  const again = gMovePlan(a);
  if (again.toLibrary.length > 0 || again.rehome.length > 0 || [...again.removeFromDomains.values()].some((k) => k.size > 0)) {
    v.push(['I5 move-idempotent', `second plan: toLibrary ${again.toLibrary.length}, rehome ${again.rehome.length}`]);
  }
  const flipped = gMovePlan(w, ['D2', 'D1', 'D3'], [...Object.keys(w.columns)].reverse());
  if (flipped.conflicts.length === plan.conflicts.length) {
    const sig = (x: GWorld) => JSON.stringify(gStored(x).map((c) => `${c.file}|${linkKey(c.rel)}|${canonicalRelationship(c.rel).cardinality}|${c.rel.role ?? ''}|${c.rel.compositeKey ?? ''}`).sort());
    const flippedPicks = flipped.conflicts.map((fc) => {
      const i = plan.conflicts.findIndex((c) => linkKey(c.relationship) === linkKey(fc.relationship));
      const pick = picks[i];
      return pick && fc.definitions.find((d) => JSON.stringify(d.relationship) === JSON.stringify(pick.relationship)
        && JSON.stringify(d.members ?? null) === JSON.stringify(pick.members ?? null));
    });
    if (sig(gMoveApply(w, flipped, flippedPicks)) !== sig(a)) v.push(['M3 move-deterministic', 'diagram order changes the result']);
  } else {
    v.push(['M3 move-deterministic', 'diagram order changes the conflicts found']);
  }
  return v;
}

/** One line per link, and the same lines whatever the model or entry order. */
function drawingInvariants(w: GWorld, diagrams: D[]): Violation[] {
  const v: Violation[] = [];
  const text = (rels: Relationship[]) => rels.map((r) => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}:${SHORT[r.cardinality]}:${r.compositeKey ?? ''}:${r.role ?? ''}`).sort().join(' | ');
  for (const d of diagrams) {
    const lines = gDraw(w, d);
    if (new Set(lines.map(linkKey)).size !== lines.length) v.push(['I2 one-line-per-link', `${d} draws a link twice`]);
    if (text(gDraw(w, d, true)) !== text(lines)) v.push(['I3 deterministic', `${d}: ${text(lines)} vs ${text(gDraw(w, d, true))}`]);
  }
  return v;
}

// ---------------------------------------------------------------------------
// SELF: a self-reference
// ---------------------------------------------------------------------------

export type SelfProfile = 'self' | 'selfNoKeys';
export interface SelfCopy { where: 'emp' | 'D1' | 'D2'; dir: 'fd' | 'df'; card: Cardinality }
export const SELF_KEY = linkKey({ fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id' });

const selfRel = (c: Pick<SelfCopy, 'dir' | 'card'>): Relationship => (c.dir === 'fd'
  ? { fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'id', cardinality: c.card }
  : { fromModel: 'emp', fromColumn: 'id', toModel: 'emp', toColumn: 'mgr', cardinality: c.card });

export function selfWorld(profile: SelfProfile, copies: SelfCopy[]): GWorld {
  const w: GWorld = {
    columns: { emp: [col('id', profile === 'self'), col('mgr')] },
    lib: { emp: [] },
    dom: { D1: [], D2: [], D3: [] },
    domModels: { D1: ['emp'], D2: ['emp'], D3: [] },
  };
  for (const c of copies) {
    const rel = selfRel(c);
    if (c.where === 'emp') {
      const { fromModel: _f, ...entry } = rel;
      w.lib.emp.push(entry);
    } else {
      w.dom[c.where].push(rel);
    }
  }
  return w;
}

export function* selfStates(): Generator<{ profile: SelfProfile; copies: SelfCopy[] }> {
  const alphabet: SelfCopy[] = [];
  for (const where of ['emp', 'D1', 'D2'] as const) for (const dir of ['fd', 'df'] as const) for (const card of CARDS) alphabet.push({ where, dir, card });
  const code = (cs: SelfCopy[]) => cs.map((c) => `${c.where}${c.dir}${c.card}`).sort().join(' ');
  const swap = (c: SelfCopy): SelfCopy => ({ ...c, where: c.where === 'D1' ? 'D2' : c.where === 'D2' ? 'D1' : c.where });
  for (const profile of ['self', 'selfNoKeys'] as const) {
    for (let size = 0; size <= 2; size++) {
      for (const copies of multisets(alphabet, size)) if (code(copies) <= code(copies.map(swap))) yield { profile, copies };
    }
  }
}

/** The cardinality of `rel` read from the end at `column` of a self-reference. */
const cardFromColumn = (rel: Relationship, column: string): Cardinality => (rel.fromColumn === column ? rel.cardinality : SWAP[rel.cardinality]);

/** Every check of one SELF state: reads, each canvas edit from D1, and the Move. */
export function checkSelfState(profile: SelfProfile, copies: SelfCopy[]): Array<{ op: string; violations: Violation[] }> {
  const w = selfWorld(profile, copies);
  const results: Array<{ op: string; violations: Violation[] }> = [{ op: 'read', violations: drawingInvariants(w, ['D1', 'D2']) }];
  const line = gDraw(w, 'D1').find((r) => linkKey(r) === SELF_KEY);
  // S1: after a write, one copy, in its home (emp.yml in a library project, D1 otherwise), never one-to-many there.
  const s1 = (before: GWorld, after: GWorld, askedFrom: string, asked: Cardinality): Violation[] => {
    const v: Violation[] = [];
    const home = libraryMode(before) ? 'emp.yml' : 'D1';
    const copiesOfL = gStored(after).filter((c) => linkKey(c.rel) === SELF_KEY && (c.file === 'emp.yml' || c.file === 'D1'));
    if (copiesOfL.length !== 1 || copiesOfL[0].file !== home) v.push(['S1 self-home', `${copiesOfL.map((c) => c.file).join(', ') || 'no copy'} after the write`]);
    else if (home === 'emp.yml' && copiesOfL[0].rel.cardinality === 'one-to-many') {
      v.push(['S1 self-home', `stored ${copiesOfL[0].rel.fromColumn}→${copiesOfL[0].rel.toColumn} one-to-many`]);
    }
    const got = gDraw(after, 'D1').find((r) => linkKey(r) === SELF_KEY);
    if (!got) v.push(['S1 self-home', 'D1 draws nothing after the write']);
    else if (cardFromColumn(got, askedFrom) !== asked) v.push(['S1 self-home', `drew ${SHORT[cardFromColumn(got, askedFrom)]} from emp.${askedFrom}, asked ${SHORT[asked]}`]);
    return v;
  };
  const run = (name: string, op: RelationshipWriteOp, askedFrom: string, asked: Cardinality): void => {
    const out = gWrite(w, op);
    results.push({ op: name, violations: out.error ? (JSON.stringify(out.world) === JSON.stringify(w) ? [] : [['refusal-changed-world', out.error]]) : [...s1(w, out.world, askedFrom, asked), ...drawingInvariants(out.world, ['D1', 'D2'])] });
  };
  // A column pointing at itself is refused at the boundary.
  if (validateRelationshipEnds({ fromModel: 'emp', fromColumn: 'mgr', toModel: 'emp', toColumn: 'MGR' }) === null) {
    results.push({ op: 'add mgr→mgr', violations: [['S1 self-home', 'a column pointing at itself was accepted']] });
  }
  if (!line) {
    for (const dir of ['fd', 'df'] as const) for (const card of CARDS) {
      const p = selfRel({ dir, card });
      run(`add ${dir} ${SHORT[card]}`, { kind: 'add', drawn: p }, p.fromColumn, card);
    }
  } else {
    const ends = { fromModel: 'emp', fromColumn: line.fromColumn, toModel: 'emp', toColumn: line.toColumn };
    for (const card of [SWAP[line.cardinality], ...CARDS]) run(`set ${SHORT[card]}`, { kind: 'update', ends, cardinality: card }, line.fromColumn, card);
    const turned = { fromModel: 'emp', fromColumn: line.toColumn, toModel: 'emp', toColumn: line.fromColumn };
    run('edit: turn ends round', { kind: 'edit', original: ends, drawn: { ...turned, cardinality: line.cardinality } }, turned.fromColumn, line.cardinality);
    const out = gWrite(w, { kind: 'remove', keys: [ends] });
    results.push({ op: 'delete', violations: !out.error && gDraw(out.world, 'D1').some((r) => linkKey(r) === SELF_KEY) ? [['I7 delete-total', 'D1 still draws it']] : [] });
  }
  const plan = gMovePlan(w);
  for (const picks of gPickSets(plan)) {
    const a = gMoveApply(w, plan, picks);
    results.push({ op: 'move', violations: [...moveInvariants(w, plan, picks, a), ...drawingInvariants(a, ['D1', 'D2'])] });
  }
  return results;
}

// ---------------------------------------------------------------------------
// GROUP: a composite foreign key
// ---------------------------------------------------------------------------

export const L = linkKey({ fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k' });
export const LX = linkKey({ fromModel: 'fct', fromColumn: 'k_x', toModel: 'dim', toColumn: 'k_x' });
const KEY = 'fk_dim';

/** One stored copy of G: the group, a partial (L alone with the key) or both members as singles. */
export interface GroupCopy { where: 'fct' | 'dim' | 'D1' | 'D2'; dir: 'fd' | 'df'; card: Cardinality; form: 'group' | 'partial' | 'singles'; role?: string }

const member = (c: GroupCopy, column: 'k' | 'k_x'): Relationship => {
  const base = c.dir === 'fd'
    ? { fromModel: 'fct', fromColumn: column, toModel: 'dim', toColumn: column }
    : { fromModel: 'dim', fromColumn: column, toModel: 'fct', toColumn: column };
  return { ...base, cardinality: c.card, ...(c.role ? { role: c.role } : {}), ...(c.form === 'singles' ? {} : { compositeKey: KEY }) };
};

export function groupWorld(copies: GroupCopy[]): GWorld {
  const w: GWorld = {
    columns: { dim: [col('k', true), col('k_x', true)], fct: [col('id', true), col('k'), col('k_x'), col('k2')] },
    lib: { dim: [], fct: [] },
    dom: { D1: [], D2: [], D3: [] },
    domModels: { D1: ['dim', 'fct'], D2: ['dim', 'fct'], D3: ['dim'] },
  };
  for (const c of copies) {
    const rels = c.form === 'partial' ? [member(c, 'k')] : [member(c, 'k'), member(c, 'k_x')];
    for (const rel of rels) {
      if (c.where === 'fct' || c.where === 'dim') {
        const { fromModel: _f, ...entry } = rel;
        w.lib[c.where].push(entry);
      } else {
        w.dom[c.where].push(rel);
      }
    }
  }
  return w;
}

export function* groupStates(): Generator<GroupCopy[]> {
  const alphabet: GroupCopy[] = [];
  const forms = ['group', 'partial', 'singles'] as const;
  for (const form of forms) {
    for (const card of CARDS) {
      alphabet.push({ where: 'fct', dir: 'fd', card, form }, { where: 'dim', dir: 'df', card, form });
    }
    for (const card of ['many-to-one', 'one-to-one'] as const) {
      for (const where of ['D1', 'D2'] as const) for (const dir of ['fd', 'df'] as const) alphabet.push({ where, dir, card, form });
    }
  }
  for (const card of CARDS) alphabet.push({ where: 'fct', dir: 'fd', card, form: 'group', role: 'r1' });
  const code = (cs: GroupCopy[]) => cs.map((c) => `${c.where}${c.dir}${c.card}${c.form}${c.role ?? ''}`).sort().join(' ');
  const swap = (c: GroupCopy): GroupCopy => ({ ...c, where: c.where === 'D1' ? 'D2' : c.where === 'D2' ? 'D1' : c.where });
  for (let size = 0; size <= 2; size++) {
    for (const copies of multisets(alphabet, size)) if (code(copies) <= code(copies.map(swap))) yield copies;
  }
}

/** The valid composite of L and Lx among `rels` (one file's entries, or what a diagram draws), if any. */
const groupIn = (rels: readonly Relationship[]): Relationship[] | undefined => {
  const g = rels.find((r) => linkKey(r) === L && r.compositeKey) ? groupOf(rels, rels.find((r) => linkKey(r) === L && r.compositeKey)!) : undefined;
  return g && g.length === 2 && g.some((r) => linkKey(r) === LX) ? g : undefined;
};

const files = (w: GWorld): Array<[string, Relationship[]]> => [
  ...Object.keys(w.lib).map((m): [string, Relationship[]] => [`${m}.yml`, w.lib[m].map((e) => ({ fromModel: m, ...e }))]),
  ...DS.map((d): [string, Relationship[]] => [d, w.dom[d]]),
];

/** G1: a drawn composite is exactly one edge covering both pairs; otherwise no edge carries pairs. */
function oneEdge(w: GWorld): Violation[] {
  const v: Violation[] = [];
  for (const d of ['D1', 'D2'] as const) {
    const drawn = gDraw(w, d);
    const display: DisplayDomain = toDisplayDomain(
      { schemaVersion: 5, domain: d, layer: 'silver', stage: 'logical', description: '', models: gModels(w, w.domModels[d]), relationships: drawn },
      { viewConfig: {}, layerConfig: undefined, readOnly: false },
    );
    const edges = transformDomain(display).edges.filter((e) => e.type === 'fk') as FkFlowEdge[];
    const keysOf = (e: FkFlowEdge) => (e.data!.pairs ?? [{ fromColumn: e.data!.fromColumn, toColumn: e.data!.toColumn }])
      .map((p) => linkKey({ fromModel: e.data!.fromModel, fromColumn: p.fromColumn, toModel: e.data!.toModel, toColumn: p.toColumn }));
    const touching = edges.filter((e) => keysOf(e).some((k) => k === L || k === LX));
    if (groupIn(drawn)) {
      if (touching.length !== 1 || keysOf(touching[0]).sort().join() !== [L, LX].sort().join()) {
        v.push(['G1 group-one-edge', `${d}: ${touching.length} edges for the composite`]);
      }
    } else if (touching.some((e) => e.data!.pairs)) {
      v.push(['G1 group-one-edge', `${d}: an edge carries pairs with no valid composite drawn`]);
    }
  }
  return v;
}

/**
 * G2: an op leaves no half of a composite behind — in every file it wrote,
 * each grouped entry of L or Lx it wrote has its partner (same key,
 * cardinality and role). A partial the file already held is the user's.
 */
function groupAtomic(before: GWorld, after: GWorld): Violation[] {
  const v: Violation[] = [];
  const b = new Map(files(before));
  for (const [file, rels] of files(after)) {
    const was = b.get(file) ?? [];
    if (JSON.stringify(rels) === JSON.stringify(was)) continue;
    const grouped = rels.filter((r) => (linkKey(r) === L || linkKey(r) === LX) && r.compositeKey);
    const sig = (r: Relationship) => `${r.compositeKey!.toLowerCase()}|${canonicalRelationship(r).cardinality}|${r.role ?? ''}`;
    const fresh = grouped.filter((r) => !was.some((x) => JSON.stringify(x) === JSON.stringify(r)));
    for (const r of fresh) {
      const partner = linkKey(r) === L ? LX : L;
      if (!grouped.some((x) => linkKey(x) === partner && sig(x) === sig(r))) v.push(['G2 group-atomic', `${file}: ${r.fromColumn}:${sig(r)} written without its partner`]);
    }
  }
  return v;
}

/** G3: every valid library composite sits in its canonical from-model's file. */
function groupHome(w: GWorld): string[] {
  const out: string[] = [];
  const library = files(w).filter(([f]) => f.endsWith('.yml')).flatMap(([, rels]) => rels);
  const g = groupIn(library);
  if (g && g.some((m) => canonicalRelationship(m).fromModel !== m.fromModel)) out.push('a composite is stored away from its many side');
  return out;
}

const libraryAndD1 = (w: GWorld): Relationship[] => files(w).filter(([f]) => f.endsWith('.yml') || f === 'D1').flatMap(([, r]) => r);

/** 1.6.7's save of fct.yml: only the four fields of the entries it can read survive (see mixed167.compositeKey.test.ts). */
const save167 = (rels: ModelRelationship[]): ModelRelationship[] =>
  rels.map(({ fromColumn, toModel, toColumn, cardinality }) => ({ fromColumn, toModel, toColumn, cardinality }));

/** Every check of one GROUP state: reads, each canvas edit from D1, 1.6.7's writes, and the Move. */
export function checkGroupState(copies: GroupCopy[]): Array<{ op: string; violations: Violation[] }> {
  const w = groupWorld(copies);
  const results: Array<{ op: string; violations: Violation[] }> = [{ op: 'read', violations: [...drawingInvariants(w, ['D1', 'D2']), ...oneEdge(w)] }];
  const drawn = gDraw(w, 'D1');
  const line = drawn.find((r) => linkKey(r) === L);
  const grouped = !!groupIn(drawn);
  const hadHome = groupHome(w).length > 0;
  const after = (name: string, out: GOutcome, extra: (a: GWorld) => Violation[] = () => []): void => {
    if (out.error) {
      results.push({ op: name, violations: JSON.stringify(out.world) === JSON.stringify(w) ? [] : [['refusal-changed-world', out.error]] });
      return;
    }
    const a = out.world;
    results.push({
      op: name,
      violations: [
        ...drawingInvariants(a, ['D1', 'D2']), ...oneEdge(a), ...extra(a),
        ...(hadHome ? [] : groupHome(a).map((m): Violation => ['G3 group-home', m])),
      ],
    });
  };
  // The other pair, read either way round (both ends are named k_x).
  const pairX = { fromColumn: 'k_x', toColumn: 'k_x' };

  if (line) {
    const ends = { fromModel: line.fromModel, fromColumn: line.fromColumn, toModel: line.toModel, toColumn: line.toColumn };
    for (const card of [SWAP[line.cardinality], 'many-to-one', 'one-to-one', 'many-to-many'] as Cardinality[]) {
      after(`set ${SHORT[card]}`, gWrite(w, { kind: 'update', ends, cardinality: card }), (a) => (grouped ? groupAtomic(w, a) : []));
    }
    const extra = grouped ? [pairX] : undefined;
    after('edit role → r1', gWrite(w, { kind: 'edit', original: ends, drawn: { ...ends, cardinality: line.cardinality, role: 'r1' }, ...(extra ? { extraPairs: extra } : {}) }), (a) => (grouped ? groupAtomic(w, a) : []));
    after('delete', gWrite(w, { kind: 'remove', keys: [ends] }), (a) => {
      const left = libraryAndD1(a).filter((r) => linkKey(r) === L || (grouped && linkKey(r) === LX));
      return left.length > 0 ? [['I7 delete-total', `${left.length} copies left`]] : [];
    });
    if (grouped) {
      after('edit: drop pair k_x', gWrite(w, { kind: 'edit', original: ends, drawn: { ...ends, cardinality: line.cardinality } }), (a) =>
        (libraryAndD1(a).some((r) => linkKey(r) === L && r.compositeKey) ? [['G2 group-atomic', 'L kept its key after the group became a single link']] : []));
    } else {
      // G5: the pairs a 1.6.7 save split are grouped again by adding the other pair.
      const stripped = !libraryAndD1(w).some((r) => r.compositeKey);
      after('edit: add pair k_x', gWrite(w, { kind: 'edit', original: ends, drawn: { ...ends, cardinality: line.cardinality }, extraPairs: [pairX] }), (a) => {
        const v: Violation[] = groupAtomic(w, a);
        const lib = libraryAndD1(a);
        if (stripped && (!groupIn(lib) || lib.some((r) => (linkKey(r) === L || linkKey(r) === LX) && !r.compositeKey))) {
          v.push(['G5 regroup', `left ${lib.filter((r) => linkKey(r) === L || linkKey(r) === LX).map((r) => `${r.fromColumn}:${r.compositeKey ?? '-'}`).join(', ')}`]);
        }
        return v;
      });
    }
  } else {
    const fromFct = { fromModel: 'fct', fromColumn: 'k', toModel: 'dim', toColumn: 'k', cardinality: 'many-to-one' as const };
    const fromDim = { fromModel: 'dim', fromColumn: 'k', toModel: 'fct', toColumn: 'k', cardinality: 'one-to-many' as const };
    for (const [name, drawnRel] of [['add composite from fct', fromFct], ['add composite from dim', fromDim]] as const) {
      after(name, gWrite(w, { kind: 'add', drawn: drawnRel, extraPairs: [{ fromColumn: 'k_x', toColumn: 'k_x' }] }), (a) => {
        const v = groupAtomic(w, a);
        const g = groupIn(gDraw(a, 'D1'));
        if (!g) v.push(['G2 group-atomic', 'the composite added is not drawn as one']);
        return v;
      });
    }
  }

  // G6: removing a member column (fct.k_x, from D1) removes the whole composite from the library and D1.
  // What the canvas draws as one composite (a file holding a valid and an invalid group of one name draws singles).
  const libGroup = groupIn(gDraw(w, 'D1'));
  {
    // As handleRemoveColumn: the composite is read from the whole library, before the edit.
    const library = gModels(w);
    const models = gModels(w);
    const fct = models.find((m) => m.name === 'fct')!;
    removeColumnRelationships([fct], 'fct', 'k_x', library);
    removeColumnRelationships(models.filter((m) => m !== fct), 'fct', 'k_x', library);
    const a = withModels(w, models);
    a.dom.D1 = removeColumnFromDomainRelationships(a.dom.D1, 'fct', 'k_x', library);
    const v: Violation[] = [];
    if (libGroup && libraryAndD1(a).some((r) => linkKey(r) === L || linkKey(r) === LX)) v.push(['G6 column-removal-removes-group', 'a member survived']);
    results.push({ op: 'remove column fct.k_x', violations: v });
  }

  // G4: a teammate on 1.6.7 — a save keeps every pair; a delete of Lx loses exactly Lx.
  const keys = (x: GWorld) => gStored(x).filter((c) => c.file === 'fct.yml').map((c) => linkKey(c.rel)).sort().join();
  {
    const a = clone(w);
    a.lib.fct = save167(a.lib.fct);
    results.push({ op: '1.6.7 save of fct.yml', violations: keys(a) === keys(w) ? drawingInvariants(a, ['D1', 'D2']) : [['G4 1.6.7-no-pair-loss', `${keys(w)} became ${keys(a)}`]] });
    const del = clone(w);
    del.lib.fct = save167(del.lib.fct.filter((e) => !(e.fromColumn === 'k_x' && e.toModel === 'dim' && e.toColumn === 'k_x')));
    const want = gStored(w).filter((c) => c.file === 'fct.yml').map((c) => linkKey(c.rel)).filter((k) => k !== LX).sort().join();
    results.push({ op: '1.6.7 delete of Lx', violations: keys(del) === want ? [] : [['G4 1.6.7-no-pair-loss', `${keys(w)} became ${keys(del)}`]] });
  }

  const plan = gMovePlan(w);
  for (const picks of gPickSets(plan)) {
    const a = gMoveApply(w, plan, picks);
    results.push({
      op: `move${picks.length ? ` [${picks.map((p) => (p ? SHORT[p.cardinality] : 'leave')).join(',')}]` : ''}`,
      violations: [...moveInvariants(w, plan, picks, a), ...drawingInvariants(a, ['D1', 'D2']), ...oneEdge(a), ...groupAtomic(w, a),
        ...(hadHome ? [] : groupHome(a).map((m): Violation => ['G3 group-home', m]))],
    });
  }
  return results;
}

export const describeGroup = (copies: GroupCopy[]): string =>
  copies.length === 0 ? '(no copy of G)' : copies.map((c) => `${c.where}:${c.dir}:${SHORT[c.card]}:${c.form}${c.role ? `:${c.role}` : ''}`).join('; ');
export const describeSelf = (profile: SelfProfile, copies: SelfCopy[]): string =>
  `[${profile}] ${copies.length === 0 ? '(no copy)' : copies.map((c) => `${c.where}:${c.dir}:${SHORT[c.card]}`).join('; ')}`;
